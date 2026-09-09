/**
 * Spending velocity and end-of-cycle projection.
 *
 * The naive projection — `spent × totalDays / dayElapsed` — is wrong in a specific,
 * misleading way: real spending is not uniform. Rent, EMIs and subscriptions land in
 * the first days of a cycle, so on day 3 the naive method projects catastrophe, and
 * on day 25 (after the fixed costs are long paid) it projects comfort. A user who
 * sees a red panic warning every month on day 2 stops reading warnings.
 *
 * So when the user has history, we project against the *shape* of their own past
 * cycles: "by 20% of the way through a cycle you have typically spent 38% of your
 * cycle total". With no history we fall back to linear, and say so — the app should
 * never present a low-confidence guess with the same authority as a grounded one.
 */

import { type ISODate, addDays, inclusiveDayCount } from './date';
import { ZERO, type Minor, clampAtZero, divide, fromMinor, scale, sub, sum } from './money';
import type { CycleProgress, SalaryCycle } from './cycle';
import { DEFAULT_LEDGER_OPTIONS, type LedgerOptions, spendOf } from './ledger';
import type { AnalyzableTransaction } from './types';

/** Resolution of the normalised spend curve: 0%, 5%, … 100% of a cycle. */
const CURVE_POINTS = 21;

export interface CycleSpendHistory {
  cycleKey: string;
  total: Minor;
  /** Cumulative spend at each of the CURVE_POINTS progress marks, as a fraction of total. */
  cumulativeFractions: number[];
}

export interface SpendCurve {
  /** fraction[i] = share of cycle total typically spent by progress i/(CURVE_POINTS-1). */
  fractions: number[];
  cyclesUsed: number;
}

/** A perfectly uniform curve — the linear fallback, expressed in the same shape. */
export const LINEAR_CURVE: SpendCurve = {
  fractions: Array.from({ length: CURVE_POINTS }, (_, i) => i / (CURVE_POINTS - 1)),
  cyclesUsed: 0,
};

/**
 * Cumulative spend fractions for one completed cycle, sampled at the curve's
 * progress marks. Returns null for a cycle with no spending (nothing to learn).
 */
export function cycleSpendHistory(
  cycle: SalaryCycle,
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): CycleSpendHistory | null {
  const perDay = new Array<number>(cycle.totalDays + 1).fill(0);
  let total = 0;

  for (const t of transactions) {
    const s = spendOf(t, options);
    if (s === 0) continue;
    if (t.date < cycle.start || t.date > cycle.end) continue;
    const dayIndex = inclusiveDayCount(cycle.start, t.date); // 1-based
    perDay[dayIndex] = (perDay[dayIndex] ?? 0) + s;
    total += s;
  }

  if (total <= 0) return null;

  const cumulative: number[] = [];
  let running = 0;
  let dayCursor = 0;
  for (let i = 0; i < CURVE_POINTS; i++) {
    const progress = i / (CURVE_POINTS - 1);
    const targetDay = Math.round(progress * cycle.totalDays);
    while (dayCursor < targetDay) {
      dayCursor += 1;
      running += perDay[dayCursor] ?? 0;
    }
    cumulative.push(running / total);
  }

  return { cycleKey: cycle.key, total: fromMinor(total), cumulativeFractions: cumulative };
}

/**
 * Average the shape of past cycles into one curve, weighting recent cycles more
 * heavily (spending habits change). Monotonicity is enforced so the curve can never
 * imply spending went backwards.
 */
export function buildSpendCurve(histories: readonly CycleSpendHistory[]): SpendCurve {
  const usable = histories.filter((h) => h.cumulativeFractions.length === CURVE_POINTS);
  if (usable.length === 0) return LINEAR_CURVE;

  const fractions = new Array<number>(CURVE_POINTS).fill(0);
  let weightSum = 0;

  usable.forEach((history, index) => {
    // Most recent cycle (last in the list) gets the highest weight.
    const weight = index + 1;
    weightSum += weight;
    for (let i = 0; i < CURVE_POINTS; i++) {
      fractions[i] = (fractions[i] ?? 0) + (history.cumulativeFractions[i] ?? 0) * weight;
    }
  });

  let previous = 0;
  const normalised = fractions.map((value, i) => {
    let v = weightSum === 0 ? i / (CURVE_POINTS - 1) : value / weightSum;
    v = Math.min(1, Math.max(previous, v));
    previous = v;
    return v;
  });
  normalised[0] = 0;
  normalised[CURVE_POINTS - 1] = 1;

  return { fractions: normalised, cyclesUsed: usable.length };
}

