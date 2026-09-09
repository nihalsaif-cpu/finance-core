/**
 * Salary cycles — the financial month.
 *
 * The calendar month is *not* the financial month. Someone paid on the 28th lives in
 * a 28 Aug → 27 Sep cycle, and every "this month" number in the app must be computed
 * against that window. Cycle boundaries are derived, never stored per-month, so
 * changing the payday reshapes history consistently.
 */

import {
  addDays,
  addMonths,
  clamp,
  daysInMonth,
  daysBetween,
  formatDayMonth,
  formatFull,
  inclusiveDayCount,
  ISODate,
  isWithin,
  monthShort,
  parseISO,
  toISO,
} from './date';

export type CycleFrequency = 'monthly' | 'semimonthly' | 'biweekly' | 'weekly';

export interface CycleConfig {
  /** Day of month the salary lands, 1–31. Clamped in short months. */
  startDay: number;
  frequency: CycleFrequency;
  /** Required for weekly/biweekly: any known payday, used as the phase anchor. */
  anchorDate?: ISODate;
}

export interface SalaryCycle {
  /** Stable identifier — the start date. */
  key: string;
  start: ISODate;
  /** Inclusive last day of the cycle. */
  end: ISODate;
  /** Total days in the cycle, inclusive. */
  totalDays: number;
  /** "Aug 2026" for calendar-aligned cycles, "28 Aug – 27 Sep" otherwise. */
  label: string;
  /** Always the explicit range, for headers and reports. */
  rangeLabel: string;
}

export interface CycleProgress {
  cycle: SalaryCycle;
  /** 1-based day within the cycle; clamped to [1, totalDays]. */
  dayIndex: number;
  daysElapsed: number;
  /** Days left *including* today. 0 once the cycle has ended. */
  daysRemaining: number;
  /** dayIndex / totalDays, in (0, 1]. */
  elapsedFraction: number;
  isCurrent: boolean;
  isComplete: boolean;
}

export const DEFAULT_CYCLE: CycleConfig = { startDay: 1, frequency: 'monthly' };

export function normalizeCycleConfig(config: Partial<CycleConfig> | null | undefined): CycleConfig {
  const startDay = Math.min(31, Math.max(1, Math.round(config?.startDay ?? 1)));
  const frequency = config?.frequency ?? 'monthly';
  const out: CycleConfig = { startDay, frequency };
  if (config?.anchorDate) out.anchorDate = config.anchorDate;
  return out;
}

/** The payday in a given month, clamped: the 31st becomes the 28th in February. */
function paydayIn(year: number, month: number, startDay: number): ISODate {
  return toISO({ year, month, day: Math.min(startDay, daysInMonth(year, month)) });
}

/** The most recent cycle start at or before `date`. */
function monthlyStartOnOrBefore(date: ISODate, startDay: number): ISODate {
  const { year, month } = parseISO(date);
  const thisMonth = paydayIn(year, month, startDay);
  if (thisMonth <= date) return thisMonth;
  const prev = addMonths(toISO({ year, month, day: 1 }), -1);
  const p = parseISO(prev);
  return paydayIn(p.year, p.month, startDay);
}

function semimonthlyStartOnOrBefore(date: ISODate, startDay: number): ISODate {
  const { year, month } = parseISO(date);
  const first = paydayIn(year, month, startDay);
  const secondDay = Math.min(startDay + 15, daysInMonth(year, month));
  const second = toISO({ year, month, day: secondDay });
  if (second <= date && second !== first) return second;
  if (first <= date) return first;
  const prev = parseISO(addMonths(toISO({ year, month, day: 1 }), -1));
  const prevSecondDay = Math.min(startDay + 15, daysInMonth(prev.year, prev.month));
  return toISO({ year: prev.year, month: prev.month, day: prevSecondDay });
}

function periodicStartOnOrBefore(date: ISODate, anchor: ISODate, periodDays: number): ISODate {
  const diff = daysBetween(anchor, date);
  const periods = Math.floor(diff / periodDays);
  return addDays(anchor, periods * periodDays);
}

function nextStartAfter(start: ISODate, config: CycleConfig): ISODate {
  switch (config.frequency) {
    case 'monthly': {
      const { year, month } = parseISO(start);
      const next = parseISO(addMonths(toISO({ year, month, day: 1 }), 1));
      return paydayIn(next.year, next.month, config.startDay);
    }
    case 'semimonthly': {
      const { year, month, day } = parseISO(start);
      const firstDay = Math.min(config.startDay, daysInMonth(year, month));
      if (day === firstDay) {
        const secondDay = Math.min(config.startDay + 15, daysInMonth(year, month));
        if (secondDay > firstDay) return toISO({ year, month, day: secondDay });
      }
      const next = parseISO(addMonths(toISO({ year, month, day: 1 }), 1));
      return paydayIn(next.year, next.month, config.startDay);
    }
    case 'biweekly':
      return addDays(start, 14);
    case 'weekly':
      return addDays(start, 7);
  }
}

