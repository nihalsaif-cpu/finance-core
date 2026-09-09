import { describe, it, expect } from 'vitest';
import * as A from '../src/analytics';
import { cycleContaining, cycleProgress, type CycleConfig } from '../src/cycle';
import { fromMajor } from '../src/money';
import { categoryIndex, cat, CATEGORY_ROWS } from './helpers/categories';
import { txns, rs } from './helpers/factory';

const monthly: CycleConfig = { startDay: 1, frequency: 'monthly' };
const august = cycleContaining('2026-08-15', monthly);

describe('CategoryIndex', () => {
  it('rolls subcategory spend up to the top-level category', () => {
    expect(categoryIndex.rootOf(cat('food_delivery'))).toBe(cat('food'));
    expect(categoryIndex.rootOf(cat('food'))).toBe(cat('food'));
    expect(categoryIndex.rootOf(null)).toBeNull();
  });

  it('resolves names, colours and essential classification', () => {
    expect(categoryIndex.name(cat('rent'))).toBe('Rent');
    expect(categoryIndex.name(null)).toBe('Uncategorised');
    expect(categoryIndex.isEssential(cat('rent'))).toBe(true);
    expect(categoryIndex.isEssential(cat('restaurants'))).toBe(false);
    // 'mixed' defers the decision rather than guessing.
    expect(categoryIndex.isEssential(cat('food'))).toBeNull();
  });

  it('exposes the top-level categories in seed order', () => {
    const roots = categoryIndex.roots().map((c) => c.slug);
    expect(roots.slice(0, 4)).toEqual(['housing', 'food', 'transportation', 'shopping']);
  });

  it('does not hang on a cyclic parent reference', () => {
    const cyclic = new A.CategoryIndex([
      { ...CATEGORY_ROWS[0]!, id: 'a', parentId: 'b' },
      { ...CATEGORY_ROWS[0]!, id: 'b', parentId: 'a' },
    ]);
    expect(cyclic.rootOf('a')).toBeDefined();
  });
});

describe('rollups', () => {
  const ledger = txns([
    { amount: '4000', categoryId: cat('food_delivery'), merchantKey: 'swiggy', merchantName: 'Swiggy', paymentMethod: 'upi' },
    { amount: '3250', categoryId: cat('groceries'), merchantKey: 'zepto', merchantName: 'Zepto', paymentMethod: 'upi' },
    { amount: '8400', categoryId: cat('online_shopping'), merchantKey: 'amazon', merchantName: 'Amazon', paymentMethod: 'credit_card' },
    { amount: '25000', categoryId: cat('rent'), merchantKey: 'rent', merchantName: 'Rent', paymentMethod: 'bank_transfer' },
    { amount: '999', categoryId: cat('online_shopping'), merchantKey: 'amazon', merchantName: 'Amazon', kind: 'refund', paymentMethod: 'credit_card' },
  ]);

  it('groups spend by top-level category with shares', () => {
    const rollups = A.spendByCategory(ledger, categoryIndex);
    const food = rollups.find((r) => r.key === cat('food'));
    expect(food?.amount).toBe(rs(7250));
    expect(rollups[0]!.key).toBe(cat('housing'));
    const shopping = rollups.find((r) => r.key === cat('shopping'));
    // The refund reduces the category it belongs to.
    expect(shopping?.amount).toBe(rs(7401));
    const totalShare = rollups.reduce((acc, r) => acc + (r.share ?? 0), 0);
    expect(totalShare).toBeCloseTo(100);
  });

  it('can report subcategories without rolling up', () => {
    const rollups = A.spendByCategory(ledger, categoryIndex, undefined, false);
    expect(rollups.find((r) => r.key === cat('food_delivery'))?.amount).toBe(rs(4000));
    expect(rollups.find((r) => r.key === cat('food'))).toBeUndefined();
  });

  it('groups by merchant and by payment method', () => {
    const merchants = A.spendByMerchant(ledger);
    expect(merchants[0]!.label).toBe('Rent');
    expect(merchants.find((m) => m.key === 'amazon')?.amount).toBe(rs(7401));

    const methods = A.spendByPaymentMethod(ledger);
    expect(methods.find((m) => m.key === 'upi')?.amount).toBe(rs(7250));
    expect(methods.find((m) => m.key === 'credit_card')?.amount).toBe(rs(7401));
  });

  it('buckets uncategorised spend rather than dropping it', () => {
    const rollups = A.spendByCategory(txns([{ amount: '500', categoryId: null }]), categoryIndex);
    expect(rollups[0]).toMatchObject({ key: 'uncategorised', label: 'Uncategorised', amount: rs(500) });
  });

  it('returns an empty list, not a crash, for no transactions', () => {
    expect(A.spendByCategory([], categoryIndex)).toEqual([]);
    expect(A.spendByMerchant([])).toEqual([]);
  });
});

