import { describe, it, expect } from 'vitest';
import * as V from '../src/velocity';
import { cycleContaining, cycleProgress, type CycleConfig } from '../src/cycle';
import { fromMajor, toMajorNumber } from '../src/money';
import { txns, rs } from './helpers/factory';

const monthly: CycleConfig = { startDay: 1, frequency: 'monthly' };
const augustCycle = cycleContaining('2026-08-15', monthly); // 31 days
const progressAt = (day: number) => cycleProgress(augustCycle, `2026-08-${String(day).padStart(2, '0')}`);

describe('computeVelocity — the worked example from the brief', () => {
  it('flags spending ahead of the target pace', () => {
    // Salary 75,000; day 15 of 30-ish; spent 46,200 against an expected ~37,500.
    const thirtyDay = cycleContaining('2026-09-15', monthly); // 30 days
    const progress = cycleProgress(thirtyDay, '2026-09-15');
    const result = V.computeVelocity({
      progress,
      spentToDate: fromMajor('46200'),
      referenceAmount: fromMajor('75000'),
    });

    expect(result.expectedToDate).toBe(fromMajor('37500'));
    expect(result.paceDelta).toBe(fromMajor('8700'));
    expect(result.pacePercent).toBeCloseTo(23.2, 1);
    expect(result.status).toBe('over');
  });

  it('projects the month-end total and the resulting shortfall', () => {
    const thirtyDay = cycleContaining('2026-09-15', monthly);
    const result = V.computeVelocity({
      progress: cycleProgress(thirtyDay, '2026-09-15'),
      spentToDate: fromMajor('46200'),
      referenceAmount: fromMajor('75000'),
    });
    // Linear, with no history: 46,200 × 30/15 = 92,400.
    expect(result.projectedTotal).toBe(fromMajor('92400'));
    expect(result.projectedOverspend).toBe(fromMajor('17400'));
    expect(result.projectedSurplus).toBe(0);
    expect(result.method).toBe('linear');
  });
});

describe('computeVelocity — derived figures', () => {
  it('computes average daily spend and a safe daily allowance', () => {
    const result = V.computeVelocity({
      progress: progressAt(10),
      spentToDate: fromMajor('20000'),
      referenceAmount: fromMajor('62000'),
    });
    expect(result.averageDailySpend).toBe(fromMajor('2000'));
    // 42,000 left over 21 remaining days.
    expect(result.remaining).toBe(fromMajor('42000'));
    expect(result.safeDailySpend).toBe(fromMajor('2000'));
  });

  it('never reports a negative remaining balance', () => {
    const result = V.computeVelocity({
      progress: progressAt(20),
      spentToDate: fromMajor('90000'),
      referenceAmount: fromMajor('75000'),
    });
    expect(result.remaining).toBe(0);
    expect(result.safeDailySpend).toBe(0);
    expect(result.status).toBe('critical');
  });

  it('does not divide by zero on the first day or a zero reference', () => {
    const day1 = V.computeVelocity({
      progress: progressAt(1),
      spentToDate: fromMajor('500'),
      referenceAmount: fromMajor('75000'),
    });
    expect(Number.isFinite(day1.projectedTotal)).toBe(true);
    expect(day1.confidence).toBe('low');

    const noBudget = V.computeVelocity({
      progress: progressAt(15),
      spentToDate: fromMajor('500'),
      referenceAmount: fromMajor('0'),
    });
    expect(noBudget.pacePercent).toBeNull();
    expect(noBudget.status).toBe('on_track');
  });

  it('treats a completed cycle as final rather than projecting past it', () => {
    const past = cycleContaining('2026-07-10', monthly);
    const result = V.computeVelocity({
      progress: cycleProgress(past, '2026-08-26'),
      spentToDate: fromMajor('50000'),
      referenceAmount: fromMajor('75000'),
    });
    expect(result.projectedTotal).toBe(fromMajor('50000'));
    expect(result.daysRemaining).toBe(0);
  });

  it('widens the tolerance early in a cycle so day-2 rent does not read as a crisis', () => {
    // 20% of the reference spent on day 2 of 31 — huge in linear terms.
    const early = V.computeVelocity({
      progress: progressAt(2),
      spentToDate: fromMajor('15000'),
      referenceAmount: fromMajor('75000'),
    });
    // Still flagged, but the threshold for 'critical' is 3x the wider early tolerance.
    expect(['over', 'critical']).toContain(early.status);
    expect(early.confidence).toBe('low');
  });

  it('never projects below money already spent plus committed charges', () => {
    const result = V.computeVelocity({
      progress: progressAt(28),
      spentToDate: fromMajor('30000'),
      referenceAmount: fromMajor('75000'),
      upcomingCommitments: fromMajor('12000'),
    });
    expect(result.projectedTotal).toBeGreaterThanOrEqual(fromMajor('42000'));
  });
});

