/**
 * Credit-card settlement handling.
 *
 * The double-counting risk is concrete: you import a credit-card statement (₹25,000
 * of purchases) and a bank statement (a ₹25,000 payment to the card). Naively summing
 * debits reports ₹50,000 of spending for a month in which ₹25,000 was spent.
 *
 * `ledger.ts` already makes this structurally impossible by giving `cc_payment` no
 * spend effect. This module is the layer above it: recognising, at import time, which
 * bank debits ARE card settlements so they get classified as `cc_payment` rather than
 * as ordinary expenses.
 */

import { type ISODate, daysBetween } from './date';
import { type Minor, abs, sub } from './money';
import type { Account, AnalyzableTransaction, PaymentMethod, TransactionKind, UUID } from './types';

/** Description fragments that indicate a payment to a credit card. */
const SETTLEMENT_PATTERNS: RegExp[] = [
  /\bcredit\s*card\s*(?:bill\s*)?(?:pay(?:ment)?|pmt)\b/i,
  /\bcc\s*(?:bill\s*)?pay(?:ment)?\b/i,
  /\bcard\s*payment\b/i,
  /\bpayment\s*(?:to|towards)\s*(?:your\s*)?card\b/i,
  /\bbill\s*desk.*card\b/i,
  /\bautopay.*card\b/i,
  /\bneft.*credit\s*card\b/i,
  /\b(?:hdfc|icici|axis|sbi|kotak|amex|citi|hsbc|idfc|rbl|yes)\s*card\s*pay/i,
  /\bpayment\s*received[,\s-]*thank\s*you\b/i, // as it appears ON the card statement
  /\bthank\s*you\s*for\s*(?:your\s*)?payment\b/i,
  /\bautopay\s*(?:dr|debit)?\s*cc\b/i,
  /*
   * Issuer named between the verb and the word "card".
   *
   * The patterns above all require "card" to follow the payment verb immediately, so
   * the single most common Indian narration — "PAYMENT TO HDFC CREDIT CARD" — fell
   * through and was classified as an ordinary expense. That is the double-count this
   * whole module exists to prevent: the settlement counted as spending once, and the
   * charges it settles counted again as `cc_charge`.
   *
   * The gap is bounded (no more than ~30 characters, and never across a comma) so a
   * long narration cannot join an unrelated payment to a distant mention of a card.
   */
  /\bpay(?:ment|mt)?\s*(?:to|towards)\b[^,]{0,30}?\b(?:credit\s*card|cc)\b/i,
  /\b(?:neft|imps|rtgs|upi|ach|ecs)\b[^,]{0,30}?\b(?:credit\s*card)\b/i,
  /\b(?:pay(?:ment)?|neft|imps|rtgs|upi)\b[^,]{0,30}?\b(?:hdfc|icici|axis|sbi|kotak|amex|citi|hsbc|idfc|rbl|yes|onecard|slice)\s*(?:credit\s*)?card\b/i,
];

/** Fragments that mean "money moved between my own accounts", not spending. */
const TRANSFER_PATTERNS: RegExp[] = [
  /\bself\s*transfer\b/i,
  /\btransfer\s*to\s*(?:own|self|my)\b/i,
  /\bfund\s*transfer\b.*\bself\b/i,
  /\bimps.*self\b/i,
  /\bsweep\s*(?:in|out)\b/i,
  /\bacct?\s*to\s*acct?\b/i,
];

const WITHDRAWAL_PATTERNS: RegExp[] = [
  /\batm\s*(?:cash\s*)?(?:wdl|withdrawal|withdraw|cw)\b/i,
  /\bcash\s*w(?:it)?hdrawa?l\b/i,
  /\bnfs\s*\/?\s*atm\b/i,
  /\bcash@?atm\b/i,
  /\batw\b/i,
];

const DEPOSIT_PATTERNS: RegExp[] = [/\bcash\s*dep(?:osit)?\b/i, /\bcdm\b/i, /\bcash\s*credit\b/i];