describe('compare', () => {
  it('computes deltas and percentage change', () => {
    const c = A.compare(fromMajor('7250'), fromMajor('6144'));
    expect(c.delta).toBe(rs(1106));
    expect(c.percentChange).toBeCloseTo(18, 0);
    expect(c.direction).toBe('up');
  });

  it('reports null percent change against a zero baseline instead of Infinity', () => {
    const c = A.compare(fromMajor('500'), fromMajor('0'));
    expect(c.percentChange).toBeNull();
    expect(c.direction).toBe('up');
  });

  it('calls small movements flat', () => {
    expect(A.compare(fromMajor('1010'), fromMajor('1000')).direction).toBe('flat');
  });
});

describe('compareCategories', () => {
  it('reports the brief’s category analysis shape', () => {
    const current = txns([
      { amount: '7250', categoryId: cat('food') },
      { amount: '8400', categoryId: cat('shopping') },
      { amount: '3200', categoryId: cat('transportation') },
    ]);
    const prior = [
      txns([
        { amount: '6000', categoryId: cat('food') },
        { amount: '6000', categoryId: cat('shopping') },
        { amount: '3500', categoryId: cat('transportation') },
      ]),
      txns([
        { amount: '6290', categoryId: cat('food') },
        { amount: '5830', categoryId: cat('shopping') },
        { amount: '3450', categoryId: cat('transportation') },
      ]),
    ];

    const result = A.compareCategories(current, prior, categoryIndex);
    const food = result.find((r) => r.key === cat('food'))!;
    expect(food.comparison.percentChange).toBeCloseTo(18, 0);
    const shopping = result.find((r) => r.key === cat('shopping'))!;
    expect(shopping.comparison.percentChange).toBeCloseTo(42, 0);
    const transport = result.find((r) => r.key === cat('transportation'))!;
    expect(transport.comparison.percentChange).toBeCloseTo(-8, 0);
  });

  it('includes a category that stopped being used, so a drop is visible', () => {
    const result = A.compareCategories([], [txns([{ amount: '2000', categoryId: cat('food') }])], categoryIndex);
    const food = result.find((r) => r.key === cat('food'))!;
    expect(food.amount).toBe(0);
    expect(food.comparison.direction).toBe('down');
  });

  it('averages across all prior cycles including ones with no spend', () => {
    const result = A.compareCategories(
      txns([{ amount: '1000', categoryId: cat('food') }]),
      [txns([{ amount: '2000', categoryId: cat('food') }]), []],
      categoryIndex,
    );
    // Baseline is 1,000 (2,000 across two cycles), not 2,000.
    expect(result.find((r) => r.key === cat('food'))!.comparison.baseline).toBe(rs(1000));
  });
});

