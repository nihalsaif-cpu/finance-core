/**
 * Accounts: the places money actually sits.
 *
 * The schema has carried accounts since the first migration — `last4`, statement and
 * due days, credit limits, and a `classifyKind` that already behaves differently for a
 * card. None of it was ever reachable, because nothing created an account. This module
 * is the domain half of making them real: validation that mirrors the database's own
 * constraints, the card's billing dates, and matching an imported row to an account.
 *
 * Pure: no React, no Supabase. See CLAUDE.md on why `src/core` stays that way.
 */

import { daysInMonth, parseISO, toISO, type ISODate } from './date';
import { abs, sum, ZERO, type Minor } from './money';
import type { Account, AccountType, AnalyzableTransaction } from './types';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'bank',
  'credit_card',
  'cash',
  'wallet',
  'investment',
] as const;

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  bank: 'Bank account',
  credit_card: 'Credit card',
  cash: 'Cash',
  wallet: 'Wallet / UPI',
  investment: 'Investment',
};

/** Only a credit card has a statement, a due date or a limit. Mirrors the DB check. */
export function hasCardFields(type: AccountType): boolean {
  return type === 'credit_card';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface AccountDraft {
  name: string;
  type: AccountType;
  last4: string;
  institution: string;
  statementDay: string;
  dueDay: string;
  creditLimit: Minor | null;
}

export type AccountField = 'name' | 'last4' | 'statementDay' | 'dueDay' | 'creditLimit';

export type AccountErrors = Partial<Record<AccountField, string>>;

/**
 * Validate a draft against the same rules the database enforces.
 *
 * Every rule here has a `check` constraint behind it. Duplicating them is deliberate:
 * without this the user's mistake comes back as a raw Postgres constraint name, which
 * tells them nothing about which field to fix.
 */
export function validateAccount(draft: AccountDraft): AccountErrors {
  const errors: AccountErrors = {};

  // accounts_name_not_blank
  if (draft.name.trim() === '') errors.name = 'Give this account a name';

  // accounts_last4_digits — optional, but exactly four digits when given.
  const last4 = draft.last4.trim();
  if (last4 !== '' && !/^[0-9]{4}$/.test(last4)) {
    errors.last4 = 'Last 4 digits, or leave blank';
  }

  if (hasCardFields(draft.type)) {
    // accounts_statement_day / accounts_due_day
    const statement = parseDay(draft.statementDay);
    if (statement === 'invalid') errors.statementDay = 'A day from 1 to 31';
    const due = parseDay(draft.dueDay);
    if (due === 'invalid') errors.dueDay = 'A day from 1 to 31';

    // accounts_credit_limit
    if (draft.creditLimit !== null && draft.creditLimit < 0) {
      errors.creditLimit = 'A limit cannot be negative';
    }
  }

  return errors;
}

/** '' → null, a valid 1–31 → the number, anything else → 'invalid'. */
export function parseDay(value: string): number | null | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^[0-9]{1,2}$/.test(trimmed)) return 'invalid';
  const day = Number(trimmed);
  return day >= 1 && day <= 31 ? day : 'invalid';
}

export const hasErrors = (errors: AccountErrors): boolean => Object.keys(errors).length > 0;

// ---------------------------------------------------------------------------
// Card billing dates
// ---------------------------------------------------------------------------

/**
 * The day a card's billing day falls on in a given month.
 *
 * A card billed on the 31st still bills in February. Clamping to the month's last day
 * is what every issuer does, and is the same rule `recurring.ts` applies to a monthly
 * schedule — a "day of month" that does not exist means the last day, never a rollover
 * into the next month.
 */
export function billingDayIn(year: number, month: number, day: number): ISODate {
  const clamped = Math.min(day, daysInMonth(year, month));
  return toISO({ year, month, day: clamped });
}

/** The next occurrence of a billing day, on or after `from`. */
export function nextBillingDate(from: ISODate, day: number): ISODate {
  const { year, month } = parseISO(from);
  const thisMonth = billingDayIn(year, month, day);
  // On the day itself the bill is today's business, not next month's.
  if (thisMonth >= from) return thisMonth;
  return month === 12 ? billingDayIn(year + 1, 1, day) : billingDayIn(year, month + 1, day);
}

export interface CardCycle {
  /** When the current statement closes. */
  statementDate: ISODate | null;
  /** When payment is due. */
  dueDate: ISODate | null;
  /** Days until the due date. Negative would mean overdue, but the date is always ahead. */
  daysToDue: number | null;
}