const INVESTMENT_PATTERNS: RegExp[] = [
  /\b(?:sip|systematic\s*investment)\b/i,
  /\bmutual\s*fund\b/i,
  /\bzerodha|groww|upstox|kuvera|coin\b/i,
  /\bnps\b/i,
  /\bppf\b/i,
  /\brecurring\s*dep(?:osit)?\b/i,
  /\bfixed\s*dep(?:osit)?\b/i,
];

const REFUND_PATTERNS: RegExp[] = [
  /\brefund\b/i,
  /\breversal\b/i,
  /\breversed\b/i,
  /\bchargeback\b/i,
  /\bcashback\b/i,
  /\bmoney\s*returned\b/i,
];

const SALARY_PATTERNS: RegExp[] = [
  /\bsalary\b/i,
  /\bsal\s*cr\b/i,
  /\bneft.*salary\b/i,
  /\bpayroll\b/i,
  /\bmonthly\s*sal\b/i,
];

/**
 * Credits that are NOT income.
 *
 * The single most damaging default in the app was treating every unexplained credit as
 * income. A month with three self-transfers and a refund reported an income that never
 * existed, which inflated the savings rate, the "left to spend" figure and every
 * projection built on them. Money arriving in an account is not the same as money
 * earned.
 */
const INTEREST_PATTERNS: RegExp[] = [
  /\bint(?:erest)?\s*(?:cr|credit|pd|paid)\b/i,
  /\bsaving?s?\s*int(?:erest)?\b/i,
  /\bint\.?\s*coll?\b/i,
  /\bfd\s*int(?:erest)?\b/i,
  /\bquarterly\s*interest\b/i,
];

const DIVIDEND_PATTERNS: RegExp[] = [
  /\bdividend\b/i,
  /\bdiv\s*(?:cr|credit|warrant)\b/i,
  /\binterim\s*div/i,
];

const CASHBACK_PATTERNS: RegExp[] = [
  /\bcash\s*back\b/i,
  /\bcashback\b/i,
  /\breward\s*(?:credit|points?\s*redeem)/i,
];

/**
 * Credits that are a person's own money moving, not new money.
 *
 * UPI and IMPS credits to yourself are extremely common in Indian statements and read
 * nothing like the "SELF TRANSFER" wording the existing patterns look for.
 */
const OWN_MONEY_PATTERNS: RegExp[] = [
  /\bown\s*a\/?c\b/i,
  /\bsweep\s*(?:in|out|trf)\b/i,
  /\bauto\s*sweep\b/i,
  /\bmat(?:urity)?\s*(?:proceeds|amt)\b/i,
  /\bfd\s*(?:closure|redemption|matur)/i,
  /\brd\s*(?:closure|matur)/i,
  /\bclosure\s*proceeds\b/i,
];

/** A credit that reverses a charge the bank itself made. */
const BANK_REVERSAL_PATTERNS: RegExp[] = [
  /\bcharges?\s*(?:reversal|refund|waiver)\b/i,
  /\bgst\s*reversal\b/i,
  /\bamb\s*charges?\s*rev/i,
];

export function looksLikeInterest(description: string): boolean {
  return INTEREST_PATTERNS.some((re) => re.test(description));
}

export function looksLikeDividend(description: string): boolean {
  return DIVIDEND_PATTERNS.some((re) => re.test(description));
}

export function looksLikeCashback(description: string): boolean {
  return CASHBACK_PATTERNS.some((re) => re.test(description));
}

export function looksLikeOwnMoney(description: string): boolean {
  return OWN_MONEY_PATTERNS.some((re) => re.test(description));
}

export function looksLikeCardSettlement(description: string): boolean {
  return SETTLEMENT_PATTERNS.some((re) => re.test(description));
}

export function looksLikeSelfTransfer(description: string): boolean {
  return TRANSFER_PATTERNS.some((re) => re.test(description));
}

export function looksLikeCashWithdrawal(description: string): boolean {
  return WITHDRAWAL_PATTERNS.some((re) => re.test(description));
}

export function looksLikeRefund(description: string): boolean {
  return REFUND_PATTERNS.some((re) => re.test(description));
}

