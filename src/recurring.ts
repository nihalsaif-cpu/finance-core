/**
 * Recurring payment detection (§16).
 *
 * Finds the payments that repeat — rent, EMI, subscriptions, the gym — by looking for
 * the same merchant recurring at a regular interval for a similar amount.
 *
 * The bar is deliberately high. A false positive tells the user ₹40,000 of rent is due
 * next week when it is not, which corrupts every forecast built on top of it; a false
 * negative merely means they add it by hand. So three occurrences are required, the
 * gaps must be consistent, and the amounts must be close.
 */

import { addDays, addMonths, daysBetween, type ISODate, parseISO, toISO, daysInMonth } from './date';
import { DEFAULT_LEDGER_OPTIONS, type LedgerOptions, spendOf } from './ledger';
import { abs, divide, fromMinor, sub, type Minor } from './money';
import type { AnalyzableTransaction, RecurrenceInterval, UUID } from './types';

/** Day gaps that count as each interval, allowing for weekends and bank delays. */
const INTERVAL_WINDOWS: Array<{ interval: RecurrenceInterval; min: number; max: number; nominal: number }> = [
  { interval: 'weekly', min: 6, max: 8, nominal: 7 },
  { interval: 'monthly', min: 26, max: 35, nominal: 30 },
  { interval: 'quarterly', min: 83, max: 97, nominal: 91 },
  { interval: 'half_yearly', min: 172, max: 195, nominal: 182 },
  { interval: 'yearly', min: 350, max: 380, nominal: 365 },
];

/** Minimum occurrences before a pattern is called recurring. */
const MIN_OCCURRENCES = 3;

/** How much the amount may vary and still count as the same commitment. */
const AMOUNT_TOLERANCE = 0.15;

export interface RecurringCandidate {
  merchantKey: string;
  name: string;
  /** The representative amount — the median, so one unusual month cannot skew it. */
  amount: Minor;
  interval: RecurrenceInterval;
  categoryId: UUID | null;
  /** Day of month (monthly and longer) or day of week (weekly, 0 = Sunday). */
  dayOfPeriod: number | null;
  lastSeenDate: ISODate;
  nextDueDate: ISODate;
  occurrences: number;
  /** 0–1. How regular the gaps and how consistent the amounts. */
  confidence: number;
  /** True when every observed amount was identical — a subscription rather than a bill. */
  fixedAmount: boolean;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0;
}

function classifyGaps(gaps: readonly number[]): { interval: RecurrenceInterval; regularity: number } | null {
  if (gaps.length === 0) return null;
  const typical = median(gaps);
  const window = INTERVAL_WINDOWS.find((w) => typical >= w.min && typical <= w.max);
  if (!window) return null;

  // Every gap must plausibly belong to the same interval — one payment three months
  // late is a coincidence, not a quarterly commitment.
  const consistent = gaps.filter((gap) => gap >= window.min && gap <= window.max).length;
  const regularity = consistent / gaps.length;
  if (regularity < 0.6) return null;

  return { interval: window.interval, regularity };
}

/** The next occurrence after `from`, given the interval and where the last one fell. */
export function nextOccurrence(last: ISODate, interval: RecurrenceInterval, from: ISODate): ISODate {
  const step = (date: ISODate): ISODate => {
    switch (interval) {
      case 'weekly':
        return addDays(date, 7);
      case 'monthly':
        return addMonths(date, 1);
      case 'quarterly':
        return addMonths(date, 3);
      case 'half_yearly':
        return addMonths(date, 6);
      case 'yearly':
        return addMonths(date, 12);
    }
  };

  let next = step(last);
  /**
   * Strictly BEFORE `from`, not before-or-equal.
   *
   * A payment falling due today must report today. Skipping it pushed rent due on the
   * 27th to the 3rd of next month, so the calendar would show nothing owed on the day
   * it was actually owed.
   */
  // Bounded so a very old anchor cannot spin.
  for (let i = 0; i < 500 && next < from; i++) next = step(next);
  return next;
}