/**
 * Where a card is in its billing cycle.
 *
 * Both dates are the next occurrence from today, computed independently — and this is
 * deliberate, because a card almost always has two bills alive at once. On the 3rd of a
 * month, a card that statements on the 20th and is due on the 5th has last month's
 * statement due in two days AND this month's still accruing. Pairing the due date to
 * the statement date would push `dueDate` out to the 5th of next month and hide the
 * payment that is actually imminent.
 *
 * So: `dueDate` is the next money that has to leave, `statementDate` is when the
 * current bill stops growing. They are not two ends of one cycle and must not be
 * displayed as though they were.
 */
export function cardCycle(
  today: ISODate,
  statementDay: number | null,
  dueDay: number | null,
): CardCycle {
  const statementDate = statementDay === null ? null : nextBillingDate(today, statementDay);
  if (dueDay === null) return { statementDate, dueDate: null, daysToDue: null };

  const dueDate = nextBillingDate(today, dueDay);
  return {
    statementDate,
    dueDate,
    daysToDue: daysBetweenISO(today, dueDate),
  };
}

function daysBetweenISO(from: ISODate, to: ISODate): number {
  const a = parseISO(from);
  const b = parseISO(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

// ---------------------------------------------------------------------------
// Matching an imported row to an account
// ---------------------------------------------------------------------------

/**
 * Find the account a piece of statement text belongs to, by its last four digits.
 *
 * Statements write the number a dozen ways — "XXXX1234", "****1234", "A/c ...1234",
 * "ending 1234". Rather than pattern-match each shape, this looks for the account's own
 * four digits appearing as a run of digits that is not part of a longer number: "1234"
 * matches in "XX1234" but must not match inside "912345".
 *
 * Returns null when no account matches, and null when MORE than one does — two cards
 * ending 1234 is rare but filing a transaction against a coin-flip is worse than
 * leaving it unassigned.
 */
export function matchAccountByLast4(
  accounts: readonly Account[],
  text: string,
): Account | null {
  const candidates = accounts.filter((account) => {
    if (!account.isActive || !account.last4) return false;
    return containsLast4(text, account.last4);
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function containsLast4(text: string, last4: string): boolean {
  // A digit run that ends with last4 and has no digit after it. Masking characters
  // (X, *, ., space) before it are fine; another digit after it is not.
  const pattern = new RegExp(`(?<![0-9])[0-9]{0,3}${last4}(?![0-9])`);
  return pattern.test(text);
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface AccountSummary {
  account: Account;
  /** How much left this account over the window. Always positive. */
  spent: Minor;
  transactionCount: number;
  /** Credit cards only. 0–1, or null when no limit is set. */
  utilisation: number | null;
  cycle: CardCycle | null;
}

/**
 * What each account has been doing.
 *
 * `spent` counts money that left the account, which for a credit card is the charges on
 * it — not the payment made to clear it. That payment is a transfer between two of the
 * user's own accounts and is already excluded by kind, so counting it here would show
 * the same rupee twice.
 */
export function summariseAccounts(
  accounts: readonly Account[],
  transactions: readonly AnalyzableTransaction[],
  today: ISODate,
): AccountSummary[] {
  const byAccount = new Map<string, AnalyzableTransaction[]>();
  for (const txn of transactions) {
    if (!txn.accountId) continue;
    const list = byAccount.get(txn.accountId);
    if (list) list.push(txn);
    else byAccount.set(txn.accountId, [txn]);
  }

  return accounts.map((account) => {
    const own = byAccount.get(account.id) ?? [];
    const spending = own.filter((txn) => txn.kind === 'expense');
    const spent = sum(spending.map((txn) => abs(txn.amount)));

    const isCard = account.type === 'credit_card';
    const limit = account.creditLimit;

    return {
      account,
      spent,
      transactionCount: own.length,
      utilisation: isCard && limit !== null && limit > 0 ? (spent as number) / (limit as number) : null,
      cycle: isCard ? cardCycle(today, account.statementDay, account.dueDay) : null,
    };
  });
}

/** Sort for display: active first, then cards and banks ahead of cash, then by name. */
const TYPE_ORDER: Record<AccountType, number> = {
  bank: 0,
  credit_card: 1,
  wallet: 2,
  cash: 3,
  investment: 4,
};

export function sortAccounts(accounts: readonly Account[]): Account[] {
  return [...accounts].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.type !== b.type) return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return a.name.localeCompare(b.name);
  });
}

/** Total sitting on cards. Useful as one headline number above the list. */
export function totalCardSpend(summaries: readonly AccountSummary[]): Minor {
  const cards = summaries.filter((s) => s.account.type === 'credit_card');
  return cards.length === 0 ? ZERO : sum(cards.map((s) => s.spent));
}
