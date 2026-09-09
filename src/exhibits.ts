/**
 * Exhibit data — the shapes a chart needs, computed away from the chart.
 *
 * An "exhibit" here means what a consultant's deck means by it: one chart that makes
 * one point, with the point stated in the title. The functions below return both the
 * geometry to draw AND the finding to write above it, because a chart whose headline
 * says "Category breakdown" has made the reader do the work the exhibit was for.
 *
 * All of it is pure. Nothing here knows about React, SVG or pixels — the charts take
 * these numbers and scale them to whatever width they are given.
 */

import type { CycleTrendPoint, Rollup } from './analytics';
import type { EssentialSplit } from './ledger';
import { abs, add, divide, fromMinor, sub, sum, ZERO, type Minor } from './money';
import type { ISODate } from './date';

// ---------------------------------------------------------------------------
// Waterfall — where the money actually went
// ---------------------------------------------------------------------------

export type WaterfallKind = 'start' | 'decrease' | 'increase' | 'end';

export interface WaterfallStep {
  key: string;
  label: string;
  /** Signed: negative for money leaving. */
  delta: Minor;
  kind: WaterfallKind;
  /** Where the bar starts and ends on the value axis, for drawing. */
  from: Minor;
  to: Minor;
}

export interface Waterfall {
  steps: WaterfallStep[];
  /** Largest absolute value on the axis, for scaling. */
  peak: Minor;
  /** What is left at the end — may be negative. */
  net: Minor;
}

/**
 * Income, minus what it went on, ending at what remains.
 *
 * The classic bridge chart. It is the single most useful exhibit in the app because
 * it answers "where did it go" in one picture, and unlike a pie chart it shows the
 * *arithmetic* — the bars have to reach the end balance, so nothing can hide.
 *
 * Essentials and discretionary are split out rather than shown as one "spending" bar:
 * the whole point of looking is to see which half is movable.
 */
export function buildWaterfall(input: {
  income: Minor;
  split: EssentialSplit;
  invested: Minor;
}): Waterfall {
  const steps: WaterfallStep[] = [];
  let running = input.income;

  steps.push({
    key: 'income', label: 'Income', delta: input.income, kind: 'start',
    from: ZERO, to: input.income,
  });

  const outflows: Array<{ key: string; label: string; amount: Minor }> = [
    { key: 'essential', label: 'Essentials', amount: input.split.essential },
    { key: 'discretionary', label: 'Everyday', amount: input.split.discretionary },
    { key: 'invested', label: 'Invested', amount: input.invested },
  ];

  for (const outflow of outflows) {
    // A zero step is dropped rather than drawn as a hairline: an empty bar reads as a
    // rendering fault, and a category with no money in it makes no point.
    if (outflow.amount <= 0) continue;
    const next = sub(running, outflow.amount);
    steps.push({
      key: outflow.key,
      label: outflow.label,
      delta: fromMinor(-(outflow.amount as number)),
      kind: 'decrease',
      from: running,
      to: next,
    });
    running = next;
  }

  steps.push({
    key: 'left', label: 'Left', delta: running, kind: 'end',
    from: ZERO, to: running,
  });

  const peak = steps.reduce<Minor>(
    (max, step) => (abs(step.from) > max ? abs(step.from) : abs(step.to) > max ? abs(step.to) : max),
    ZERO,
  );

  return { steps, peak, net: running };
}

// ---------------------------------------------------------------------------
// Concentration — how few things account for most of it
// ---------------------------------------------------------------------------

export interface Concentration {
  /** How many entries it takes to reach `thresholdPercent` of the total. */
  count: number;
  /** Share those entries actually account for, 0–100. */
  share: number;
  /** The entries themselves, largest first. */
  top: Rollup[];
  totalEntries: number;
}

/**
 * The Pareto question: how much of the spending is a handful of things?
 *
 * Useful precisely because the answer is actionable either way. "Four merchants are
 * 70% of your spending" points at four decisions; "no merchant is over 6%" says the
 * money is going in a thousand small cuts and there is no single lever.
 */
export function concentration(rollups: readonly Rollup[], thresholdPercent = 80): Concentration {
  const total = sum(rollups.map((r) => r.amount));
  if ((total as number) <= 0) {
    return { count: 0, share: 0, top: [], totalEntries: rollups.length };
  }

  const sorted = [...rollups].sort((a, b) => b.amount - a.amount);
  let running = 0;
  const top: Rollup[] = [];

  for (const entry of sorted) {
    top.push(entry);
    running += entry.amount as number;
    if ((running / (total as number)) * 100 >= thresholdPercent) break;
  }

  return {
    count: top.length,
    share: (running / (total as number)) * 100,
    top,
    totalEntries: rollups.length,
  };
}

