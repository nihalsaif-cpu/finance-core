import { describe, it, expect } from 'vitest';
import { buildMonthlyReport, reportToText } from '../src/report';
import { buildCycleSnapshot } from '../src/analytics';
import { cycleContaining, cycleProgress } from '../src/cycle';
import { format, fromMajor, ZERO } from '../src/money';
import { categoryIndex, cat } from './helpers/categories';
import { txns, rs } from './helpers/factory';
import type { BudgetEvaluation } from '../src/analytics';

const CFG = { startDay: 1, frequency: 'monthly' as const };
const CYCLE = cycleContaining('2026-08-15', CFG);
const money = (v: never) => format(v, { currency: 'INR' });

const ROWS = txns([
  { date: '2026-08-01', amount: '55000', kind: 'income', categoryId: cat('salary'), merchantKey: 'acme' },
  { date: '2026-08-02', amount: '15000', categoryId: cat('rent'), merchantKey: 'landlord', merchantName: 'Landlord' },
  { date: '2026-08-11', amount: '2400', categoryId: cat('groceries'), merchantKey: 'more', merchantName: 'More' },
  { date: '2026-08-11', amount: '900', categoryId: cat('restaurants'), merchantKey: 'empire', merchantName: 'Empire' },
  { date: '2026-08-20', amount: '1200', categoryId: cat('fuel'), merchantKey: 'hp', merchantName: 'HP' },
]);

const PREVIOUS = txns([
  { date: '2026-07-05', amount: '14000', categoryId: cat('rent'), merchantKey: 'landlord' },
]);

const budget = (over: Partial<BudgetEvaluation>): BudgetEvaluation => ({
  categoryId: 'c', label: 'Food', budget: fromMajor('5000'), spent: fromMajor('3300'),
  remaining: fromMajor('1700'), percentUsed: 66, projected: fromMajor('4000'),
  projectedOverspend: ZERO, status: 'healthy', ...over,
});

const build = (over: Partial<Parameters<typeof buildMonthlyReport>[0]> = {}) => {
  const transactions = over.transactions ?? ROWS;
  return buildMonthlyReport({
    cycle: CYCLE,
    snapshot: buildCycleSnapshot({
      cycle: CYCLE,
      progress: cycleProgress(CYCLE, '2026-08-31'),
      transactions,
      categories: categoryIndex,
      expectedIncome: ZERO,
    }),
    transactions,
    previous: PREVIOUS,
    categories: categoryIndex,
    budgets: [],
    money: money as never,
    ...over,
  });
};

describe('buildMonthlyReport', () => {
  it('totals the cycle', () => {
    const r = build();
    expect(r.income).toBe(rs(55000));
    expect(r.spent).toBe(rs(19500));
    expect(r.saved).toBe(rs(35500));
  });

  it('leads with what was kept', () => {
    expect(build().headline).toMatch(/kept ₹35,500 of ₹55,000 — 65%/);
  });

  it('says so plainly when nothing was earned', () => {
    const noIncome = ROWS.filter((t) => t.kind !== 'income');
    expect(build({ transactions: noIncome }).headline).toMatch(/spent.*across 4 payments/i);
  });

  it('handles an empty cycle without inventing a story', () => {
    expect(build({ transactions: [] }).headline).toBe('Nothing was recorded this cycle.');
  });

  it('reports the change against last cycle', () => {
    const r = build();
    expect(r.change).toBe(rs(5500));
    expect(r.findings.some((f) => /more than last cycle/.test(f.text))).toBe(true);
  });

  it('does not compare against a cycle with no data', () => {
    // "Up 100%" against nothing is true and meaningless.
    const r = build({ previous: [] });
    expect(r.findings.some((f) => /last cycle/.test(f.text))).toBe(false);
  });

  it('names the biggest single payment', () => {
    expect(build().biggest?.amount).toBe(rs(15000));
    expect(build().findings.some((f) => /Landlord/.test(f.text))).toBe(true);
  });

  it('finds the heaviest day by money, not by number of payments', () => {
    // The 11th had two payments; the 2nd had one worth five times as much. The day a
    // report should mention is the one the money went out on.
    expect(build().busiestDay).toEqual({ date: '2026-08-02', total: rs(15000) });
  });

  it('sums a day with several payments', () => {
    const sameDay = txns([
      { date: '2026-08-11', amount: '2400', categoryId: cat('groceries'), merchantKey: 'more' },
      { date: '2026-08-11', amount: '900', categoryId: cat('restaurants'), merchantKey: 'empire' },
    ]);
    expect(build({ transactions: sameDay }).busiestDay).toEqual({ date: '2026-08-11', total: rs(3300) });
  });

  it('averages across the whole cycle, not the days with spending', () => {
    // ₹19,500 over 31 days.
    expect(build().dailyAverage).toBe(rs(19500 / 31));
  });

  it('counts only spending transactions', () => {
    expect(build().transactionCount).toBe(4);
  });

  it('congratulates a clean month', () => {
    const r = build({ budgets: [budget({}), budget({ categoryId: 'd' })] });
    expect(r.budgetsKept).toBe(2);
    expect(r.findings[0]!.tone).toBe('good');
    expect(r.findings[0]!.text).toMatch(/held/);
  });

  it('leads with blown budgets over anything else', () => {
    const r = build({ budgets: [budget({ status: 'over_budget' }), budget({ categoryId: 'd' })] });
    expect(r.findings[0]!.key).toBe('budgets');
    expect(r.findings[0]!.tone).toBe('watch');
  });

  it('flags a category that dominates', () => {
    const f = build().findings.find((x) => x.key === 'top-category')!;
    // Housing is ₹15,000 of ₹19,500 — over the 45% threshold.
    expect(f.tone).toBe('watch');
  });

  it('caps the findings so the report stays readable', () => {
    expect(build({ budgets: [budget({ status: 'over_budget' })] }).findings.length).toBeLessThanOrEqual(4);
  });
});

describe('reportToText', () => {
  it('produces something that pastes into a message', () => {
    const text = reportToText(build(), money as never);
    expect(text).toContain('Spend Cents — Aug 2026');
    expect(text).toContain('Income   ₹55,000');
    expect(text).toContain('Where it went');
    expect(text.split('\n').length).toBeGreaterThan(8);
  });

  it('includes the findings as bullets', () => {
    expect(reportToText(build(), money as never)).toMatch(/•/);
  });

  it('survives an empty cycle', () => {
    const text = reportToText(build({ transactions: [] }), money as never);
    expect(text).toContain('Nothing was recorded');
  });
});
