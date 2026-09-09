/**
 * Which commitments have actually been paid this cycle, and what is still to come.
 *
 * The previous rule matched a commitment to a payment on `merchantKey ?? ''`, on both
 * sides. Every hand-added commitment has a null merchant key, so they all shared the
 * key '' — one recurring payment with no merchant marked the whole set as settled, and
 * the forecast reported nothing committed while three real bills were outstanding.
 *
 * Identity now comes from `recurringExpenseId`, the foreign key the schema has always
 * had. A merchant key is only a fallback, and only when it is actually a key.
 *
 * Pure: no React, no Supabase.
 */

import { compare, type ISODate } from './date';
import { sum, ZERO, type Minor } from './money';
import { nextOccurrence } from './recurring';
import type { AnalyzableTransaction, RecurrenceInterval, RecurringExpense, UUID } from './types';

export interface SettlementStatus {
  commitment: RecurringExpense;
  /** The payment that settled it this cycle, if any. */
  paidBy: AnalyzableTransaction | null;
  paidOn: ISODate | null;
  /** When it is next expected. Null when no due date is recorded. */
  dueDate: ISODate | null;
  /** True when it is due within this cycle and has not been paid. */
  outstanding: boolean;
  /** Due date has passed and nothing has settled it. */
  overdue: boolean;
}

export interface SettlementInput {
  commitments: readonly RecurringExpense[];
  /** Transactions in the current cycle. */
  transactions: readonly AnalyzableTransaction[];
  cycleStart: ISODate;
  cycleEnd: ISODate;
  today: ISODate;
}

/**
 * Match each commitment to the payment that settled it, if one exists.
 *
 * A transaction settles a commitment when it carries that commitment's id. Failing
 * that, a recurring transaction with the SAME NON-NULL merchant key counts — which
 * covers rows the importer recognised before this link existed. A null key matches
 * nothing, deliberately: "no merchant" is not an identity two rows can share.
 */
export function settleCommitments(input: SettlementInput): SettlementStatus[] {
  const inCycle = input.transactions.filter(
    (txn) =>
      !txn.excludeFromAnalytics &&
      txn.date >= input.cycleStart &&
      txn.date <= input.cycleEnd &&
      txn.kind === 'expense',
  );

  const byCommitmentId = new Map<UUID, AnalyzableTransaction>();
  const byMerchantKey = new Map<string, AnalyzableTransaction>();

  for (const txn of inCycle) {
    if (txn.recurringExpenseId && !byCommitmentId.has(txn.recurringExpenseId)) {
      byCommitmentId.set(txn.recurringExpenseId, txn);
    }
    // Only a real key. Empty and null are not identities.
    if (txn.isRecurring && txn.merchantKey && !byMerchantKey.has(txn.merchantKey)) {
      byMerchantKey.set(txn.merchantKey, txn);
    }
  }

  return input.commitments
    .filter((commitment) => commitment.isActive)
    .map((commitment) => {
      const paidBy =
        byCommitmentId.get(commitment.id) ??
        (commitment.merchantKey ? byMerchantKey.get(commitment.merchantKey) ?? null : null);

      const dueDate = commitment.nextDueDate;
      const dueThisCycle =
        dueDate === null
          ? // No date recorded. A monthly commitment still falls due every cycle, and
            // pretending otherwise is what made the forecast read zero. Anything longer
            // than monthly genuinely might not land in this cycle, so it is not assumed.
            commitment.interval === 'monthly'
          : dueDate >= input.cycleStart && dueDate <= input.cycleEnd;

      const outstanding = paidBy === null && dueThisCycle;

      return {
        commitment,
        paidBy,
        paidOn: paidBy?.date ?? null,
        dueDate,
        outstanding,
        overdue: outstanding && dueDate !== null && compare(dueDate, input.today) < 0,
      };
    });
}

/** What is still to be paid this cycle. */
export function outstandingTotal(statuses: readonly SettlementStatus[]): Minor {
  const owed = statuses.filter((s) => s.outstanding).map((s) => s.commitment.amount);
  return owed.length === 0 ? ZERO : sum(owed);
}

/**
 * Outstanding money that has no date attached.
 *
 * The scheduler can only place a commitment it can anchor — one with neither a last
 * payment nor a due date produces no occurrences at all, which is why three real bills
 * showed as "Nothing scheduled before payday" and ₹0 committed. The money is real even
 * when the date is unknown, so it is reported separately rather than invented onto a
 * day or dropped.
 */
export function undatedOutstandingTotal(statuses: readonly SettlementStatus[]): Minor {
  const undated = statuses
    .filter((s) => s.outstanding && s.dueDate === null)
    .map((s) => s.commitment.amount);
  return undated.length === 0 ? ZERO : sum(undated);
}

/** Commitments still owed that nobody has dated. */
export function undatedOutstanding(
  statuses: readonly SettlementStatus[],
): SettlementStatus[] {
  return statuses.filter((s) => s.outstanding && s.dueDate === null);
}

/** What has already gone out against tracked commitments this cycle. */
export function settledTotal(statuses: readonly SettlementStatus[]): Minor {
  const paid = statuses.filter((s) => s.paidBy !== null).map((s) => s.commitment.amount);
  return paid.length === 0 ? ZERO : sum(paid);
}

/**
 * The due date to record after a commitment is paid.
 *
 * Advances from the due date when one is known, so a bill paid three days late still
 * lands on its usual day next month rather than drifting later every cycle. With no due
 * date recorded, the payment date is the only anchor available.
 */
export function advanceAfterPayment(
  commitment: Pick<RecurringExpense, 'nextDueDate' | 'interval'>,
  paidOn: ISODate,
): ISODate {
  const anchor = commitment.nextDueDate ?? paidOn;
  return nextOccurrence(anchor, commitment.interval, dayAfter(paidOn));
}

/** `nextOccurrence` treats its `from` as inclusive, so a same-day payment needs +1. */
function dayAfter(value: ISODate): ISODate {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Forward-looking balance
// ---------------------------------------------------------------------------

export interface ProjectedBalance {
  /** Income expected for the cycle. */
  income: Minor;
  /** Spent so far, everything included. */
  spent: Minor;
  /** Tracked commitments not yet paid. */
  committed: Minor;
  /** Everyday spending still expected, from the current run rate. */
  everyday: Minor;
  /** income − spent − committed − everyday. Can be negative. */
  leftover: Minor;
  /** What is left once commitments are met, before everyday spending. */
  afterCommitments: Minor;
}

/**
 * What will be left at the end of the cycle.
 *
 * Separating `afterCommitments` from `leftover` is the point. Committed money is
 * already spoken for and cannot be reconsidered; everyday spending is an estimate the
 * user can still act on. Collapsing them into one number hides which half is movable.
 */
export function projectBalance(input: {
  income: Minor;
  spent: Minor;
  committed: Minor;
  everyday: Minor;
}): ProjectedBalance {
  const afterCommitments = (input.income - input.spent - input.committed) as Minor;
  const leftover = (afterCommitments - input.everyday) as Minor;
  return {
    income: input.income,
    spent: input.spent,
    committed: input.committed,
    everyday: input.everyday,
    afterCommitments,
    leftover,
  };
}

export const INTERVAL_MONTHS: Record<RecurrenceInterval, number> = {
  weekly: 1 / 4.345,
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
};