describe('buildCycleSnapshot', () => {
  const ledger = txns([
    { date: '2026-08-01', amount: '75000', kind: 'income', categoryId: cat('salary') },
    { date: '2026-08-02', amount: '25000', categoryId: cat('rent'), isRecurring: true },
    { date: '2026-08-03', amount: '6500', categoryId: cat('emi'), isRecurring: true },
    { date: '2026-08-10', amount: '7250', categoryId: cat('food_delivery') },
    { date: '2026-08-12', amount: '4500', categoryId: cat('online_shopping') },
    { date: '2026-07-25', amount: '9999', categoryId: cat('online_shopping') }, // previous cycle
  ]);

  const snapshot = A.buildCycleSnapshot({
    cycle: august,
    progress: cycleProgress(august, '2026-08-15'),
    transactions: ledger,
    categories: categoryIndex,
    expectedIncome: fromMajor('75000'),
  });

  it('only counts transactions inside the cycle', () => {
    expect(snapshot.transactionCount).toBe(5);
    expect(snapshot.totals.totalSpend).toBe(rs(43250));
  });

  it('produces the dashboard headline figures', () => {
    expect(snapshot.income).toBe(rs(75000));
    expect(snapshot.incomeIsEstimated).toBe(false);
    expect(snapshot.savings).toBe(rs(31750));
    expect(snapshot.savingsRate).toBeCloseTo(42.3, 1);
  });

  it('separates fixed commitments from flexible income', () => {
    expect(snapshot.fixedCommitments).toBe(rs(31500));
    expect(snapshot.flexibleIncome).toBe(rs(43500));
    expect(snapshot.fixedExpenseRatio).toBeCloseTo(42, 0);
  });

  it('falls back to expected income and says so when nothing is recorded', () => {
    const noIncome = A.buildCycleSnapshot({
      cycle: august,
      progress: cycleProgress(august, '2026-08-15'),
      transactions: txns([{ date: '2026-08-05', amount: '5000' }]),
      categories: categoryIndex,
      expectedIncome: fromMajor('75000'),
    });
    expect(noIncome.income).toBe(rs(75000));
    expect(noIncome.incomeIsEstimated).toBe(true);
  });

  it('handles an entirely empty cycle without NaN', () => {
    const empty = A.buildCycleSnapshot({
      cycle: august,
      progress: cycleProgress(august, '2026-08-15'),
      transactions: [],
      categories: categoryIndex,
      expectedIncome: fromMajor('0'),
    });
    expect(empty.savingsRate).toBeNull();
    expect(empty.averageDailySpend).toBe(0);
    expect(empty.split.essentialShare).toBeNull();
  });
});