function buildCycle(start: ISODate, config: CycleConfig): SalaryCycle {
  const nextStart = nextStartAfter(start, config);
  const end = addDays(nextStart, -1);
  return {
    key: start,
    start,
    end,
    totalDays: inclusiveDayCount(start, end),
    label: cycleLabel(start, end, config),
    rangeLabel: `${formatDayMonth(start)} – ${formatFull(end)}`,
  };
}

function cycleLabel(start: ISODate, end: ISODate, config: CycleConfig): string {
  const s = parseISO(start);
  if (config.frequency === 'monthly' && config.startDay === 1) {
    return `${monthShort(s.month)} ${s.year}`;
  }
  const e = parseISO(end);
  if (s.year === e.year) return `${formatDayMonth(start)} – ${formatDayMonth(end)}`;
  return `${formatDayMonth(start)} – ${formatFull(end)}`;
}

/** The salary cycle containing `date`. */
export function cycleContaining(date: ISODate, rawConfig: Partial<CycleConfig>): SalaryCycle {
  const config = normalizeCycleConfig(rawConfig);
  let start: ISODate;
  switch (config.frequency) {
    case 'monthly':
      start = monthlyStartOnOrBefore(date, config.startDay);
      break;
    case 'semimonthly':
      start = semimonthlyStartOnOrBefore(date, config.startDay);
      break;
    case 'biweekly':
    case 'weekly': {
      const period = config.frequency === 'weekly' ? 7 : 14;
      const anchor = config.anchorDate ?? monthlyStartOnOrBefore(date, config.startDay);
      start = periodicStartOnOrBefore(date, anchor, period);
      break;
    }
  }
  return buildCycle(start, config);
}

export function nextCycle(cycle: SalaryCycle, rawConfig: Partial<CycleConfig>): SalaryCycle {
  const config = normalizeCycleConfig(rawConfig);
  return buildCycle(nextStartAfter(cycle.start, config), config);
}

export function previousCycle(cycle: SalaryCycle, rawConfig: Partial<CycleConfig>): SalaryCycle {
  const config = normalizeCycleConfig(rawConfig);
  return cycleContaining(addDays(cycle.start, -1), config);
}

/**
 * The `count` cycles ending with (and including) the one containing `date`,
 * oldest first. Used for 3-month and 6-month baselines.
 */
export function recentCycles(date: ISODate, rawConfig: Partial<CycleConfig>, count: number): SalaryCycle[] {
  const config = normalizeCycleConfig(rawConfig);
  if (count <= 0) return [];
  const out: SalaryCycle[] = [];
  let current = cycleContaining(date, config);
  for (let i = 0; i < count; i++) {
    out.unshift(current);
    current = previousCycle(current, config);
  }
  return out;
}

/** All cycles overlapping [from, to], oldest first. Bounded to avoid runaway loops. */
export function cyclesBetween(
  from: ISODate,
  to: ISODate,
  rawConfig: Partial<CycleConfig>,
  maxCycles = 240,
): SalaryCycle[] {
  const config = normalizeCycleConfig(rawConfig);
  if (from > to) return [];
  const out: SalaryCycle[] = [];
  let current = cycleContaining(from, config);
  while (current.start <= to && out.length < maxCycles) {
    out.push(current);
    current = nextCycle(current, config);
  }
  return out;
}

export function isInCycle(date: ISODate, cycle: SalaryCycle): boolean {
  return isWithin(date, cycle.start, cycle.end);
}

/**
 * Where `today` sits inside a cycle. For a past cycle this reports it as complete
 * (dayIndex = totalDays) so historical comparisons use the full window; for a future
 * cycle, dayIndex 1 with nothing elapsed.
 */
export function cycleProgress(cycle: SalaryCycle, today: ISODate): CycleProgress {
  const isComplete = today > cycle.end;
  const isFuture = today < cycle.start;
  const effectiveToday = clamp(today, cycle.start, cycle.end);
  const dayIndex = isFuture ? 0 : inclusiveDayCount(cycle.start, effectiveToday);
  const daysRemaining = isComplete ? 0 : cycle.totalDays - dayIndex;

  return {
    cycle,
    dayIndex: Math.max(isFuture ? 0 : 1, dayIndex),
    daysElapsed: Math.max(0, dayIndex),
    daysRemaining: Math.max(0, daysRemaining),
    elapsedFraction: cycle.totalDays === 0 ? 0 : Math.max(0, dayIndex) / cycle.totalDays,
    isCurrent: !isComplete && !isFuture,
    isComplete,
  };
}

/** "Day 15 of 30" */
export function progressLabel(progress: CycleProgress): string {
  return `Day ${progress.dayIndex} of ${progress.cycle.totalDays}`;
}

/** The next payday at or after `date`, for upcoming-income projections. */
export function nextPayday(date: ISODate, rawConfig: Partial<CycleConfig>): ISODate {
  const config = normalizeCycleConfig(rawConfig);
  const current = cycleContaining(date, config);
  return current.start >= date ? current.start : nextCycle(current, config).start;
}