export interface DetectOptions {
  today: ISODate;
  options?: LedgerOptions;
  /** Ignore anything last seen longer ago than this; the commitment has probably ended. */
  staleAfterDays?: number;
}

/**
 * Find recurring payments in transaction history.
 *
 * Only spending counts: a salary credit repeats monthly too, but it is income and
 * belongs to the income side of the app, not to committed outgoings.
 */
export function detectRecurring(
  transactions: readonly AnalyzableTransaction[],
  { today, options = DEFAULT_LEDGER_OPTIONS, staleAfterDays = 400 }: DetectOptions,
): RecurringCandidate[] {
  const byMerchant = new Map<string, AnalyzableTransaction[]>();

  for (const t of transactions) {
    if (spendOf(t, options) <= 0) continue; // spending only, and never refunds
    if (!t.merchantKey) continue;
    const list = byMerchant.get(t.merchantKey) ?? [];
    list.push(t);
    byMerchant.set(t.merchantKey, list);
  }

  const candidates: RecurringCandidate[] = [];

  for (const [merchantKey, group] of byMerchant) {
    if (group.length < MIN_OCCURRENCES) continue;

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    // Collapse same-day duplicates: two coffees on one day are not two occurrences.
    const byDate = new Map<ISODate, AnalyzableTransaction>();
    for (const t of sorted) if (!byDate.has(t.date)) byDate.set(t.date, t);
    const unique = [...byDate.values()];
    if (unique.length < MIN_OCCURRENCES) continue;

    const gaps: number[] = [];
    for (let i = 1; i < unique.length; i++) {
      gaps.push(daysBetween(unique[i - 1]!.date, unique[i]!.date));
    }

    const classified = classifyGaps(gaps);
    if (!classified) continue;

    const amounts = unique.map((t) => spendOf(t, options) as number);
    const typicalAmount = median(amounts);
    if (typicalAmount <= 0) continue;

    // Amount consistency: how many payments sit within tolerance of the median.
    const withinTolerance = amounts.filter(
      (a) => Math.abs(a - typicalAmount) / typicalAmount <= AMOUNT_TOLERANCE,
    ).length;
    const amountConsistency = withinTolerance / amounts.length;
    if (amountConsistency < 0.6) continue;

    const last = unique[unique.length - 1]!;
    if (daysBetween(last.date, today) > staleAfterDays) continue;

    const confidence = Math.min(
      0.99,
      classified.regularity * 0.5 +
        amountConsistency * 0.3 +
        Math.min(1, unique.length / 6) * 0.2,
    );

    const lastDate = parseISO(last.date);
    candidates.push({
      merchantKey,
      name: last.merchantName ?? last.description ?? merchantKey,
      amount: fromMinor(typicalAmount),
      interval: classified.interval,
      categoryId: last.categoryId,
      dayOfPeriod: classified.interval === 'weekly' ? null : lastDate.day,
      lastSeenDate: last.date,
      nextDueDate: nextOccurrence(last.date, classified.interval, today),
      occurrences: unique.length,
      confidence,
      fixedAmount: new Set(amounts).size === 1,
    });
  }

  return candidates.sort((a, b) => b.amount - a.amount);
}

/** Monthly-equivalent cost, so intervals can be compared and summed. */
export function monthlyEquivalent(amount: Minor, interval: RecurrenceInterval): Minor {
  switch (interval) {
    case 'weekly':
      return fromMinor(Math.round((amount * 52) / 12));
    case 'monthly':
      return amount;
    case 'quarterly':
      return divide(amount, 3);
    case 'half_yearly':
      return divide(amount, 6);
    case 'yearly':
      return divide(amount, 12);
  }
}

export const INTERVAL_LABELS: Record<RecurrenceInterval, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  half_yearly: 'Every 6 months',
  yearly: 'Yearly',
};

export { daysInMonth, toISO, abs, sub };