describe('evaluateBudgets', () => {
  const budgets = [
    { categoryId: cat('food'), amount: fromMajor('7000') },
    { categoryId: cat('shopping'), amount: fromMajor('5000') },
    { categoryId: cat('entertainment'), amount: fromMajor('3000') },
    { categoryId: null, amount: fromMajor('50000') },
  ];
  const ledger = txns([
    { amount: '7250', categoryId: cat('food_delivery') },
    { amount: '4600', categoryId: cat('online_shopping') },
    { amount: '400', categoryId: cat('entertainment') },
  ]);

  const evaluations = A.evaluateBudgets(budgets, ledger, categoryIndex, cycleProgress(august, '2026-08-15'));
  const byId = (id: string | null) => evaluations.find((e) => e.categoryId === id)!;

  it('marks an exceeded budget as over', () => {
    const food = byId(cat('food'));
    expect(food.spent).toBe(rs(7250));
    expect(food.remaining).toBe(rs(-250));
    expect(food.percentUsed).toBeCloseTo(103.6, 1);
    expect(food.status).toBe('over_budget');
  });

  it('marks a budget close to its limit', () => {
    expect(byId(cat('shopping')).status).toBe('near_limit');
    expect(byId(cat('shopping')).percentUsed).toBeCloseTo(92, 0);
  });

  it('applies a subcategory budget to spend recorded in that subcategory', () => {
    // Rollups collapse Entertainment into Lifestyle, but a budget set on the
    // subcategory must still see the ₹400 spent there.
    expect(byId(cat('entertainment')).spent).toBe(rs(400));
  });

  it('applies a parent budget to spend in its subcategories', () => {
    // ₹7,250 was spent in Food Delivery; the budget is on Food.
    expect(byId(cat('food')).spent).toBe(rs(7250));
  });

  it('warns about a budget that is on course to be exceeded', () => {
    // 400 of 3,000 by day 15 of 31 projects to ~827 — comfortably healthy.
    expect(byId(cat('entertainment')).status).toBe('healthy');

    const fastBurn = A.evaluateBudgets(
      [{ categoryId: cat('entertainment'), amount: fromMajor('3000') }],
      txns([{ amount: '2000', categoryId: cat('entertainment') }]),
      categoryIndex,
      cycleProgress(august, '2026-08-08'),
    );
    expect(fastBurn[0]!.status).toBe('projected_over');
    expect(fastBurn[0]!.projectedOverspend).toBeGreaterThan(0);
  });

  it('evaluates the overall budget against total spend', () => {
    expect(byId(null).spent).toBe(rs(12250));
    expect(byId(null).label).toBe('Overall');
  });

  it('uses a supplied whole-cycle projection for the OVERALL budget', () => {
    // The budgets view and the velocity view both answer "what will this cycle
    // total". Left to themselves they answered differently — a straight line here,
    // the user's historical shape there — and a user comparing two screens found two
    // numbers for one question.
    const shared = A.evaluateBudgets(
      [{ categoryId: null, amount: fromMajor('50000') }],
      ledger,
      categoryIndex,
      cycleProgress(august, '2026-08-15'),
      undefined,
      undefined,
      { overallProjectedTotal: fromMajor('60000') },
    );

    expect(shared[0]!.projected).toBe(rs(60000));
    expect(shared[0]!.projectedOverspend).toBe(rs(10000));
    expect(shared[0]!.status).toBe('projected_over');
  });

  it('leaves CATEGORY budgets on the straight line even when a projection is supplied', () => {
    // A category allowance is meant to be spent evenly, and the whole-cycle curve is
    // dominated by rent landing on day one — a shape that says nothing about food.
    const withProjection = A.evaluateBudgets(
      budgets,
      ledger,
      categoryIndex,
      cycleProgress(august, '2026-08-15'),
      undefined,
      undefined,
      { overallProjectedTotal: fromMajor('60000') },
    );
    const plain = A.evaluateBudgets(budgets, ledger, categoryIndex, cycleProgress(august, '2026-08-15'));

    const food = (list: typeof plain) => list.find((e) => e.categoryId === cat('food'))!;
    expect(food(withProjection).projected).toBe(food(plain).projected);
  });

  it('ignores the supplied projection once the cycle is complete', () => {
    // A finished cycle has an actual total; projecting it would replace a fact with
    // an estimate.
    const complete = A.evaluateBudgets(
      [{ categoryId: null, amount: fromMajor('50000') }],
      ledger,
      categoryIndex,
      cycleProgress(august, '2026-09-30'),
      undefined,
      undefined,
      { overallProjectedTotal: fromMajor('60000') },
    );
    expect(complete[0]!.projected).toBe(rs(12250));
  });

  it('sorts the most urgent budget first', () => {
    expect(evaluations[0]!.status).toBe('over_budget');
  });

  it('reports null usage rather than dividing by a zero budget', () => {
    const zero = A.evaluateBudgets(
      [{ categoryId: cat('food'), amount: fromMajor('0') }],
      ledger,
      categoryIndex,
      cycleProgress(august, '2026-08-15'),
    );
    expect(zero[0]!.percentUsed).toBeNull();
    expect(zero[0]!.status).toBe('over_budget');
  });
});

describe('cycleTrend', () => {
  it('summarises several cycles for the analysis screen', () => {
    const cycles = [cycleContaining('2026-06-10', monthly), cycleContaining('2026-07-10', monthly), august];
    const ledger = txns([
      { date: '2026-06-05', amount: '40000' },
      { date: '2026-07-05', amount: '45000' },
      { date: '2026-08-05', amount: '50000' },
    ]);
    const trend = A.cycleTrend(cycles, ledger, categoryIndex, fromMajor('75000'));
    expect(trend.map((p) => p.spend)).toEqual([rs(40000), rs(45000), rs(50000)]);
    expect(A.averageCycleSpend(trend)).toBe(rs(45000));
    expect(trend[2]!.savingsRate).toBeCloseTo(33.3, 1);
  });

  it('averages an empty trend to zero', () => {
    expect(A.averageCycleSpend([])).toBe(0);
  });
});