// ---------------------------------------------------------------------------
// Trend — spend across cycles, with the context to read it
// ---------------------------------------------------------------------------

export interface TrendPointView {
  label: string;
  spend: Minor;
  income: Minor;
  /** 0–1 against the series peak, for drawing. */
  height: number;
  isCurrent: boolean;
  /** True when this cycle is still running, so the bar is not yet comparable. */
  isPartial: boolean;
}

export interface TrendSeries {
  points: TrendPointView[];
  peak: Minor;
  average: Minor;
  /** Average excluding the current, still-incomplete cycle. */
  comparableAverage: Minor;
  /** Direction over the comparable points: > 0 means spending is rising. */
  slopePerCycle: Minor;
}

/**
 * A spend-per-cycle series, with the in-progress cycle marked.
 *
 * The current cycle is flagged `isPartial` because comparing four days of August
 * against the whole of July and calling it a fall is the most common way a spending
 * chart lies. The chart draws it differently and the average excludes it.
 */
export function buildTrend(
  points: readonly CycleTrendPoint[],
  currentCycleStart: ISODate | null,
): TrendSeries {
  if (points.length === 0) {
    return { points: [], peak: ZERO, average: ZERO, comparableAverage: ZERO, slopePerCycle: ZERO };
  }

  const peak = points.reduce<Minor>((max, p) => (p.spend > max ? p.spend : max), ZERO);

  const views: TrendPointView[] = points.map((p) => {
    const isCurrent = currentCycleStart !== null && p.cycle.start === currentCycleStart;
    return {
      label: p.cycle.label,
      spend: p.spend,
      income: p.income,
      height: (peak as number) > 0 ? (p.spend as number) / (peak as number) : 0,
      isCurrent,
      isPartial: isCurrent,
    };
  });

  const comparable = views.filter((v) => !v.isPartial);
  const average = divide(sum(views.map((v) => v.spend)), views.length);
  const comparableAverage =
    comparable.length > 0 ? divide(sum(comparable.map((v) => v.spend)), comparable.length) : ZERO;

  // Slope from first to last comparable point, per cycle. A least-squares fit would
  // be more defensible statistically but is unreadable on three data points, which is
  // what most users will have.
  const slopePerCycle =
    comparable.length >= 2
      ? divide(sub(comparable[comparable.length - 1]!.spend, comparable[0]!.spend), comparable.length - 1)
      : ZERO;

  return { points: views, peak, average, comparableAverage, slopePerCycle };
}

// ---------------------------------------------------------------------------
// Movers — what actually changed, and how much of the change it explains
// ---------------------------------------------------------------------------

export interface Mover {
  key: string;
  label: string;
  current: Minor;
  baseline: Minor;
  delta: Minor;
  /** Share of the TOTAL change this one line explains, 0–100. Signed. */
  contributionToChange: number;
  color?: string;
}

/**
 * Which categories drove the change between two periods.
 *
 * The attribution — "this one line is 62% of why you spent more" — is what turns a
 * table of deltas into a decision. Without it the user sees ten numbers went up and
 * has no idea which one to care about.
 */
export function movers(
  current: readonly Rollup[],
  baseline: readonly Rollup[],
  limit = 5,
): { risers: Mover[]; fallers: Mover[]; totalChange: Minor } {
  const baseByKey = new Map(baseline.map((r) => [r.key, r]));
  const keys = new Set([...current.map((r) => r.key), ...baseline.map((r) => r.key)]);

  const all: Mover[] = [];
  for (const key of keys) {
    const now = current.find((r) => r.key === key);
    const before = baseByKey.get(key);
    const currentAmount = now?.amount ?? ZERO;
    const baselineAmount = before?.amount ?? ZERO;
    const delta = sub(currentAmount, baselineAmount);
    if ((delta as number) === 0) continue;

    const mover: Mover = {
      key,
      label: now?.label ?? before?.label ?? key,
      current: currentAmount,
      baseline: baselineAmount,
      delta,
      contributionToChange: 0,
      ...(now?.color ? { color: now.color } : before?.color ? { color: before.color } : {}),
    };
    all.push(mover);
  }

  const totalChange = sub(sum(current.map((r) => r.amount)), sum(baseline.map((r) => r.amount)));

  // Attribution is against the ABSOLUTE size of the net change. When the net change is
  // near zero but individual lines moved a lot, a percentage of it would explode into
  // meaningless four-figure shares, so it is reported as zero and the chart falls back
  // to showing the raw movements.
  const denominator = Math.abs(totalChange as number);
  for (const mover of all) {
    mover.contributionToChange = denominator > 0 ? ((mover.delta as number) / denominator) * 100 : 0;
  }

  const risers = all.filter((m) => (m.delta as number) > 0).sort((a, b) => b.delta - a.delta).slice(0, limit);
  const fallers = all.filter((m) => (m.delta as number) < 0).sort((a, b) => a.delta - b.delta).slice(0, limit);

  return { risers, fallers, totalChange };
}

