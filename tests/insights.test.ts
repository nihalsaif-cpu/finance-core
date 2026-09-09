import { describe, it, expect } from 'vitest';
import { generateInsights } from '../src/insights';
import { buildCycleSnapshot, evaluateBudgets } from '../src/analytics';
import { cycleContaining, cycleProgress, type CycleConfig } from '../src/cycle';
import { computeVelocity } from '../src/velocity';
import { fromMajor, ZERO, type Minor } from '../src/money';
import { categoryIndex, cat } from './helpers/categories';
import { txns } from './helpers/factory';
import type { AnalyzableTransaction } from '../src/types';

const monthly: CycleConfig = { startDay: 1, frequency: 'monthly' };
const cycle = cycleContaining('2026-08-15', monthly);

function build(options: {
  day?: number;
  current: AnalyzableTransaction[];
  prior?: AnalyzableTransaction[][];
  budgets?: Array<{ categoryId: string | null; amount: Minor }>;
  savingsTarget?: Minor;
  income?: Minor;
}) {
  const progress = cycleProgress(cycle, `2026-08-${String(options.day ?? 15).padStart(2, '0')}`);
  const income = options.income ?? fromMajor('75000');
  const snapshot = buildCycleSnapshot({
    cycle,
    progress,
    transactions: options.current,
    categories: categoryIndex,
    expectedIncome: income,
  });
  const velocity = computeVelocity({
    progress,
    spentToDate: snapshot.totals.totalSpend,
    referenceAmount: income,
  });
  const budgets = evaluateBudgets(options.budgets ?? [], options.current, categoryIndex, progress);

  return generateInsights({
    snapshot,
    velocity,
    budgets,
    categories: categoryIndex,
    currentTransactions: options.current,
    priorCycles: options.prior ?? [],
    savingsTarget: options.savingsTarget ?? ZERO,
    currency: 'INR',
  });
}

