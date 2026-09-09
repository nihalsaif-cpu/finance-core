/**
 * Ledger semantics — what each transaction actually does to the user's money.
 *
 * This module is the single place that answers "does this count as spending?".
 * Everything downstream (dashboard, budgets, velocity, insights, reports) reads
 * these functions rather than inspecting `kind` itself, so the rules cannot drift
 * apart between screens.
 *
 * The two rules that matter most:
 *
 *   A credit-card purchase (`cc_charge`) is spending. Paying the card bill
 *   (`cc_payment`) is NOT — it settles a liability the charge already created.
 *   Counting both turns ₹25,000 of spending into ₹50,000.
 *
 *   Moving money between your own accounts (`transfer`) is neither income nor
 *   spending. It changes where money sits, not how much you have.
 */

import { ZERO, type Minor, add, sub, sum } from './money';
import type { AnalyzableTransaction, TransactionKind, TransactionStatus } from './types';

export interface LedgerOptions {
  /**
   * Whether an ATM withdrawal is treated as spending. True suits users who do not
   * record individual cash purchases — otherwise the money would vanish from their
   * spending entirely. False suits users who track a cash account properly, where
   * the withdrawal is just a transfer and the cash purchases are recorded.
   */
  cashWithdrawalCountsAsSpend: boolean;
  /** Include authorised-but-unsettled card transactions in spend totals. */
  includePending: boolean;
}

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  cashWithdrawalCountsAsSpend: true,
  includePending: false,
};

export type ExclusionReason =
  | 'user_excluded'
  | 'not_posted'
  | 'transfer_between_own_accounts'
  | 'credit_card_settlement'
  | 'cash_tracked_separately';

export interface TransactionEffect {
  /** Signed contribution to total spending. Negative for refunds. */
  spend: Minor;
  /** Contribution to income. */
  income: Minor;
  /** Money moved into investments — an outflow, but not consumption. */
  investment: Minor;
  /** True when the transaction contributed to spend or income. */
  counted: boolean;
  /** Why it did not contribute, for the "excluded from totals" UI affordance. */
  reason: ExclusionReason | null;
}

const NEUTRAL: TransactionEffect = {
  spend: ZERO,
  income: ZERO,
  investment: ZERO,
  counted: false,
  reason: null,
};

/** Kinds that represent real consumption. */
export const SPEND_KINDS: readonly TransactionKind[] = ['expense', 'cc_charge'];

/**
 * Kinds that move money without changing net worth. Recorded for account balances
 * and audit trails, structurally excluded from every spending calculation.
 */
export const NEUTRAL_KINDS: readonly TransactionKind[] = [
  'transfer',
  'cc_payment',
  'cash_deposit',
];

export function isSpendKind(kind: TransactionKind): boolean {
  return kind === 'expense' || kind === 'cc_charge';
}

export function isIncomeKind(kind: TransactionKind): boolean {
  return kind === 'income';
}

/** True for kinds that must never appear in a spending total, whatever the settings. */
export function isNeutralKind(kind: TransactionKind): boolean {
  return NEUTRAL_KINDS.includes(kind);
}

export function isCountableStatus(status: TransactionStatus, options: LedgerOptions): boolean {
  if (status === 'posted') return true;
  if (status === 'pending') return options.includePending;
  return false; // failed, reversed
}

/** What one transaction contributes to the user's totals. */
export function effectOf(
  t: Pick<AnalyzableTransaction, 'amount' | 'kind' | 'status' | 'excludeFromAnalytics'>,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): TransactionEffect {
  if (t.excludeFromAnalytics) return { ...NEUTRAL, reason: 'user_excluded' };
  if (!isCountableStatus(t.status, options)) return { ...NEUTRAL, reason: 'not_posted' };

  switch (t.kind) {
    case 'expense':
    case 'cc_charge':
      return { spend: t.amount, income: ZERO, investment: ZERO, counted: true, reason: null };

    case 'refund':
      // A refund reduces spending in the category it came from, rather than
      // inflating income — otherwise a returned ₹2,000 shirt reads as a ₹2,000 raise.
      return { spend: sub(ZERO, t.amount), income: ZERO, investment: ZERO, counted: true, reason: null };

    case 'income':
      return { spend: ZERO, income: t.amount, investment: ZERO, counted: true, reason: null };

    case 'investment':
      return { spend: ZERO, income: ZERO, investment: t.amount, counted: true, reason: null };

    case 'cash_withdrawal':
      return options.cashWithdrawalCountsAsSpend
        ? { spend: t.amount, income: ZERO, investment: ZERO, counted: true, reason: null }
        : { ...NEUTRAL, reason: 'cash_tracked_separately' };

    case 'cc_payment':
      return { ...NEUTRAL, reason: 'credit_card_settlement' };

    case 'transfer':
    case 'cash_deposit':
      return { ...NEUTRAL, reason: 'transfer_between_own_accounts' };
  }
}