export { add, sum };

// ---------------------------------------------------------------------------
// Findings — the headline sentence above each exhibit
// ---------------------------------------------------------------------------

export interface FindingOptions {
  currency: string;
  /** How to render an amount. Injected so core stays free of formatting policy. */
  money: (value: Minor) => string;
}

/**
 * What the bridge chart shows, in a sentence.
 *
 * Stated as a fact about this cycle rather than a label. The negative case leads with
 * the overspend because that is the thing worth acting on, and says "so far" when the
 * cycle is still running so it does not read as a settled verdict.
 */
export function waterfallFinding(
  waterfall: Waterfall,
  income: Minor,
  cycleComplete: boolean,
  { money }: FindingOptions,
): string {
  const net = waterfall.net as number;
  const qualifier = cycleComplete ? '' : ' so far';

  if (net < 0) {
    return `You are ${money(fromMinor(-net))} past your income${qualifier}.`;
  }
  if ((income as number) <= 0) {
    return `${money(waterfall.net)} left${qualifier}, though no income is recorded for this cycle.`;
  }
  const share = Math.round((net / (income as number)) * 100);
  return `${money(waterfall.net)} of your ${money(income)} is still yours — ${share}%${qualifier}.`;
}

/** What the trend chart shows: rising, falling, or steady, with the size of the move. */
export function trendFinding(series: TrendSeries, { money }: FindingOptions): string {
  const comparable = series.points.filter((p) => !p.isPartial);
  if (comparable.length < 2) {
    return 'Not enough completed cycles yet to call a trend.';
  }

  const slope = series.slopePerCycle as number;
  const average = series.comparableAverage as number;
  // Under 5% of the average is noise, not a trend. Calling a ₹300 wobble on ₹50,000 a
  // "rise" is the kind of false precision that makes people stop trusting the app.
  const meaningful = average > 0 && Math.abs(slope) / average >= 0.05;

  if (!meaningful) {
    return `Spending is steady, around ${money(series.comparableAverage)} a cycle.`;
  }
  return slope > 0
    ? `Spending is climbing about ${money(fromMinor(slope))} each cycle.`
    : `Spending is falling about ${money(fromMinor(-slope))} each cycle.`;
}

/** What the movers chart shows: the single line that most explains the change. */
export function moversFinding(
  result: { risers: Mover[]; fallers: Mover[]; totalChange: Minor },
  { money }: FindingOptions,
): string {
  const change = result.totalChange as number;
  const leader = [...result.risers, ...result.fallers].sort(
    (a, b) => Math.abs(b.delta as number) - Math.abs(a.delta as number),
  )[0];

  if (!leader) return 'Nothing moved much against last cycle.';

  if (change === 0) {
    return `Total spending held flat, but ${leader.label} moved ${money(abs(leader.delta))}.`;
  }

  const direction = change > 0 ? 'more' : 'less';
  const share = Math.abs(Math.round(leader.contributionToChange));

  // Over 100% means this line moved further than the net — other categories offset it.
  // Saying "120% of the increase" is true but reads as a mistake, so it is worded to
  // explain rather than to quote the number.
  if (share > 100) {
    return `${leader.label} alone moved more than the ${money(abs(result.totalChange))} net change — other categories pulled the other way.`;
  }
  return `You spent ${money(abs(result.totalChange))} ${direction} than last cycle, and ${leader.label} is ${share}% of it.`;
}

/** What the concentration exhibit shows: whether there is a lever or a thousand cuts. */
export function concentrationFinding(result: Concentration, noun = 'categories'): string {
  if (result.count === 0) return 'Nothing recorded to break down yet.';

  const singular = noun === 'categories' ? 'category' : noun.replace(/s$/, '');
  const share = Math.round(result.share);

  if (result.count === 1) {
    return `One ${singular}, ${result.top[0]!.label}, is ${share}% of everything you spent.`;
  }
  /**
   * Thin spread is a RATIO, not "every single entry".
   *
   * "It takes all 3 of your categories" is technically true and useless — with few
   * entries you almost always need most of them. What the user needs to know is
   * whether a few lines dominate (there is a lever to pull) or the money is going out
   * in a thousand small cuts (there is not).
   */
  if (result.count / result.totalEntries >= 0.7) {
    return `Spending is spread thin — it takes ${result.count} of ${result.totalEntries} ${noun} to reach ${share}%, so there is no single lever.`;
  }
  return `${result.count} of your ${result.totalEntries} ${noun} account for ${share}% of spending.`;
}
