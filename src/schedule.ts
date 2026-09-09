/**
 * The payment calendar and forecast.
 *
 * Projects recurring commitments forward onto real dates, marks off the ones already
 * paid, and estimates what will be left at the end of the cycle.
 *
 * The forecast is deliberately modest about what it knows. Committed payments are
 * things the user has told us about or that repeated reliably; discretionary spending
 * is an estimate from their own history. Those are different kinds of claim and the
 * output keeps them separate rather than blending them into one confident number.
 */

import {
  addDays, daysBetween, endOfMonth, type ISODate, isWithin, parseISO, startOfMonth, toISO,
} from './date';
import { nextOccurrence } from './recurring';
import { DEFAULT_LEDGER_OPTIONS, type LedgerOptions, spendOf } from './ledger';
import { ZERO, add, clampAtZero, divide, fromMinor, sub, sum, type Minor } from './money';
import type { AnalyzableTransaction, RecurrenceInterval, UUID } from './types';

export interface ScheduledCommitment {
  id: UUID;
  name: string;
  amount: Minor;
  interval: RecurrenceInterval;
  categoryId: UUID | null;
  merchantKey: string | null;
  isEssential: boolean;
  /** Where the series is anchored — the last confirmed payment, or an explicit due date. */
  lastSeenDate: ISODate | null;
  nextDueDate: ISODate | null;
}

export type OccurrenceStatus = 'paid' | 'due' | 'overdue' | 'upcoming';

export interface PaymentOccurrence {
  commitmentId: UUID;
  name: string;
  amount: Minor;
  dueDate: ISODate;
  categoryId: UUID | null;
  isEssential: boolean;
  status: OccurrenceStatus;
  /** The transaction that settled this occurrence, when one was found. */
  paidBy?: { id: UUID; date: ISODate; amount: Minor };
}

/** How far either side of the due date a payment still counts as settling it. */
const MATCH_WINDOW_DAYS = 6;

/**
 * Every occurrence of one commitment between two dates.
 *
 * Anchored on the last confirmed payment where there is one, because that reflects
 * reality; an explicit `nextDueDate` is used otherwise. Bounded so a corrupt anchor
 * cannot generate an unbounded series.
 */
export function occurrencesBetween(
  commitment: ScheduledCommitment,
  from: ISODate,
  to: ISODate,
  maxOccurrences = 200,
): ISODate[] {
  if (from > to) return [];

  const anchor = commitment.lastSeenDate ?? commitment.nextDueDate;
  if (!anchor) return [];

  const dates: ISODate[] = [];

  // The explicit next due date is itself an occurrence when it falls in range.
  if (commitment.nextDueDate && isWithin(commitment.nextDueDate, from, to)) {
    dates.push(commitment.nextDueDate);
  }

  let cursor = commitment.nextDueDate ?? anchor;
  for (let i = 0; i < maxOccurrences; i++) {
    cursor = nextOccurrence(cursor, commitment.interval, cursor);
    if (cursor > to) break;
    if (cursor >= from && !dates.includes(cursor)) dates.push(cursor);
  }

  // Walk backwards too, so a month already begun still shows its earlier due dates.
  let back = commitment.nextDueDate ?? anchor;
  for (let i = 0; i < maxOccurrences; i++) {
    const previous = previousOccurrence(back, commitment.interval);
    if (previous >= back) break;
    back = previous;
    if (back < from) break;
    if (back <= to && !dates.includes(back)) dates.push(back);
  }

  return dates.sort();
}