export function looksLikeSalary(description: string): boolean {
  return SALARY_PATTERNS.some((re) => re.test(description));
}

export interface ClassifyInput {
  description: string;
  /** Positive for money in, negative for money out. */
  signedAmount: Minor;
  /** The account the row came from, when known. */
  account?: Pick<Account, 'id' | 'type'> | null;
  paymentMethod?: PaymentMethod | null;
}

/**
 * What sort of income a credit is, when it is income at all.
 *
 * Drives the suggested CATEGORY — salary, interest and dividends, and so on — so a
 * year's breakdown can separate earnings from interest instead of lumping every
 * credit under one heading. `unknown` means "we could not tell", not "other".
 */
export type IncomeType = 'salary' | 'interest' | 'other' | 'unknown';

export interface ClassifyResult {
  kind: TransactionKind;
  /** 0–1. Low values mean the row should be flagged for review. */
  confidence: number;
  /** Human-readable justification, surfaced in the import review screen. */
  reason: string;
  /** Set only when `kind` is `income`. */
  incomeType?: IncomeType;
}

/**
 * Infer a transaction kind from a raw statement row.
 *
 * Deliberately conservative: anything it is unsure about becomes a plain
 * expense/income with a low confidence score, which routes the row to human review
 * rather than silently mis-classifying money.
 */
export function classifyKind(input: ClassifyInput): ClassifyResult {
  const { description, signedAmount } = input;
  const isCredit = signedAmount > 0;
  const isCardAccount = input.account?.type === 'credit_card';

  if (looksLikeCardSettlement(description)) {
    // On a card statement a settlement is a credit; from the bank side it is a debit.
    // Both describe the same event, and neither is new spending.
    return {
      kind: 'cc_payment',
      confidence: 0.95,
      reason: 'Looks like a credit card bill payment, so it is not counted as new spending',
    };
  }

  if (isCardAccount && isCredit && looksLikeRefund(description)) {
    return { kind: 'refund', confidence: 0.9, reason: 'Refund credited to your card' };
  }

  if (looksLikeRefund(description) && isCredit) {
    return { kind: 'refund', confidence: 0.85, reason: 'Looks like a refund or reversal' };
  }

  if (looksLikeSelfTransfer(description)) {
    return {
      kind: 'transfer',
      confidence: 0.8,
      reason: 'Looks like a transfer between your own accounts',
    };
  }

  if (looksLikeCashWithdrawal(description) && !isCredit) {
    return { kind: 'cash_withdrawal', confidence: 0.9, reason: 'ATM cash withdrawal' };
  }

  if (DEPOSIT_PATTERNS.some((re) => re.test(description)) && isCredit) {
    return { kind: 'cash_deposit', confidence: 0.8, reason: 'Cash deposited into your account' };
  }

  if (INVESTMENT_PATTERNS.some((re) => re.test(description)) && !isCredit) {
    return {
      kind: 'investment',
      confidence: 0.75,
      reason: 'Looks like an investment, counted as savings rather than spending',
    };
  }

  if (isCredit && looksLikeSalary(description)) {
    return {
      kind: 'income',
      confidence: 0.9,
      reason: 'Looks like a salary credit',
      incomeType: 'salary',
    };
  }

  if (isCredit && looksLikeInterest(description)) {
    return {
      kind: 'income',
      confidence: 0.85,
      reason: 'Bank interest credited',
      incomeType: 'interest',
    };
  }

  if (isCredit && looksLikeDividend(description)) {
    return {
      kind: 'income',
      confidence: 0.85,
      reason: 'Dividend credited',
      incomeType: 'interest',
    };
  }

  if (isCredit && looksLikeCashback(description)) {
    // Cashback reduces what a purchase cost rather than adding to earnings.
    return { kind: 'refund', confidence: 0.75, reason: 'Cashback or reward credit' };
  }

  if (isCredit && looksLikeOwnMoney(description)) {
    return {
      kind: 'transfer',
      confidence: 0.75,
      reason: 'Looks like your own money moving between accounts, not new income',
    };
  }

  if (isCredit && BANK_REVERSAL_PATTERNS.some((re) => re.test(description))) {
    return { kind: 'refund', confidence: 0.8, reason: 'Bank charge reversed' };
  }

  /**
   * An unexplained credit is NOT assumed to be income.
   *
   * It still has to be given a kind, and `income` is the only one that keeps the money
   * visible rather than silently discarding it — but the confidence is low enough to
   * force review, and the reason says plainly that this is a guess. Previously this
   * returned 0.5 with "Money credited to your account", which read like a finding
   * rather than a question and sailed through a bulk accept.
   */
  if (isCredit) {
    return {
      kind: 'income',
      confidence: 0.25,
      reason: 'Money came in, but not recognisably income — check whether this is a transfer, refund or actual earnings',
      incomeType: 'unknown',
    };
  }

  if (isCardAccount) {
    return { kind: 'cc_charge', confidence: 0.85, reason: 'Purchase on your credit card' };
  }

  return { kind: 'expense', confidence: 0.7, reason: 'Money debited from your account' };
}

