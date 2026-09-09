import { describe, it, expect } from 'vitest';
import { buildTrend, buildWaterfall, concentration, movers } from '../src/exhibits';
import { fromMajor, ZERO } from '../src/money';
import { rs } from './helpers/factory';
import type { Rollup } from '../src/analytics';

const split = (essential: string, discretionary: string) => ({
  essential: fromMajor(essential),
  discretionary: fromMajor(discretionary),
  total: fromMajor(String(Number(essential) + Number(discretionary))),
  essentialShare: null,
  discretionaryShare: null,
});

describe('buildWaterfall', () => {
  it('bridges income down to what is left', () => {
    const w = buildWaterfall({
      income: fromMajor('75000'),
      split: split('30000', '20000'),
      invested: fromMajor('10000'),
    });
    expect(w.net).toBe(rs(15000));
    expect(w.steps.map((s) => s.key)).toEqual(['income', 'essential', 'discretionary', 'invested', 'left']);
  });

  it('makes each step start where the previous one ended', () => {
    const w = buildWaterfall({
      income: fromMajor('75000'),
      split: split('30000', '20000'),
      invested: ZERO,
    });
    const essentials = w.steps.find((s) => s.key === 'essential')!;
    const everyday = w.steps.find((s) => s.key === 'discretionary')!;
    expect(essentials.from).toBe(rs(75000));
    expect(essentials.to).toBe(rs(45000));
    expect(everyday.from).toBe(essentials.to);
    expect(everyday.to).toBe(rs(25000));
  });

  it('drops a step with no money in it rather than drawing an empty bar', () => {
    const w = buildWaterfall({ income: fromMajor('50000'), split: split('20000', '10000'), invested: ZERO });
    expect(w.steps.some((s) => s.key === 'invested')).toBe(false);
  });

  it('reports a negative balance rather than clamping it to zero', () => {
    const w = buildWaterfall({
      income: fromMajor('20000'),
      split: split('18000', '9000'),
      invested: ZERO,
    });
    expect(w.net).toBeLessThan(0);
    expect(w.steps.at(-1)!.to).toBeLessThan(0);
  });

  it('spends outflows as negative deltas', () => {
    const w = buildWaterfall({ income: fromMajor('50000'), split: split('20000', '10000'), invested: ZERO });
    expect(w.steps.find((s) => s.key === 'essential')!.delta).toBe(rs(-20000));
  });
});

const roll = (key: string, amount: string, share = 0): Rollup => ({
  key, label: key, amount: fromMajor(amount), count: 1, share,
});

describe('concentration', () => {
  it('counts how few entries reach the threshold', () => {
    const c = concentration([roll('a', '5000'), roll('b', '3000'), roll('c', '1000'), roll('d', '1000')]);
    expect(c.count).toBe(2);
    expect(c.share).toBeCloseTo(80, 5);
  });

  it('reports low concentration when spending is spread evenly', () => {
    const even = Array.from({ length: 10 }, (_, i) => roll(`m${i}`, '1000'));
    expect(concentration(even).count).toBe(8);
  });

  it('handles an empty set without dividing by zero', () => {
    expect(concentration([])).toEqual({ count: 0, share: 0, top: [], totalEntries: 0 });
  });

  it('does not care what order it is given', () => {
    const ascending = [roll('c', '1000'), roll('a', '5000'), roll('b', '3000')];
    expect(concentration(ascending).top[0]!.key).toBe('a');
  });
});

const cycle = (start: string, label: string) => ({
  start, end: start, label, payday: start, index: 0,
}) as never;

const trendPoint = (start: string, label: string, spend: string) => ({
  cycle: cycle(start, label),
  spend: fromMajor(spend),
  income: fromMajor('75000'),
  savings: ZERO,
  savingsRate: null,
  essential: ZERO,
  discretionary: ZERO,
});