function previousOccurrence(date: ISODate, interval: RecurrenceInterval): ISODate {
  const { year, month, day } = parseISO(date);
  const back = (months: number): ISODate => {
    const zero = year * 12 + (month - 1) - months;
    const y = Math.floor(zero / 12);
    const m = (zero % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return toISO({ year: y, month: m, day: Math.min(day, lastDay) });
  };
  switch (interval) {
    case 'weekly':
      return addDays(date, -7);
    case 'monthly':
      return back(1);
    case 'quarterly':
      return back(3);
    case 'half_yearly':
      return back(6);
    case 'yearly':
      return back(12);
  }
}

/**
 * The full schedule over a window, with each occurrence marked paid or not.
 *
 * A commitment is settled by a transaction from the same merchant, near the due date,
 * for a comparable amount. Each transaction settles at most one occurrence, so two
 * payments to the same merchant in one month do not silently clear two months of rent.
 */
export function projectSchedule(
  commitments: readonly ScheduledCommitment[],
  transactions: readonly AnalyzableTransaction[],
  from: ISODate,
  to: ISODate,
  today: ISODate,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): PaymentOccurrence[] {
  const claimed = new Set<UUID>();
  const out: PaymentOccurrence[] = [];

  for (const commitment of commitments) {
    const dates = occurrencesBetween(commitment, from, to);

    for (const dueDate of dates) {
      const match = transactions.find((t) => {
        if (claimed.has(t.id)) return false;
        if (spendOf(t, options) <= 0) return false;
        if (commitment.merchantKey && t.merchantKey !== commitment.merchantKey) return false;
        if (!commitment.merchantKey && t.categoryId !== commitment.categoryId) return false;
        return Math.abs(daysBetween(dueDate, t.date)) <= MATCH_WINDOW_DAYS;
      });

      if (match) claimed.add(match.id);

      const status: OccurrenceStatus = match
        ? 'paid'
        : dueDate < today
          ? 'overdue'
          : dueDate === today
            ? 'due'
            : 'upcoming';

      out.push({
        commitmentId: commitment.id,
        name: commitment.name,
        amount: commitment.amount,
        dueDate,
        categoryId: commitment.categoryId,
        isEssential: commitment.isEssential,
        status,
        ...(match
          ? { paidBy: { id: match.id, date: match.date, amount: spendOf(match, options) } }
          : {}),
      });
    }
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.amount - a.amount);
}

export interface DaySummary {
  date: ISODate;
  /** What was actually spent that day. */
  spent: Minor;
  transactionCount: number;
  /** Commitments falling due that day, whether or not they are settled. */
  due: PaymentOccurrence[];
  dueTotal: Minor;
  isToday: boolean;
  isFuture: boolean;
}

/** One entry per day in the window — what the calendar grid renders. */
export function buildCalendar(
  from: ISODate,
  to: ISODate,
  transactions: readonly AnalyzableTransaction[],
  schedule: readonly PaymentOccurrence[],
  today: ISODate,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): DaySummary[] {
  const spentByDay = new Map<ISODate, { total: number; count: number }>();
  for (const t of transactions) {
    const value = spendOf(t, options);
    if (value === 0 || !isWithin(t.date, from, to)) continue;
    const entry = spentByDay.get(t.date) ?? { total: 0, count: 0 };
    entry.total += value;
    if (value > 0) entry.count += 1;
    spentByDay.set(t.date, entry);
  }

  const dueByDay = new Map<ISODate, PaymentOccurrence[]>();
  for (const occurrence of schedule) {
    if (!isWithin(occurrence.dueDate, from, to)) continue;
    const list = dueByDay.get(occurrence.dueDate) ?? [];
    list.push(occurrence);
    dueByDay.set(occurrence.dueDate, list);
  }

  const days: DaySummary[] = [];
  const total = daysBetween(from, to);
  for (let i = 0; i <= total; i++) {
    const date = addDays(from, i);
    const spent = spentByDay.get(date);
    const due = dueByDay.get(date) ?? [];
    days.push({
      date,
      spent: fromMinor(spent?.total ?? 0),
      transactionCount: spent?.count ?? 0,
      due,
      dueTotal: sum(due.filter((d) => d.status !== 'paid').map((d) => d.amount)),
      isToday: date === today,
      isFuture: date > today,
    });
  }
  return days;
}

/** The calendar month containing `date`, padded to whole weeks for a grid. */
export function calendarMonth(date: ISODate): { from: ISODate; to: ISODate; monthStart: ISODate; monthEnd: ISODate } {
  const monthStart = startOfMonth(date);
  const monthEnd = endOfMonth(date);
  // Weeks start Monday, which is how Indian calendars and bank statements read.
  const startWeekday = (new Date(`${monthStart}T00:00:00Z`).getUTCDay() + 6) % 7;
  const endWeekday = (new Date(`${monthEnd}T00:00:00Z`).getUTCDay() + 6) % 7;
  return {
    from: addDays(monthStart, -startWeekday),
    to: addDays(monthEnd, 6 - endWeekday),
    monthStart,
    monthEnd,
  };
}

export interface Forecast {
  /** Commitments still to be paid before the window ends. */
  committed: Minor;
  /** Estimated discretionary spending over the remaining days, from history. */
  estimatedDiscretionary: Minor;
  /** income − spent so far − committed − estimated discretionary. */
  projectedRemaining: Minor;
  /** What is left before the estimate is applied — the part we are surer of. */
  remainingBeforeEstimate: Minor;
  /** The part of `committed` that has no date, and so appears on no day. */
  undatedCommitted: Minor;
  daysRemaining: number;
  /** False when there is no history to estimate discretionary spending from. */
  hasHistory: boolean;
}

export interface ForecastInput {
  income: Minor;
  spentToDate: Minor;
  schedule: readonly PaymentOccurrence[];
  today: ISODate;
  cycleEnd: ISODate;
  /** Typical daily discretionary spend from prior cycles. Omit when unknown. */
  typicalDailyDiscretionary?: Minor;
  /**
   * Committed money this cycle that could not be placed on a date.
   *
   * A commitment with no last payment and no due date produces no occurrences, so the
   * schedule cannot see it. Leaving it out understated `committed` by the whole amount
   * and made the projection look far healthier than it was.
   */
  undatedCommitted?: Minor;
}

/**
 * What is likely to be left at the end of the cycle.
 *
 * Committed and estimated amounts are reported separately because they are different
 * kinds of claim: a rent payment on the 1st is near-certain, "you usually spend ₹600 a
 * day" is a pattern that any weekend can break.
 */
export function forecastCycle(input: ForecastInput): Forecast {
  const daysRemaining = Math.max(0, daysBetween(input.today, input.cycleEnd));

  const scheduled = sum(
    input.schedule
      .filter((o) => o.status !== 'paid' && o.dueDate >= input.today && o.dueDate <= input.cycleEnd)
      .map((o) => o.amount),
  );
  const committed = add(scheduled, input.undatedCommitted ?? ZERO);

  const hasHistory = input.typicalDailyDiscretionary !== undefined;
  const estimatedDiscretionary = hasHistory
    ? fromMinor(Math.round((input.typicalDailyDiscretionary as number) * daysRemaining))
    : ZERO;

  const remainingBeforeEstimate = sub(sub(input.income, input.spentToDate), committed);

  return {
    committed,
    undatedCommitted: input.undatedCommitted ?? ZERO,
    estimatedDiscretionary,
    projectedRemaining: sub(remainingBeforeEstimate, estimatedDiscretionary),
    remainingBeforeEstimate,
    daysRemaining,
    hasHistory,
  };
}

export { clampAtZero, divide };