/** Signed spend contribution — the value summed into any spending total. */
export function spendOf(
  t: Pick<AnalyzableTransaction, 'amount' | 'kind' | 'status' | 'excludeFromAnalytics'>,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): Minor {
  return effectOf(t, options).spend;
}

export function countsAsSpend(
  t: Pick<AnalyzableTransaction, 'amount' | 'kind' | 'status' | 'excludeFromAnalytics'>,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): boolean {
  return effectOf(t, options).spend !== 0;
}

export interface LedgerTotals {
  /** Gross spending before refunds. */
  grossSpend: Minor;
  refunds: Minor;
  /** grossSpend - refunds. The headline "Total Spent". */
  totalSpend: Minor;
  totalIncome: Minor;
  totalInvested: Minor;
  /** income - spend - invested. */
  netCashFlow: Minor;
  /** Count of transactions that contributed to spend (refunds excluded). */
  spendCount: number;
  transactionCount: number;
}

export const EMPTY_TOTALS: LedgerTotals = {
  grossSpend: ZERO,
  refunds: ZERO,
  totalSpend: ZERO,
  totalIncome: ZERO,
  totalInvested: ZERO,
  netCashFlow: ZERO,
  spendCount: 0,
  transactionCount: 0,
};

export function totalsOf(
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): LedgerTotals {
  let grossSpend = 0;
  let refunds = 0;
  let totalIncome = 0;
  let totalInvested = 0;
  let spendCount = 0;

  for (const t of transactions) {
    const e = effectOf(t, options);
    if (e.spend > 0) {
      grossSpend += e.spend;
      spendCount += 1;
    } else if (e.spend < 0) {
      refunds += -e.spend;
    }
    totalIncome += e.income;
    totalInvested += e.investment;
  }

  const totalSpend = grossSpend - refunds;
  return {
    grossSpend: grossSpend as Minor,
    refunds: refunds as Minor,
    totalSpend: totalSpend as Minor,
    totalIncome: totalIncome as Minor,
    totalInvested: totalInvested as Minor,
    netCashFlow: (totalIncome - totalSpend - totalInvested) as Minor,
    spendCount,
    transactionCount: transactions.length,
  };
}

/** Total spend for a filtered subset — the building block for category/merchant rollups. */
export function spendTotal(
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): Minor {
  return sum(transactions.map((t) => spendOf(t, options)));
}

/** Only the transactions that move a spending total, for drill-down lists. */
export function spendingTransactions(
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): AnalyzableTransaction[] {
  return transactions.filter((t) => spendOf(t, options) !== 0);
}

/**
 * Essential/discretionary split. `isEssential` on the transaction wins; otherwise the
 * category's classification is used, and a 'mixed' or unknown category is treated as
 * discretionary so the discretionary figure is never flatteringly low.
 */
export function isEssential(
  t: Pick<AnalyzableTransaction, 'isEssential' | 'categoryId'>,
  categoryEssential: (categoryId: string | null) => boolean | null,
): boolean {
  if (t.isEssential !== null) return t.isEssential;
  return categoryEssential(t.categoryId) ?? false;
}

export interface EssentialSplit {
  essential: Minor;
  discretionary: Minor;
  total: Minor;
  essentialShare: number | null;
  discretionaryShare: number | null;
}

export function essentialSplit(
  transactions: readonly AnalyzableTransaction[],
  categoryEssential: (categoryId: string | null) => boolean | null,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): EssentialSplit {
  let essential = 0;
  let discretionary = 0;
  for (const t of transactions) {
    const s = spendOf(t, options);
    if (s === 0) continue;
    if (isEssential(t, categoryEssential)) essential += s;
    else discretionary += s;
  }
  const total = essential + discretionary;
  return {
    essential: essential as Minor,
    discretionary: discretionary as Minor,
    total: total as Minor,
    essentialShare: total === 0 ? null : (essential / total) * 100,
    discretionaryShare: total === 0 ? null : (discretionary / total) * 100,
  };
}

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  user_excluded: 'Excluded from analysis',
  not_posted: 'Not settled yet',
  transfer_between_own_accounts: 'Transfer between your accounts',
  credit_card_settlement: 'Credit card bill payment',
  cash_tracked_separately: 'Cash tracked separately',
};

/** Short explanation for why a transaction shows no impact on spending. */
export function exclusionLabel(effect: TransactionEffect): string | null {
  return effect.reason ? EXCLUSION_LABELS[effect.reason] : null;
}

export { add, sub, sum };
