/**
 * Portfolio value, return and allocation.
 *
 * The honesty problem in this module is different from the rest of the package. Every
 * other figure is derived from money that definitely moved; a portfolio's CURRENT
 * VALUE is a claim about the market, and this app has no market data feed. So a
 * holding's value is whatever the user last entered, carried with the date they
 * entered it — and anything that presents it says how old it is.
 *
 * Nothing here invents a price, interpolates one, or ages one forward.
 */

import { daysBetween, type ISODate } from './date';
import { ZERO, clampAtZero, fromMinor, percentage, sub, sum, type Minor } from './money';

// ---------------------------------------------------------------------------
// XIRR
// ---------------------------------------------------------------------------

export interface CashFlow {
  date: ISODate;
  /** Negative for money invested, positive for money returned. */
  amount: Minor;
}

/** Days in a year used to annualise. 365 matches how funds quote XIRR in India. */
const DAYS_PER_YEAR = 365;

const MAX_ITERATIONS = 80;
const PRECISION = 1e-7;

function netPresentValue(flows: readonly CashFlow[], rate: number, origin: ISODate): number {
  let total = 0;
  for (const flow of flows) {
    const years = daysBetween(origin, flow.date) / DAYS_PER_YEAR;
    total += (flow.amount as number) / Math.pow(1 + rate, years);
  }
  return total;
}

/**
 * Annualised return over irregular cash flows.
 *
 * Newton-Raphson, falling back to bisection when it wanders — which it does for
 * portfolios containing a large late contribution, where the derivative near the root
 * is small enough to throw the step somewhere useless.
 *
 * Returns null rather than a number whenever the question has no answer:
 *
 *   * fewer than two flows, or all flows the same sign. A return needs money to have
 *     gone out AND come back; "invested ₹50,000 and that is all that ever happened"
 *     has no rate, and 0% would be a lie about a portfolio that may have doubled.
 *   * no root inside a sane range. A rate of −99.99% or +1000% is a data-entry
 *     problem, and reporting it as a return dresses one up as an insight.
 */