describe('buildTrend', () => {
  const points = [
    trendPoint('2026-05-01', 'May', '40000'),
    trendPoint('2026-06-01', 'Jun', '50000'),
    trendPoint('2026-07-01', 'Jul', '60000'),
    trendPoint('2026-08-01', 'Aug', '10000'),
  ];

  it('marks the running cycle as partial', () => {
    const t = buildTrend(points, '2026-08-01');
    expect(t.points.at(-1)!.isPartial).toBe(true);
    expect(t.points[0]!.isPartial).toBe(false);
  });

  it('excludes the partial cycle from the comparable average', () => {
    const t = buildTrend(points, '2026-08-01');
    // (40 + 50 + 60) / 3 = 50k, not (40+50+60+10)/4 = 40k.
    expect(t.comparableAverage).toBe(rs(50000));
    expect(t.average).toBe(rs(40000));
  });

  it('does not read a rising trend as falling because the month just started', () => {
    const t = buildTrend(points, '2026-08-01');
    expect(t.slopePerCycle).toBeGreaterThan(0);
  });

  it('scales heights against the series peak', () => {
    const t = buildTrend(points, '2026-08-01');
    expect(t.peak).toBe(rs(60000));
    expect(t.points[2]!.height).toBeCloseTo(1, 5);
    expect(t.points[0]!.height).toBeCloseTo(40 / 60, 5);
  });

  it('returns an empty series rather than throwing on no history', () => {
    expect(buildTrend([], null).points).toEqual([]);
  });

  it('reports no slope from a single comparable cycle', () => {
    expect(buildTrend([points[0]!], null).slopePerCycle).toBe(0);
  });
});

describe('movers', () => {
  const current = [roll('food', '12000'), roll('rent', '25000'), roll('travel', '2000')];
  const baseline = [roll('food', '5000'), roll('rent', '25000'), roll('travel', '4000')];

  it('ranks what went up', () => {
    const m = movers(current, baseline);
    expect(m.risers[0]!.key).toBe('food');
    expect(m.risers[0]!.delta).toBe(rs(7000));
  });

  it('ranks what went down separately', () => {
    const m = movers(current, baseline);
    expect(m.fallers[0]!.key).toBe('travel');
    expect(m.fallers[0]!.delta).toBe(rs(-2000));
  });

  it('ignores a category that did not move', () => {
    const m = movers(current, baseline);
    expect([...m.risers, ...m.fallers].some((x) => x.key === 'rent')).toBe(false);
  });

  it('attributes each line a share of the total change', () => {
    const m = movers(current, baseline);
    expect(m.totalChange).toBe(rs(5000));
    // Food rose 7,000 against a net change of 5,000 — it more than explains it.
    expect(m.risers[0]!.contributionToChange).toBeCloseTo(140, 5);
  });

  it('reports zero attribution rather than infinity when the net change is nil', () => {
    const a = [roll('food', '10000'), roll('travel', '2000')];
    const b = [roll('food', '2000'), roll('travel', '10000')];
    const m = movers(a, b);
    expect(m.totalChange).toBe(0);
    expect(m.risers[0]!.contributionToChange).toBe(0);
  });

  it('counts a category that appeared from nothing', () => {
    const m = movers([roll('new', '3000')], []);
    expect(m.risers[0]!.baseline).toBe(0);
    expect(m.risers[0]!.delta).toBe(rs(3000));
  });

  it('counts a category that disappeared', () => {
    const m = movers([], [roll('gone', '3000')]);
    expect(m.fallers[0]!.current).toBe(0);
    expect(m.fallers[0]!.delta).toBe(rs(-3000));
  });
});

import {
  concentrationFinding, moversFinding, trendFinding, waterfallFinding,
} from '../src/exhibits';
import { format } from '../src/money';

const opts = { currency: 'INR', money: (v: never) => format(v, { currency: 'INR' }) } as never;

describe('waterfallFinding', () => {
  it('leads with the overspend when the balance is negative', () => {
    const w = buildWaterfall({ income: fromMajor('20000'), split: split('18000', '9000'), invested: ZERO });
    expect(waterfallFinding(w, fromMajor('20000'), true, opts)).toMatch(/past your income/i);
    expect(waterfallFinding(w, fromMajor('20000'), true, opts)).toContain('7,000');
  });

  it('says "so far" while the cycle is still running', () => {
    const w = buildWaterfall({ income: fromMajor('75000'), split: split('30000', '20000'), invested: ZERO });
    expect(waterfallFinding(w, fromMajor('75000'), false, opts)).toMatch(/so far/);
    expect(waterfallFinding(w, fromMajor('75000'), true, opts)).not.toMatch(/so far/);
  });

  it('gives the share of income kept', () => {
    const w = buildWaterfall({ income: fromMajor('100000'), split: split('50000', '25000'), invested: ZERO });
    expect(waterfallFinding(w, fromMajor('100000'), true, opts)).toContain('25%');
  });

  it('flags when there is no income recorded rather than dividing by zero', () => {
    const w = buildWaterfall({ income: ZERO, split: split('0', '0'), invested: ZERO });
    expect(waterfallFinding(w, ZERO, true, opts)).toMatch(/no income/i);
  });
});