// ---------------------------------------------------------------------------
// Settlement matching
// ---------------------------------------------------------------------------

export interface SettlementMatch {
  /** The bank-side debit. */
  paymentId: UUID;
  /** The card-side "payment received" credit, when both statements were imported. */
  cardSideId: UUID;
  amount: Minor;
  daysApart: number;
  confidence: number;
}

export interface SettlementCandidate {
  id: UUID;
  date: ISODate;
  amount: Minor;
  kind: TransactionKind;
  accountId: UUID | null;
  description: string;
}

/**
 * Pair a bank-side card payment with the matching credit on the card statement.
 *
 * When a user imports both statements, the same settlement appears twice. Both are
 * already spend-neutral, so this does not change totals — it links them so the review
 * screen can show one event instead of two unexplained rows, and so account balances
 * are not double-adjusted.
 *
 * Amounts must match exactly and dates fall within `windowDays` (settlement typically
 * posts to the card 0–3 days after the bank debit).
 */
export function matchSettlements(
  bankSide: readonly SettlementCandidate[],
  cardSide: readonly SettlementCandidate[],
  windowDays = 5,
): SettlementMatch[] {
  const matches: SettlementMatch[] = [];
  const usedCardSide = new Set<UUID>();

  const payments = bankSide
    .filter((t) => t.kind === 'cc_payment')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const payment of payments) {
    let best: { candidate: SettlementCandidate; daysApart: number } | null = null;

    for (const candidate of cardSide) {
      if (usedCardSide.has(candidate.id)) continue;
      if (candidate.id === payment.id) continue;
      if (candidate.accountId === payment.accountId) continue; // must be a different account
      if (abs(sub(candidate.amount, payment.amount)) !== 0) continue;

      const daysApart = Math.abs(daysBetween(payment.date, candidate.date));
      if (daysApart > windowDays) continue;
      if (!best || daysApart < best.daysApart) best = { candidate, daysApart };
    }

    if (best) {
      usedCardSide.add(best.candidate.id);
      matches.push({
        paymentId: payment.id,
        cardSideId: best.candidate.id,
        amount: payment.amount,
        daysApart: best.daysApart,
        confidence: best.daysApart <= 2 ? 0.95 : 0.8,
      });
    }
  }

  return matches;
}

/**
 * Outstanding balance on a credit card: charges since the opening balance, less
 * refunds and settlements. Positive means money owed.
 */
export function cardOutstanding(
  transactions: readonly AnalyzableTransaction[],
  openingBalance: Minor,
): Minor {
  let balance = openingBalance as number;
  for (const t of transactions) {
    if (t.excludeFromAnalytics) continue;
    if (t.status === 'failed' || t.status === 'reversed') continue;
    if (t.kind === 'cc_charge') balance += t.amount;
    else if (t.kind === 'refund') balance -= t.amount;
    else if (t.kind === 'cc_payment') balance -= t.amount;
  }
  return balance as Minor;
}
