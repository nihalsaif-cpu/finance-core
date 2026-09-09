/**
 * Periods: a single cycle, or a whole year of them.
 *
 * The app is built on salary cycles rather than calendar months, and that stays true
 * here — a year is twelve CYCLES, not twelve calendar months. For someone paid on the
 * 1st the two are identical; for someone paid on the 25th they are not, and mixing the
 * units would make a year's total disagree with the sum of the months shown inside it.
 *
 * Everything is pure. `buildYearSummary` takes cycles and transactions and returns
 * figures; it knows nothing about how they were fetched.
 */

import type { CycleConfig, SalaryCycle } from './cycle';
import { cyclesBetween, cycleContaining } from './cycle';
import { addDays, addMonths, type ISODate, parseISO } from './date';
import { DEFAULT_LEDGER_OPTIONS, type LedgerOptions, totalsOf } from './ledger';
import { divide, sub, sum, ZERO, type Minor } from './money';
import { inCycle, spendByCategory, type CategoryIndex, type Rollup } from './analytics';
import type { AnalyzableTransaction } from './types';

export type PeriodKind = 'cycle' | 'year';

export interface Period {
  kind: PeriodKind;
  /** Stable identity for selection and query keys. */
  key: string;
  start: ISODate;
  /** Inclusive. */
  end: ISODate;
  label: string;
}

export function cyclePeriod(cycle: SalaryCycle): Period {
  return { kind: 'cycle', key: `cycle:${cycle.key}`, start: cycle.start, end: cycle.end, label: cycle.label };
}

/**
 * The twelve cycles that make up a year.
 *
 * Anchored on the cycle CONTAINING 1 January, so a year runs from the first payday of
 * that year to the day before the first payday of the next. That keeps every cycle
 * whole: splitting one across a year boundary would put half a month's rent in each.
 */
export function cyclesOfYear(year: number, config: Partial<CycleConfig>): SalaryCycle[] {
  const anchor = cycleContaining(`${year}-01-01` as ISODate, config);
  const nextAnchor = cycleContaining(`${year + 1}-01-01` as ISODate, config);
  // `to` is exclusive of the next year's anchor, so at most twelve cycles come back.
  const beforeNext = addDays(nextAnchor.start, -1);
  return cyclesBetween(anchor.start, beforeNext, config, 13);
}

export function yearPeriod(year: number, config: Partial<CycleConfig>): Period {
  const cycles = cyclesOfYear(year, config);
  const first = cycles[0];
  const last = cycles[cycles.length - 1];
  return {
    kind: 'year',
    key: `year:${year}`,
    start: first?.start ?? (`${year}-01-01` as ISODate),
    end: last?.end ?? (`${year}-12-31` as ISODate),
    label: String(year),
  };
}

export interface MonthPoint {
  cycle: SalaryCycle;
  spend: Minor;
  income: Minor;
  /** income − spend. Negative means the month cost more than it earned. */
  net: Minor;
  transactionCount: number;
  /** True when the cycle has not finished, so it is not comparable. */
  isPartial: boolean;
}

export interface YearSummary {
  year: number;
  months: MonthPoint[];
  totalSpend: Minor;
  totalIncome: Minor;
  totalSaved: Minor;
  savingsRate: number | null;
  /** Average across COMPLETED cycles only. */
  averageSpend: Minor;
  /** The heaviest and lightest completed months, for the headline. */
  busiest: MonthPoint | null;
  quietest: MonthPoint | null;
  categories: Rollup[];
  /** Months with any activity — a year with two months of data should say so. */
  monthsWithData: number;
}

/**
 * A year, month by month, plus the totals.
 *
 * Partial cycles are included in the totals (the money was really spent) but excluded
 * from the average and from busiest/quietest. A month that is three days old is not a
 * candidate for "your quietest month" — that is a fact about the calendar, not about
 * spending, and it is the most common way an annual summary misleads.
 */
export function buildYearSummary(
  year: number,
  cycles: readonly SalaryCycle[],
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  today: ISODate,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): YearSummary {
  const months: MonthPoint[] = cycles.map((cycle) => {
    const rows = inCycle(transactions, cycle);
    const totals = totalsOf(rows, options);
    return {
      cycle,
      spend: totals.totalSpend,
      income: totals.totalIncome,
      net: sub(totals.totalIncome, totals.totalSpend),
      transactionCount: totals.transactionCount,
      isPartial: cycle.end >= today,
    };
  });

  const totalSpend = sum(months.map((m) => m.spend));
  const totalIncome = sum(months.map((m) => m.income));
  const totalSaved = sub(totalIncome, totalSpend);

  const complete = months.filter((m) => !m.isPartial && (m.transactionCount > 0 || (m.spend as number) > 0));

  const busiest = complete.length
    ? complete.reduce((max, m) => (m.spend > max.spend ? m : max))
    : null;
  const quietest = complete.length
    ? complete.reduce((min, m) => (m.spend < min.spend ? m : min))
    : null;

  const yearRows = transactions.filter((t) =>
    months.some((m) => t.date >= m.cycle.start && t.date <= m.cycle.end),
  );

  return {
    year,
    months,
    totalSpend,
    totalIncome,
    totalSaved,
    savingsRate: (totalIncome as number) > 0
      ? ((totalSaved as number) / (totalIncome as number)) * 100
      : null,
    averageSpend: complete.length ? divide(sum(complete.map((m) => m.spend)), complete.length) : ZERO,
    busiest,
    quietest,
    categories: spendByCategory(yearRows, categories, options),
    monthsWithData: months.filter((m) => m.transactionCount > 0).length,
  };
}

/** The headline for a year, stated as a finding rather than a label. */
export function yearFinding(
  summary: YearSummary,
  money: (value: Minor) => string,
): string {
  if (summary.monthsWithData === 0) return 'Nothing recorded for this year yet.';

  const rate = Math.round(summary.savingsRate ?? 0);
  const thin = summary.monthsWithData === 1 ? ' So far that is one month of data.' : '';

  /*
   * Overspending is stated FIRST, before the sample-size caveat.
   *
   * An earlier ordering led with "only one month of data" and buried the fact that
   * the year had cost more than it earned. The caveat matters, but it qualifies the
   * finding rather than replacing it.
   */
  if ((summary.totalIncome as number) > 0 && rate < 0) {
    return `You spent ${money(summary.totalSpend)} against ${money(summary.totalIncome)} earned — ${Math.abs(rate)}% more than came in.${thin}`;
  }
  if ((summary.totalIncome as number) <= 0) {
    return `${money(summary.totalSpend)} spent across ${summary.monthsWithData} ${summary.monthsWithData === 1 ? 'month' : 'months'}.`;
  }
  return `You kept ${rate}% of ${money(summary.totalIncome)} this year.${thin}`;
}

/** Years the user could plausibly look at, newest first. */
export function selectableYears(earliest: ISODate | null, today: ISODate, max = 6): number[] {
  const thisYear = parseISO(today).year;
  const first = earliest ? parseISO(earliest).year : thisYear;
  const years: number[] = [];
  for (let y = thisYear; y >= first && years.length < max; y--) years.push(y);
  return years;
}

export { addMonths };
