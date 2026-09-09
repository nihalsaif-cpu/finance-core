import { describe, it, expect } from 'vitest';
import { buildHealthScore } from '../src/health';
import { fromMajor, ZERO } from '../src/money';
import type { BudgetEvaluation, CycleTrendPoint } from '../src/analytics';

const point = (spend: string): CycleTrendPoint =>
  ({ spend: fromMajor(spend), income: fromMajor('50000'), savings: ZERO, savingsRate: null,
     essential: ZERO, discretionary: ZERO, cycle: {} as never });

const budget = (status: BudgetEvaluation['status']): BudgetEvaluation =>
  ({ categoryId: 'c', label: 'Food', budget: ZERO, spent: ZERO, remaining: ZERO,
     percentUsed: 0, projected: ZERO, projectedOverspend: ZERO, status });

const build = (over: Partial<Parameters<typeof buildHealthScore>[0]> = {}) =>
  buildHealthScore({ savingsRate: 20, fixedExpenseRatio: 0.4, history: [], budgets: [], ...over });

describe('buildHealthScore', () => {
  it('says nothing rather than inventing a score with no data', () => {
    const h = buildHealthScore({ savingsRate: null, fixedExpenseRatio: null, history: [], budgets: [] });
    expect(h.score).toBeNull();
    expect(h.headline).toMatch(/not enough/i);
  });

  it('scores a healthy picture highly', () => {
    const h = build({
      savingsRate: 32, fixedExpenseRatio: 0.28,
      history: [point('20000'), point('20500'), point('19800'), point('20200')],
      budgets: [budget('healthy'), budget('healthy')],
    });
    expect(h.score).toBeGreaterThan(90);
    expect(h.grade).toBe('strong');
  });

  it('scores a strained picture low', () => {
    const h = build({
      savingsRate: -5, fixedExpenseRatio: 0.78,
      history: [point('10000'), point('45000'), point('12000')],
      budgets: [budget('over_budget'), budget('over_budget')],
    });
    expect(h.score).toBeLessThan(25);
    expect(h.grade).toBe('strained');
  });

  it('never scores below zero for overspending', () => {
    const h = build({ savingsRate: -80, fixedExpenseRatio: 0.9 });
    expect(h.score).toBeGreaterThanOrEqual(0);
  });

  it('names what is holding the score back', () => {
    const h = build({
      savingsRate: 30, fixedExpenseRatio: 0.75,
      history: [point('20000'), point('20500')],
    });
    expect(h.weakest?.key).toBe('commitments');
    // The headline must name the weak component in prose that reads as a sentence —
    // the column label spliced in directly gave "Committed costs is holding it back".
    expect(h.headline).toContain(h.weakest!.drag);
    expect(h.headline).toMatch(/already committed/i);
  });

  it('does not name a weakest when nothing is actually weak', () => {
    const h = build({
      savingsRate: 32, fixedExpenseRatio: 0.25,
      history: [point('20000'), point('20100')],
      budgets: [budget('healthy')],
    });
    expect(h.weakest).toBeNull();
  });

  it('redistributes weight rather than scoring a missing component zero', () => {
    // No budgets set is not the same as budgets blown.
    const withBudgets = build({ savingsRate: 30, fixedExpenseRatio: 0.3, budgets: [budget('healthy')] });
    const without = build({ savingsRate: 30, fixedExpenseRatio: 0.3, budgets: [] });
    expect(without.score).toBe(withBudgets.score);
    expect(without.components.some((c) => c.key === 'budgets')).toBe(false);
  });

  it('weights always sum to one', () => {
    const h = build({ history: [point('1000'), point('1100')], budgets: [budget('healthy')] });
    const total = h.components.reduce((a, c) => a + c.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('refuses to judge consistency from a single cycle', () => {
    const h = build({ history: [point('20000')] });
    expect(h.components.some((c) => c.key === 'consistency')).toBe(false);
  });

  it('rewards steady months', () => {
    const h = build({ history: [point('20000'), point('20400'), point('19700')] });
    const c = h.components.find((x) => x.key === 'consistency')!;
    expect(c.score).toBe(100);
    expect(c.detail).toMatch(/much like each other/i);
  });

  it('penalises wildly swinging months', () => {
    const h = build({ history: [point('5000'), point('50000'), point('8000')] });
    expect(h.components.find((x) => x.key === 'consistency')!.score).toBeLessThan(30);
  });

  it('is provisional with fewer than two completed cycles', () => {
    expect(build({ history: [point('20000')] }).confidence).toBe('provisional');
  });

  it('becomes good with four cycles', () => {
    const h = build({ history: [point('1'), point('2'), point('3'), point('4')] });
    expect(h.confidence).toBe('good');
    expect(h.basis).toContain('4 completed cycles');
  });

  it('explains each component in a line the user can act on', () => {
    const h = build({
      savingsRate: 8, fixedExpenseRatio: 0.72,
      budgets: [budget('over_budget'), budget('healthy')],
    });
    expect(h.components.find((c) => c.key === 'savings')!.detail).toContain('8%');
    expect(h.components.find((c) => c.key === 'commitments')!.detail).toMatch(/very little is movable/);
    expect(h.components.find((c) => c.key === 'budgets')!.detail).toBe('1 of 2 budgets are over.');
  });

  it('grades on sensible boundaries', () => {
    expect(build({ savingsRate: 30, fixedExpenseRatio: 0.3 }).grade).toBe('strong');
    expect(build({ savingsRate: 0, fixedExpenseRatio: 0.85 }).grade).toBe('strained');
  });
});