export function xirr(flows: readonly CashFlow[]): number | null {
  if (flows.length < 2) return null;

  const hasNegative = flows.some((f) => (f.amount as number) < 0);
  const hasPositive = flows.some((f) => (f.amount as number) > 0);
  if (!hasNegative || !hasPositive) return null;

  const ordered = [...flows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const origin = ordered[0]!.date;

  // --- Newton-Raphson --------------------------------------------------------
  let rate = 0.1;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const value = netPresentValue(ordered, rate, origin);
    if (Math.abs(value) < PRECISION) return rate;

    let derivative = 0;
    for (const flow of ordered) {
      const years = daysBetween(origin, flow.date) / DAYS_PER_YEAR;
      derivative -= (years * (flow.amount as number)) / Math.pow(1 + rate, years + 1);
    }
    if (derivative === 0 || !Number.isFinite(derivative)) break;

    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < PRECISION) return next;
    rate = next;
  }

  // --- Bisection fallback ----------------------------------------------------
  let low = -0.9999;
  let high = 10;
  let lowValue = netPresentValue(ordered, low, origin);
  if (!Number.isFinite(lowValue)) return null;

  const highValue = netPresentValue(ordered, high, origin);
  // No sign change means no root in range; the inputs are outside anything a return
  // rate should describe.
  if (!Number.isFinite(highValue) || lowValue * highValue > 0) return null;

  for (let i = 0; i < MAX_ITERATIONS * 4; i++) {
    const mid = (low + high) / 2;
    const midValue = netPresentValue(ordered, mid, origin);
    if (Math.abs(midValue) < PRECISION || high - low < PRECISION) return mid;

    if (lowValue * midValue < 0) {
      high = mid;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

export type AssetKind =
  | 'mutual_fund' | 'stock' | 'gold' | 'fixed_deposit' | 'ppf' | 'epf' | 'bond' | 'cash' | 'other';

export interface HoldingValuation {
  id: string;
  name: string;
  kind: AssetKind;
  /** What went in, net of anything taken out. */
  invested: Minor;
  /** What the user last said it is worth. */
  currentValue: Minor;
  /** When they said it. Null when never valued. */
  valueAsOf: ISODate | null;
  gain: Minor;
  /** Simple return on cost, 0–100+. Null when nothing was invested. */
  gainPercent: number | null;
}

export interface HoldingInput {
  id: string;
  name: string;
  kind: AssetKind;
  invested: Minor;
  currentValue: Minor;
  valueAsOf: ISODate | null;
}

export function valueHolding(input: HoldingInput): HoldingValuation {
  const gain = sub(input.currentValue, input.invested);
  return {
    ...input,
    gain,
    gainPercent: percentage(gain, input.invested),
  };
}

export interface AllocationSlice {
  kind: AssetKind;
  value: Minor;
  /** Share of the portfolio, 0–100. */
  share: number;
  count: number;
}

/**
 * Allocation by asset kind, largest first.
 *
 * Shares are of the TOTAL VALUED portfolio. A holding never given a value contributes
 * nothing — see `unvaluedCount` on the summary, which is what stops "equity is 100% of
 * your portfolio" being said about someone whose other holdings simply have no figure
 * against them yet.
 */
export function allocationByKind(holdings: readonly HoldingValuation[]): AllocationSlice[] {
  const totals = new Map<AssetKind, { value: number; count: number }>();

  for (const h of holdings) {
    const existing = totals.get(h.kind) ?? { value: 0, count: 0 };
    existing.value += h.currentValue as number;
    existing.count += 1;
    totals.set(h.kind, existing);
  }

  const total = [...totals.values()].reduce((acc, t) => acc + t.value, 0);

  return [...totals.entries()]
    .map(([kind, t]) => ({
      kind,
      value: fromMinor(t.value),
      share: total > 0 ? (t.value / total) * 100 : 0,
      count: t.count,
    }))
    .sort((a, b) => (b.value as number) - (a.value as number));
}

export interface PortfolioSummary {
  totalValue: Minor;
  totalInvested: Minor;
  totalGain: Minor;
  gainPercent: number | null;
  allocation: AllocationSlice[];
  /** Annualised return across every holding's cash flows. Null when unanswerable. */
  xirr: number | null;
  holdingCount: number;
  /** Holdings with no value recorded. They contribute nothing and are counted here. */
  unvaluedCount: number;
  /** The oldest valuation date in the portfolio — how stale the total really is. */
  oldestValuation: ISODate | null;
}

export interface PortfolioInput {
  holdings: readonly HoldingValuation[];
  /**
   * Every contribution and withdrawal across the portfolio, plus a final positive flow
   * for the current value. The caller assembles it, because only it knows which
   * valuations are recent enough to close the series with.
   */
  cashFlows: readonly CashFlow[];
}

export function summarisePortfolio(input: PortfolioInput): PortfolioSummary {
  const valued = input.holdings.filter((h) => (h.currentValue as number) > 0);

  const totalValue = sum(input.holdings.map((h) => h.currentValue));
  const totalInvested = sum(input.holdings.map((h) => h.invested));
  const totalGain = sub(totalValue, totalInvested);

  const dates = valued.map((h) => h.valueAsOf).filter((d): d is ISODate => d !== null);

  return {
    totalValue,
    totalInvested,
    totalGain,
    gainPercent: percentage(totalGain, totalInvested),
    allocation: allocationByKind(input.holdings),
    xirr: xirr(input.cashFlows),
    holdingCount: input.holdings.length,
    unvaluedCount: input.holdings.length - valued.length,
    oldestValuation: dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : null,
  };
}

/**
 * How stale a valuation is, in days. Null when it was never valued.
 *
 * Exposed so the UI can say it. A portfolio total presented without this is a claim
 * about today built from numbers that might be a year old.
 */
export function valuationAgeDays(valueAsOf: ISODate | null, today: ISODate): number | null {
  if (valueAsOf === null) return null;
  return clampAtZero(fromMinor(daysBetween(valueAsOf, today))) as number;
}

export { ZERO as PORTFOLIO_ZERO };