describe('spend curve', () => {
  const config = monthly;

  it('learns that spending is front-loaded and adjusts the projection down', () => {
    // A cycle where 60% of spending lands on day 1 (rent), then a steady trickle.
    const july = cycleContaining('2026-07-10', config);
    const frontLoaded = txns([
      { date: '2026-07-01', amount: '30000' },
      ...Array.from({ length: 20 }, (_, i) => ({
        date: `2026-07-${String(i + 6).padStart(2, '0')}`,
        amount: '1000',
      })),
    ]);
    const history = V.cycleSpendHistory(july, frontLoaded);
    expect(history).not.toBeNull();
    expect(history!.total).toBe(fromMajor('50000'));
    // By 20% into the cycle, well over 20% has been spent.
    expect(V.expectedFractionAt(V.buildSpendCurve([history!]), 0.2)).toBeGreaterThan(0.5);

    const curve = V.buildSpendCurve([history!]);
    const august = cycleContaining('2026-08-07', config);
    const withHistory = V.computeVelocity({
      progress: cycleProgress(august, '2026-08-07'),
      spentToDate: fromMajor('30000'),
      referenceAmount: fromMajor('75000'),
      curve,
    });
    const linear = V.computeVelocity({
      progress: cycleProgress(august, '2026-08-07'),
      spentToDate: fromMajor('30000'),
      referenceAmount: fromMajor('75000'),
    });
    // Linear says "you'll spend 1.3 lakh"; the shape-aware model knows rent is paid.
    expect(withHistory.projectedTotal).toBeLessThan(linear.projectedTotal);
    expect(withHistory.method).toBe('historical_shape');
  });

  it('produces a monotonic curve pinned at 0 and 1', () => {
    const july = cycleContaining('2026-07-10', config);
    const history = V.cycleSpendHistory(
      july,
      txns([
        { date: '2026-07-02', amount: '1000' },
        { date: '2026-07-20', amount: '4000' },
      ]),
    )!;
    const curve = V.buildSpendCurve([history, history]);
    expect(curve.fractions[0]).toBe(0);
    expect(curve.fractions[curve.fractions.length - 1]).toBe(1);
    for (let i = 1; i < curve.fractions.length; i++) {
      expect(curve.fractions[i]!).toBeGreaterThanOrEqual(curve.fractions[i - 1]!);
    }
  });

  it('falls back to a linear curve with no usable history', () => {
    expect(V.buildSpendCurve([])).toBe(V.LINEAR_CURVE);
    const empty = cycleContaining('2026-07-10', config);
    expect(V.cycleSpendHistory(empty, [])).toBeNull();
  });

  it('blends toward the historical average early in the cycle', () => {
    // Day 2, almost nothing spent yet, but this user always spends ~60,000.
    const result = V.computeVelocity({
      progress: progressAt(2),
      spentToDate: fromMajor('500'),
      referenceAmount: fromMajor('75000'),
      historicalTotals: [fromMajor('60000'), fromMajor('62000'), fromMajor('58000')],
    });
    // A pure linear read would project ~7,750; history says that is not credible.
    expect(toMajorNumber(result.projectedTotal)).toBeGreaterThan(40000);
    expect(result.method).toBe('blended');
  });

  it('lets the observation dominate late in the cycle', () => {
    const result = V.computeVelocity({
      progress: progressAt(30),
      spentToDate: fromMajor('20000'),
      referenceAmount: fromMajor('75000'),
      historicalTotals: [fromMajor('60000'), fromMajor('62000'), fromMajor('58000')],
    });
    // Nearly the whole cycle is observed; history should barely move the answer.
    expect(toMajorNumber(result.projectedTotal)).toBeLessThan(28000);
    expect(result.confidence).toBe('high');
  });
});

describe('dailySpendSeries', () => {
  it('produces one point per cycle day with a running cumulative', () => {
    const cycle = cycleContaining('2026-08-15', monthly);
    const series = V.dailySpendSeries(
      cycle,
      txns([
        { date: '2026-08-01', amount: '1000' },
        { date: '2026-08-01', amount: '500' },
        { date: '2026-08-03', amount: '250' },
        { date: '2026-09-05', amount: '9999' }, // outside the cycle
      ]),
    );
    expect(series).toHaveLength(31);
    expect(series[0]).toMatchObject({ date: '2026-08-01', amount: rs(1500), cumulative: rs(1500) });
    expect(series[1]!.amount).toBe(0);
    expect(series[2]!.cumulative).toBe(rs(1750));
    expect(series[30]!.cumulative).toBe(rs(1750));
  });
});
