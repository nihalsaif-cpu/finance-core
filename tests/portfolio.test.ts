import { describe, expect, it } from 'vitest';
import {
  allocationByKind, fromMajor, summarisePortfolio, valuationAgeDays, valueHolding, xirr, ZERO,
} from '../src/index';

const flow = (date: string, major: string) => ({ date, amount: fromMajor(major) });

describe('xirr', () => {
  it('returns 10% for money that grew a tenth over exactly one year', () => {
    const rate = xirr([flow('2025-01-01', '-100000'), flow('2026-01-01', '110000')]);
    expect(rate).toBeCloseTo(0.10, 4);
  });

  it('annualises a half-year gain rather than reporting the raw one', () => {
    // +10% over six months is ~21% a year, not 10%. Reporting the raw figure would
    // flatter every short holding in the portfolio.
    const rate = xirr([flow('2025-01-01', '-100000'), flow('2025-07-02', '110000')]);
    expect(rate).toBeCloseTo(0.21, 2);
  });

  it('handles a SIP — many irregular contributions and one exit', () => {
    const flows = [
      flow('2024-01-01', '-10000'), flow('2024-02-01', '-10000'), flow('2024-03-01', '-10000'),
      flow('2024-04-01', '-10000'), flow('2024-05-01', '-10000'), flow('2024-06-01', '-10000'),
      flow('2025-01-01', '65000'),
    ];
    const rate = xirr(flows);
    expect(rate).not.toBeNull();
    // 60,000 in, 65,000 out within about a year — a solidly positive but sane rate.
    expect(rate!).toBeGreaterThan(0.05);
    expect(rate!).toBeLessThan(0.40);
  });

  it('reports a loss as a negative rate', () => {
    const rate = xirr([flow('2025-01-01', '-100000'), flow('2026-01-01', '80000')]);
    expect(rate).toBeCloseTo(-0.20, 3);
  });

  it('refuses to answer when money only ever went in', () => {
    // "Invested ₹50,000 and that is all that happened" has no rate. Returning 0%
    // would be a lie about a portfolio that may have doubled.
    expect(xirr([flow('2025-01-01', '-50000'), flow('2025-06-01', '-50000')])).toBeNull();
  });

  it('refuses a single flow', () => {
    expect(xirr([flow('2025-01-01', '-50000')])).toBeNull();
    expect(xirr([])).toBeNull();
  });

  it('is unaffected by the order flows are supplied in', () => {
    const forward = xirr([flow('2025-01-01', '-100000'), flow('2026-01-01', '110000')]);
    const backward = xirr([flow('2026-01-01', '110000'), flow('2025-01-01', '-100000')]);
    expect(forward).toBeCloseTo(backward!, 8);
  });
});

describe('valueHolding', () => {
  it('reports gain and its percentage against cost', () => {
    const h = valueHolding({
      id: 'a', name: 'Index fund', kind: 'mutual_fund',
      invested: fromMajor('100000'), currentValue: fromMajor('125000'), valueAsOf: '2026-09-01',
    });
    expect(h.gain).toBe(fromMajor('25000'));
    expect(h.gainPercent).toBeCloseTo(25, 6);
  });

  it('reports a loss as a negative gain rather than clamping it', () => {
    const h = valueHolding({
      id: 'b', name: 'Small cap', kind: 'stock',
      invested: fromMajor('100000'), currentValue: fromMajor('80000'), valueAsOf: '2026-09-01',
    });
    expect(h.gain).toBe(fromMajor('-20000'));
    expect(h.gainPercent).toBeCloseTo(-20, 6);
  });
});

describe('allocationByKind', () => {
  const holdings = [
    valueHolding({ id: '1', name: 'Fund', kind: 'mutual_fund', invested: fromMajor('100000'), currentValue: fromMajor('150000'), valueAsOf: '2026-09-01' }),
    valueHolding({ id: '2', name: 'Shares', kind: 'stock', invested: fromMajor('50000'), currentValue: fromMajor('50000'), valueAsOf: '2026-09-01' }),
  ];

  it('shares sum to 100 and the largest comes first', () => {
    const slices = allocationByKind(holdings);
    expect(slices[0]!.kind).toBe('mutual_fund');
    expect(slices.reduce((acc, s) => acc + s.share, 0)).toBeCloseTo(100, 6);
  });

  it('does not divide by zero for a portfolio with no value', () => {
    const none = allocationByKind([
      valueHolding({ id: '3', name: 'Untracked', kind: 'gold', invested: ZERO, currentValue: ZERO, valueAsOf: null }),
    ]);
    expect(none[0]!.share).toBe(0);
  });
});

describe('summarisePortfolio', () => {
  const holdings = [
    valueHolding({ id: '1', name: 'Fund', kind: 'mutual_fund', invested: fromMajor('100000'), currentValue: fromMajor('150000'), valueAsOf: '2026-03-01' }),
    valueHolding({ id: '2', name: 'Gold', kind: 'gold', invested: fromMajor('50000'), currentValue: ZERO, valueAsOf: null }),
  ];

  const summary = summarisePortfolio({
    holdings,
    cashFlows: [flow('2025-01-01', '-100000'), flow('2026-03-01', '150000')],
  });

  it('counts holdings that have never been valued rather than hiding them', () => {
    // Without this the app says "mutual funds are 100% of your portfolio" to someone
    // whose gold simply has no figure against it yet.
    expect(summary.unvaluedCount).toBe(1);
    expect(summary.holdingCount).toBe(2);
  });

  it('reports the oldest valuation, which is how stale the total really is', () => {
    expect(summary.oldestValuation).toBe('2026-03-01');
  });

  it('still counts unvalued money as invested', () => {
    // The 50,000 of gold was really spent, even though its worth is unknown.
    expect(summary.totalInvested).toBe(fromMajor('150000'));
  });
});

describe('valuationAgeDays', () => {
  it('says how old a valuation is', () => {
    expect(valuationAgeDays('2026-09-01', '2026-09-09')).toBe(8);
  });

  it('is null when never valued, not zero', () => {
    // Zero would read as "valued today", which is the opposite of the truth.
    expect(valuationAgeDays(null, '2026-09-09')).toBeNull();
  });
});