/** Interpolated share of a cycle's spending expected by a given progress point. */
export function expectedFractionAt(curve: SpendCurve, elapsedFraction: number): number {
  const clamped = Math.min(1, Math.max(0, elapsedFraction));
  const position = clamped * (CURVE_POINTS - 1);
  const lower = Math.floor(position);
  const upper = Math.min(CURVE_POINTS - 1, lower + 1);
  const t = position - lower;
  const a = curve.fractions[lower] ?? clamped;
  const b = curve.fractions[upper] ?? clamped;
  return a + (b - a) * t;
}

export type PaceStatus = 'under' | 'on_track' | 'over' | 'critical';
export type ProjectionMethod = 'linear' | 'historical_shape' | 'blended';
export type Confidence = 'low' | 'medium' | 'high';

export interface VelocityInput {
  progress: CycleProgress;
  /** Spend so far this cycle. */
  spentToDate: Minor;
  /** The amount the pace is measured against — overall budget, or income if unset. */
  referenceAmount: Minor;
  curve?: SpendCurve;
  /** Typical cycle totals from history, used to stabilise early-cycle projections. */
  historicalTotals?: readonly Minor[];
  /** Recurring charges due later this cycle that have not yet been paid. */
  upcomingCommitments?: Minor;
}

export interface VelocityResult {
  spentToDate: Minor;
  /** What should have been spent by now, given the reference amount and the curve. */
  expectedToDate: Minor;
  /** spentToDate − expectedToDate. Positive means overspending. */
  paceDelta: Minor;
  /** Percentage faster (+) or slower (−) than target pace. null when undefined. */
  pacePercent: number | null;
  status: PaceStatus;
  /** Projected total spend by the end of the cycle. */
  projectedTotal: Minor;
  /** projectedTotal − referenceAmount, clamped at zero. */
  projectedOverspend: Minor;
  /** referenceAmount − projectedTotal, clamped at zero. */
  projectedSurplus: Minor;
  averageDailySpend: Minor;
  /**
   * What can be spent per remaining day to land on the reference amount, AFTER
   * setting aside commitments still due. Spending this much every day is safe in the
   * sense the name claims — it does not quietly include the rent.
   */
  safeDailySpend: Minor;
  /** Reference amount not yet spent, clamped at zero. Ignores what is still owed. */
  remaining: Minor;
  /**
   * `remaining` less commitments still due this cycle — the money genuinely free to
   * decide about, and the basis for `safeDailySpend`.
   */
  spendable: Minor;
  method: ProjectionMethod;
  confidence: Confidence;
  daysRemaining: number;
}

/**
 * How much weight the observed pace gets versus the user's historical average total.
 * Early in a cycle a single large purchase dominates, so we lean on history; by the
 * end of the cycle the observed number IS the answer.
 */
function observationWeight(elapsedFraction: number): number {
  // Reaches ~0.5 at 25% elapsed and ~0.9 at 70% elapsed.
  return Math.min(1, Math.pow(Math.min(1, Math.max(0, elapsedFraction)), 0.6));
}