describe('trendFinding', () => {
  const points = [
    trendPoint('2026-05-01', 'May', '40000'),
    trendPoint('2026-06-01', 'Jun', '50000'),
    trendPoint('2026-07-01', 'Jul', '60000'),
  ];

  it('calls a real climb', () => {
    expect(trendFinding(buildTrend(points, null), opts)).toMatch(/climbing/i);
  });

  it('calls a real fall', () => {
    expect(trendFinding(buildTrend([...points].reverse(), null), opts)).toMatch(/falling/i);
  });

  it('does not call a small wobble a trend', () => {
    const flat = [
      trendPoint('2026-05-01', 'May', '50000'),
      trendPoint('2026-06-01', 'Jun', '50200'),
      trendPoint('2026-07-01', 'Jul', '50300'),
    ];
    expect(trendFinding(buildTrend(flat, null), opts)).toMatch(/steady/i);
  });

  it('refuses to call a trend from one cycle', () => {
    expect(trendFinding(buildTrend([points[0]!], null), opts)).toMatch(/not enough/i);
  });
});

describe('moversFinding', () => {
  it('names the biggest contributor and its share', () => {
    const result = movers([roll('food', '10000'), roll('rent', '25000')], [roll('food', '5000'), roll('rent', '25000')]);
    const text = moversFinding(result, opts);
    expect(text).toMatch(/food/);
    expect(text).toMatch(/100%/);
  });

  it('explains rather than quoting an over-100% share', () => {
    const result = movers(
      [roll('food', '12000'), roll('travel', '2000')],
      [roll('food', '5000'), roll('travel', '4000')],
    );
    const text = moversFinding(result, opts);
    expect(text).toMatch(/other categories pulled the other way/i);
    expect(text).not.toMatch(/1\d\d%/);
  });

  it('handles a flat total where individual lines still moved', () => {
    const result = movers([roll('a', '10000'), roll('b', '2000')], [roll('a', '2000'), roll('b', '10000')]);
    expect(moversFinding(result, opts)).toMatch(/held flat/i);
  });

  it('says so when nothing moved', () => {
    expect(moversFinding(movers([roll('a', '100')], [roll('a', '100')]), opts)).toMatch(/nothing moved/i);
  });
});

describe('concentrationFinding', () => {
  it('names a single dominant entry', () => {
    const text = concentrationFinding(concentration([roll('rent', '9000'), roll('tea', '100')]));
    expect(text).toMatch(/one category/i);
    expect(text).toMatch(/rent/);
  });

  it('reports thin spread when most entries are needed to reach the threshold', () => {
    // Ten equal categories: it takes eight of them to reach 80%. No single lever.
    const even = Array.from({ length: 10 }, (_, i) => roll(`m${i}`, '1000'));
    const text = concentrationFinding(concentration(even));
    expect(text).toMatch(/spread thin/i);
    expect(text).toMatch(/no single lever/i);
  });

  it('reports a lever when a few entries dominate a long tail', () => {
    const skewed = [roll('rent', '50000'), roll('food', '20000'), ...Array.from({ length: 12 }, (_, i) => roll(`m${i}`, '1000'))];
    const text = concentrationFinding(skewed.length ? concentration(skewed) : concentration([]));
    expect(text).toMatch(/of your 14 categories/);
    expect(text).not.toMatch(/spread thin/i);
  });

  it('uses the singular when one entry dominates', () => {
    const c = concentration([roll('a', '8000'), roll('b', '1000'), roll('c', '1000')]);
    expect(concentrationFinding(c, 'merchants')).toMatch(/one merchant/i);
  });

  it('uses the plural noun when several entries are named', () => {
    const c = concentration([roll('a', '4000'), roll('b', '4000'), ...Array.from({ length: 8 }, (_, i) => roll(`t${i}`, '250'))]);
    expect(concentrationFinding(c, 'merchants')).toMatch(/merchants/);
  });

  it('says so when there is nothing to break down', () => {
    expect(concentrationFinding(concentration([]))).toMatch(/nothing recorded/i);
  });
});