describe('insight quality', () => {
  it('never emits generic advice — every insight carries a figure', () => {
    const insights = build({
      current: txns([
        { date: '2026-08-02', amount: '25000', categoryId: cat('rent'), isRecurring: true },
        { date: '2026-08-10', amount: '9000', categoryId: cat('food_delivery') },
        { date: '2026-08-11', amount: '6000', categoryId: cat('online_shopping') },
      ]),
      prior: [
        txns([{ date: '2026-07-10', amount: '5000', categoryId: cat('food_delivery') }]),
        txns([{ date: '2026-06-10', amount: '5200', categoryId: cat('food_delivery') }]),
      ],
    });
    expect(insights.length).toBeGreaterThan(0);
    for (const insight of insights) {
      expect(`${insight.title} ${insight.detail}`).toMatch(/[₹\d]/);
      expect(insight.detail).not.toMatch(/^save more|spend less$/i);
    }
  });

  it('sorts the most urgent insight first', () => {
    const insights = build({
      current: txns([{ date: '2026-08-10', amount: '9000', categoryId: cat('food_delivery') }]),
      budgets: [{ categoryId: cat('food'), amount: fromMajor('5000') }],
    });
    expect(insights[0]!.severity).toBe('critical');
    expect(insights[0]!.title).toMatch(/over budget/i);
  });

  it('reports category overspend with the actual overshoot', () => {
    const insights = build({
      current: txns([{ date: '2026-08-10', amount: '7250', categoryId: cat('food_delivery') }]),
      budgets: [{ categoryId: cat('food'), amount: fromMajor('7000') }],
    });
    const overspend = insights.find((i) => i.kind === 'category_overspend')!;
    expect(overspend.title).toContain('₹250');
    expect(overspend.action).toBeTruthy();
  });

  it('compares a category against the user’s own multi-cycle baseline', () => {
    const insights = build({
      current: txns([{ date: '2026-08-10', amount: '9000', categoryId: cat('food_delivery') }]),
      prior: [
        txns([{ date: '2026-07-10', amount: '6000', categoryId: cat('food_delivery') }]),
        txns([{ date: '2026-06-10', amount: '6000', categoryId: cat('food_delivery') }]),
      ],
    });
    const trend = insights.find((i) => i.kind === 'category_trend');
    expect(trend?.title).toMatch(/Food spending is 50% above/i);
  });

  it('stays silent about trends when there is not enough history', () => {
    const insights = build({
      current: txns([{ date: '2026-08-10', amount: '9000', categoryId: cat('food_delivery') }]),
      prior: [txns([{ date: '2026-07-10', amount: '1000', categoryId: cat('food_delivery') }])],
    });
    expect(insights.find((i) => i.kind === 'category_trend')).toBeUndefined();
  });

  it('ignores changes too small to matter', () => {
    const insights = build({
      current: txns([{ date: '2026-08-10', amount: '5100', categoryId: cat('food_delivery') }]),
      prior: [
        txns([{ date: '2026-07-10', amount: '5000', categoryId: cat('food_delivery') }]),
        txns([{ date: '2026-06-10', amount: '5000', categoryId: cat('food_delivery') }]),
      ],
    });
    expect(insights.find((i) => i.kind === 'category_trend')).toBeUndefined();
  });

  it('reports the subscription share of income', () => {
    const insights = build({
      current: txns([
        { date: '2026-08-05', amount: '649', categoryId: cat('streaming') },
        { date: '2026-08-06', amount: '1999', categoryId: cat('software') },
        { date: '2026-08-07', amount: '2000', categoryId: cat('gym') },
      ]),
    });
    const subscriptions = insights.find((i) => i.kind === 'subscription_load')!;
    expect(subscriptions.detail).toContain('₹4,648');
  });

  it('warns when the savings target is at risk', () => {
    const insights = build({
      day: 15,
      current: txns([{ date: '2026-08-10', amount: '45000', categoryId: cat('online_shopping') }]),
      savingsTarget: fromMajor('20000'),
    });
    const risk = insights.find((i) => i.kind === 'savings_risk')!;
    expect(risk.severity).toBe('warning');
    expect(risk.action).toMatch(/less each day/i);
  });

  it('flags a transaction far outside the usual pattern', () => {
    const insights = build({
      current: txns([
        { date: '2026-08-01', amount: '200', categoryId: cat('coffee_snacks') },
        { date: '2026-08-02', amount: '250', categoryId: cat('coffee_snacks') },
        { date: '2026-08-03', amount: '300', categoryId: cat('coffee_snacks') },
        { date: '2026-08-04', amount: '180', categoryId: cat('coffee_snacks') },
        { date: '2026-08-05', amount: '220', categoryId: cat('coffee_snacks') },
        { date: '2026-08-06', amount: '45000', categoryId: cat('electronics'), merchantName: 'Croma' },
      ]),
    });
    expect(insights.find((i) => i.kind === 'large_transaction')?.title).toContain('₹45,000');
  });

  it('does not flag a large recurring charge as unusual', () => {
    const insights = build({
      current: txns([
        { date: '2026-08-01', amount: '200', categoryId: cat('coffee_snacks') },
        { date: '2026-08-02', amount: '250', categoryId: cat('coffee_snacks') },
        { date: '2026-08-03', amount: '300', categoryId: cat('coffee_snacks') },
        { date: '2026-08-04', amount: '180', categoryId: cat('coffee_snacks') },
        { date: '2026-08-05', amount: '220', categoryId: cat('coffee_snacks') },
        { date: '2026-08-06', amount: '35000', categoryId: cat('rent'), isRecurring: true },
      ]),
    });
    expect(insights.find((i) => i.kind === 'large_transaction')).toBeUndefined();
  });

  it('says something rather than nothing when spending is unremarkable', () => {
    const insights = build({
      current: txns([{ date: '2026-08-10', amount: '3000', categoryId: cat('groceries') }]),
    });
    expect(insights.length).toBeGreaterThan(0);
  });

  it('produces no insights at all for an empty cycle', () => {
    expect(build({ current: [] })).toEqual([]);
  });

  it('gives every insight a stable id so regeneration does not duplicate it', () => {
    const first = build({
      current: txns([{ date: '2026-08-10', amount: '9000', categoryId: cat('food_delivery') }]),
      budgets: [{ categoryId: cat('food'), amount: fromMajor('5000') }],
    });
    const second = build({
      current: txns([{ date: '2026-08-10', amount: '9000', categoryId: cat('food_delivery') }]),
      budgets: [{ categoryId: cat('food'), amount: fromMajor('5000') }],
    });
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(new Set(first.map((i) => i.id)).size).toBe(first.length);
  });
});