export function computeVelocity(input: VelocityInput): VelocityResult {
  const { progress, spentToDate, referenceAmount } = input;
  const curve = input.curve ?? LINEAR_CURVE;
  const historicalTotals = input.historicalTotals ?? [];
  const upcoming = input.upcomingCommitments ?? ZERO;

  const elapsed = progress.elapsedFraction;
  const expectedFraction = expectedFractionAt(curve, elapsed);
  const expectedToDate = scale(referenceAmount, expectedFraction);

  const paceDelta = sub(spentToDate, expectedToDate);
  const pacePercent = expectedToDate === 0 ? null : (paceDelta / expectedToDate) * 100;

  // --- Projection -----------------------------------------------------------
  // Curve projection: if this cycle is following the user's usual shape, the total
  // is what we have spent divided by the share of a cycle that shape says is done.
  const curveProjection =
    expectedFraction > 0.02 ? divide(spentToDate, expectedFraction) : ZERO;

  const historicalAverage =
    historicalTotals.length > 0
      ? divide(sum(historicalTotals as Minor[]), historicalTotals.length)
      : referenceAmount;

  let projectedRaw: Minor;
  let method: ProjectionMethod;

  if (expectedFraction <= 0.02) {
    // Effectively nothing has elapsed — the observation carries no information.
    projectedRaw = historicalAverage;
    method = historicalTotals.length > 0 ? 'historical_shape' : 'linear';
  } else if (historicalTotals.length === 0) {
    projectedRaw = curveProjection;
    method = curve.cyclesUsed > 0 ? 'historical_shape' : 'linear';
  } else {
    const w = observationWeight(elapsed);
    projectedRaw = fromMinor(Math.round(curveProjection * w + historicalAverage * (1 - w)));
    method = 'blended';
  }

  // A projection can never be lower than money already spent plus commitments that
  // are contractually due before the cycle ends.
  const floor = progress.isComplete ? spentToDate : (spentToDate + upcoming as Minor);
  const projectedTotal = fromMinor(Math.max(projectedRaw, floor));

  const remaining = clampAtZero(sub(referenceAmount, spentToDate));

  // What is genuinely available to DECIDE about: what is left, less what is already
  // owed before the cycle ends.
  //
  // `remaining` alone is the wrong basis for a daily allowance. Told they may spend
  // `remaining / daysRemaining` while rent is still due, a user who follows the advice
  // exactly overshoots by precisely the rent — and the number that misled them was
  // labelled "safe". `upcomingCommitments` was already accepted here and used only to
  // floor the projection, which left the one figure people act on ignoring it.
  const spendable = clampAtZero(sub(remaining, upcoming));
  const daysRemaining = progress.daysRemaining;

  return {
    spentToDate,
    expectedToDate,
    paceDelta,
    pacePercent,
    status: paceStatus(pacePercent, elapsed),
    projectedTotal,
    projectedOverspend: clampAtZero(sub(projectedTotal, referenceAmount)),
    projectedSurplus: clampAtZero(sub(referenceAmount, projectedTotal)),
    averageDailySpend: progress.daysElapsed > 0 ? divide(spentToDate, progress.daysElapsed) : ZERO,
    safeDailySpend: daysRemaining > 0 ? divide(spendable, daysRemaining) : spendable,
    remaining,
    spendable,
    method,
    confidence: confidenceOf(curve.cyclesUsed, historicalTotals.length, elapsed),
    daysRemaining,
  };
}

function paceStatus(pacePercent: number | null, elapsed: number): PaceStatus {
  if (pacePercent === null) return 'on_track';
  // Early in a cycle the ratio is noisy, so the thresholds are wider.
  const tolerance = elapsed < 0.25 ? 25 : elapsed < 0.5 ? 15 : 10;
  if (pacePercent > tolerance * 3) return 'critical';
  if (pacePercent > tolerance) return 'over';
  if (pacePercent < -tolerance) return 'under';
  return 'on_track';
}

function confidenceOf(curveCycles: number, historyCount: number, elapsed: number): Confidence {
  const history = Math.max(curveCycles, historyCount);
  if (history >= 3 && elapsed >= 0.2) return 'high';
  if (history >= 1 && elapsed >= 0.1) return 'medium';
  return 'low';
}

/** Daily spend series for the sparkline on the dashboard. */
export function dailySpendSeries(
  cycle: SalaryCycle,
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): Array<{ date: ISODate; amount: Minor; cumulative: Minor }> {
  const perDay = new Map<ISODate, number>();
  for (const t of transactions) {
    const s = spendOf(t, options);
    if (s === 0 || t.date < cycle.start || t.date > cycle.end) continue;
    perDay.set(t.date, (perDay.get(t.date) ?? 0) + s);
  }

  const out: Array<{ date: ISODate; amount: Minor; cumulative: Minor }> = [];
  let running = 0;
  for (let i = 0; i < cycle.totalDays; i++) {
    const date = addDays(cycle.start, i);
    const amount = perDay.get(date) ?? 0;
    running += amount;
    out.push({ date, amount: fromMinor(amount), cumulative: fromMinor(running) });
  }
  return out;
}
