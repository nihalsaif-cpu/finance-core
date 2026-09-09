/**
 * Analytics — every number the dashboard, analysis and report screens display.
 *
 * Pure functions over plain data. No screen computes its own totals; if a figure is
 * shown anywhere, it comes from here, so the dashboard and the report can never
 * disagree about what was spent.
 */

import type { CycleProgress, SalaryCycle } from './cycle';
import { type ISODate, isWithin } from './date';
import {
  ZERO,
  type Minor,
  clampAtZero,
  divide,
  fromMinor,
  percentage,
  sub,
  sum,
} from './money';
import {
  DEFAULT_LEDGER_OPTIONS,
  type EssentialSplit,
  type LedgerOptions,
  type LedgerTotals,
  effectOf,
  essentialSplit,
  isEssential,
  spendOf,
  totalsOf,
} from './ledger';
import type { AnalyzableTransaction, Category, PaymentMethod, UUID } from './types';

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function inCycle(
  transactions: readonly AnalyzableTransaction[],
  cycle: SalaryCycle,
): AnalyzableTransaction[] {
  return transactions.filter((t) => isWithin(t.date, cycle.start, cycle.end));
}

export function inRange(
  transactions: readonly AnalyzableTransaction[],
  from: ISODate,
  to: ISODate,
): AnalyzableTransaction[] {
  return transactions.filter((t) => isWithin(t.date, from, to));
}

// ---------------------------------------------------------------------------
// Category resolution
// ---------------------------------------------------------------------------

/**
 * Resolves category metadata and parent relationships. Built once per screen and
 * passed into the rollups so none of them need the raw category list.
 */
export class CategoryIndex {
  private readonly byId = new Map<UUID, Category>();
  private readonly childrenOf = new Map<UUID, UUID[]>();

  constructor(categories: readonly Category[]) {
    for (const c of categories) this.byId.set(c.id, c);
    for (const c of categories) {
      if (!c.parentId) continue;
      const list = this.childrenOf.get(c.parentId) ?? [];
      list.push(c.id);
      this.childrenOf.set(c.parentId, list);
    }
  }

  get(id: UUID | null): Category | null {
    return id ? this.byId.get(id) ?? null : null;
  }

  name(id: UUID | null): string {
    return this.get(id)?.name ?? 'Uncategorised';
  }

  color(id: UUID | null): string {
    return this.get(id)?.color ?? '#8A94A6';
  }

  icon(id: UUID | null): string {
    return this.get(id)?.icon ?? 'help-circle';
  }

  /** The top-level ancestor, for rolling subcategory spend up into "Food". */
  rootOf(id: UUID | null): UUID | null {
    let current = this.get(id);
    if (!current) return null;
    const seen = new Set<UUID>();
    while (current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  /** The category itself plus every ancestor, nearest first. */
  ancestorsOf(id: UUID | null): UUID[] {
    const chain: UUID[] = [];
    let current = this.get(id);
    const seen = new Set<UUID>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current.id);
      current = current.parentId ? this.byId.get(current.parentId) ?? null : null;
    }
    return chain;
  }

  /** True when `id` is `ancestorId` or sits underneath it. */
  isUnder(id: UUID | null, ancestorId: UUID): boolean {
    return this.ancestorsOf(id).includes(ancestorId);
  }

  children(id: UUID): Category[] {
    return (this.childrenOf.get(id) ?? []).map((c) => this.byId.get(c)!).filter(Boolean);
  }

  roots(): Category[] {
    return [...this.byId.values()]
      .filter((c) => !c.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  all(): Category[] {
    return [...this.byId.values()];
  }

  /**
   * Whether spending in this category is essential. A subcategory with no explicit
   * classification inherits its parent's. 'mixed' resolves to null so the caller
   * decides — `ledger.isEssential` treats null as discretionary.
   */
  isEssential = (id: UUID | null): boolean | null => {
    const category = this.get(id);
    if (!category) return null;
    if (category.classification === 'essential') return true;
    if (category.classification === 'discretionary') return false;
    return null;
  };
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

export interface Rollup {
  key: string;
  label: string;
  amount: Minor;
  count: number;
  /** Share of the rollup's grand total, 0–100. */
  share: number | null;
  color?: string;
  icon?: string;
}

function finaliseRollups(
  map: Map<string, { label: string; amount: number; count: number; color?: string; icon?: string }>,
): Rollup[] {
  const total = [...map.values()].reduce((acc, v) => acc + v.amount, 0);
  return [...map.entries()]
    .map(([key, v]) => {
      const entry: Rollup = {
        key,
        label: v.label,
        amount: fromMinor(v.amount),
        count: v.count,
        share: total === 0 ? null : (v.amount / total) * 100,
      };
      if (v.color) entry.color = v.color;
      if (v.icon) entry.icon = v.icon;
      return entry;
    })
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Income broken down by category — salary, interest, freelance, and so on.
 *
 * Exists because "Income: ₹70,116" is a claim the user cannot check. When a single
 * mis-classified credit silently changes the savings rate and every projection built
 * on it, being able to see what the total is MADE of is not a nicety; it is how the
 * number earns trust.
 *
 * Unlike the spending rollups this does NOT roll up to parents. The whole point is to
 * separate salary from bank interest, and both sit under the same income parent.
 */
export function incomeByCategory(
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): Rollup[] {
  const map = new Map<string, { label: string; amount: number; count: number; color?: string; icon?: string }>();

  for (const t of transactions) {
    const effect = effectOf(t, options);
    if (effect.income === 0) continue;

    const key = t.categoryId ?? 'unclassified';
    const existing = map.get(key);
    if (existing) {
      existing.amount += effect.income as number;
      existing.count += 1;
      continue;
    }

    const entry: { label: string; amount: number; count: number; color?: string; icon?: string } = {
      // An income row with no category is not "Other Income" — it is one nobody has
      // decided about yet, and saying so is what makes it get looked at.
      label: t.categoryId ? categories.name(t.categoryId) : 'Unclassified',
      amount: effect.income as number,
      count: 1,
    };
    const color = t.categoryId ? categories.color(t.categoryId) : undefined;
    if (color) entry.color = color;
    map.set(key, entry);
  }

  return finaliseRollups(map);
}

/** Spend by category. `rollUpToParent` groups subcategories under their parent. */
export function spendByCategory(
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
  rollUpToParent = true,
): Rollup[] {
  const map = new Map<string, { label: string; amount: number; count: number; color?: string; icon?: string }>();
  for (const t of transactions) {
    const s = spendOf(t, options);
    if (s === 0) continue;
    const id = rollUpToParent ? categories.rootOf(t.categoryId) : t.categoryId;
    const key = id ?? 'uncategorised';
    const existing = map.get(key) ?? {
      label: categories.name(id),
      amount: 0,
      count: 0,
      color: categories.color(id),
      icon: categories.icon(id),
    };
    existing.amount += s;
    existing.count += s > 0 ? 1 : 0;
    map.set(key, existing);
  }
  return finaliseRollups(map);
}

export function spendByMerchant(
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): Rollup[] {
  const map = new Map<string, { label: string; amount: number; count: number }>();
  for (const t of transactions) {
    const s = spendOf(t, options);
    if (s === 0) continue;
    const key = t.merchantKey ?? 'unknown';
    const existing = map.get(key) ?? {
      label: t.merchantName ?? (t.description || 'Unknown'),
      amount: 0,
      count: 0,
    };
    existing.amount += s;
    existing.count += s > 0 ? 1 : 0;
    map.set(key, existing);
  }
  return finaliseRollups(map);
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  debit_card: 'Debit Card',
  credit_card: 'Credit Card',
  bank_transfer: 'Bank Transfer',
  netbanking: 'Net Banking',
  wallet: 'Wallet',
  other: 'Other',
};

export function spendByPaymentMethod(
  transactions: readonly AnalyzableTransaction[],
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): Rollup[] {
  const map = new Map<string, { label: string; amount: number; count: number }>();
  for (const t of transactions) {
    const s = spendOf(t, options);
    if (s === 0) continue;
    const existing = map.get(t.paymentMethod) ?? {
      label: PAYMENT_LABELS[t.paymentMethod],
      amount: 0,
      count: 0,
    };
    existing.amount += s;
    existing.count += s > 0 ? 1 : 0;
    map.set(t.paymentMethod, existing);
  }
  return finaliseRollups(map);
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

export interface Comparison {
  current: Minor;
  baseline: Minor;
  delta: Minor;
  /** Percentage change vs baseline. null when the baseline is zero. */
  percentChange: number | null;
  direction: 'up' | 'down' | 'flat';
}

export function compare(current: Minor, baseline: Minor, flatThresholdPercent = 2): Comparison {
  const delta = sub(current, baseline);
  const percentChange = baseline === 0 ? null : (delta / baseline) * 100;
  const direction =
    percentChange === null
      ? current > 0
        ? 'up'
        : 'flat'
      : Math.abs(percentChange) < flatThresholdPercent
        ? 'flat'
        : percentChange > 0
          ? 'up'
          : 'down';
  return { current, baseline, delta, percentChange, direction };
}

export interface CategoryComparison extends Rollup {
  comparison: Comparison;
}

/**
 * Category spend for the current cycle against the mean of prior cycles.
 *
 * The baseline is the *mean across cycles*, including cycles with zero spend in that
 * category — otherwise a category bought once in six months looks like a stable habit
 * that suddenly stopped.
 */
export function compareCategories(
  currentTransactions: readonly AnalyzableTransaction[],
  priorCycleTransactions: readonly (readonly AnalyzableTransaction[])[],
  categories: CategoryIndex,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): CategoryComparison[] {
  const current = spendByCategory(currentTransactions, categories, options);
  const priorRollups = priorCycleTransactions.map((list) => spendByCategory(list, categories, options));

  const baselineFor = (key: string): Minor => {
    if (priorRollups.length === 0) return ZERO;
    const totals = priorRollups.map((r) => r.find((x) => x.key === key)?.amount ?? ZERO);
    return divide(sum(totals), priorRollups.length);
  };

  const keys = new Set(current.map((r) => r.key));
  for (const rollup of priorRollups) for (const r of rollup) keys.add(r.key);

  const out: CategoryComparison[] = [];
  for (const key of keys) {
    const existing = current.find((r) => r.key === key);
    const amount = existing?.amount ?? ZERO;
    // Skip categories with no activity at all in either window.
    const baseline = baselineFor(key);
    if (amount === 0 && baseline === 0) continue;
    out.push({
      key,
      label: existing?.label ?? categories.name(key === 'uncategorised' ? null : key),
      amount,
      count: existing?.count ?? 0,
      share: existing?.share ?? null,
      ...(existing?.color ? { color: existing.color } : {}),
      ...(existing?.icon ? { icon: existing.icon } : {}),
      comparison: compare(amount, baseline),
    });
  }

  return out.sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Cycle snapshot
// ---------------------------------------------------------------------------

export interface CycleSnapshot {
  cycle: SalaryCycle;
  progress: CycleProgress;
  totals: LedgerTotals;
  /** Income recorded this cycle, or the expected figure when none is recorded yet. */
  income: Minor;
  /** True when `income` is the user's expectation rather than observed money. */
  incomeIsEstimated: boolean;
  /** income − spend − invested. What is genuinely left. */
  remaining: Minor;
  /** Money not spent this cycle, treated as saved. */
  savings: Minor;
  savingsRate: number | null;
  split: EssentialSplit;
  /** Recurring/fixed commitments observed this cycle. */
  fixedCommitments: Minor;
  /** income − fixed commitments. Money genuinely available to decide about. */
  flexibleIncome: Minor;
  fixedExpenseRatio: number | null;
  discretionaryRatio: number | null;
  averageDailySpend: Minor;
  transactionCount: number;
}

export interface SnapshotInput {
  cycle: SalaryCycle;
  progress: CycleProgress;
  transactions: readonly AnalyzableTransaction[];
  categories: CategoryIndex;
  /** Falls back to this when no income has been recorded in the cycle. */
  expectedIncome: Minor;
  options?: LedgerOptions;
}

export function buildCycleSnapshot(input: SnapshotInput): CycleSnapshot {
  const options = input.options ?? DEFAULT_LEDGER_OPTIONS;
  const transactions = inCycle(input.transactions, input.cycle);
  const totals = totalsOf(transactions, options);

  const incomeIsEstimated = totals.totalIncome === 0;
  const income = incomeIsEstimated ? input.expectedIncome : totals.totalIncome;

  const split = essentialSplit(transactions, input.categories.isEssential, options);
  const fixedCommitments = sum(
    transactions.filter((t) => t.isRecurring).map((t) => spendOf(t, options)),
  );

  const remaining = sub(sub(income, totals.totalSpend), totals.totalInvested);
  // Investments are savings, not consumption, so they count toward money kept.
  const savings = sub(income, totals.totalSpend);

  return {
    cycle: input.cycle,
    progress: input.progress,
    totals,
    income,
    incomeIsEstimated,
    remaining,
    savings,
    savingsRate: percentage(savings, income),
    split,
    fixedCommitments,
    flexibleIncome: clampAtZero(sub(income, fixedCommitments)),
    fixedExpenseRatio: percentage(fixedCommitments, income),
    discretionaryRatio: percentage(split.discretionary, income),
    averageDailySpend:
      input.progress.daysElapsed > 0 ? divide(totals.totalSpend, input.progress.daysElapsed) : ZERO,
    transactionCount: transactions.length,
  };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export type BudgetStatus = 'healthy' | 'near_limit' | 'over_budget' | 'projected_over';

export interface BudgetEvaluation {
  categoryId: UUID | null;
  label: string;
  budget: Minor;
  spent: Minor;
  remaining: Minor;
  /** 0–100+, uncapped so "142% used" is expressible. null when the budget is zero. */
  percentUsed: number | null;
  projected: Minor;
  projectedOverspend: Minor;
  status: BudgetStatus;
  color?: string;
  icon?: string;
}

export interface BudgetInput {
  categoryId: UUID | null;
  amount: Minor;
}

/**
 * Evaluate budgets against actual and projected spend.
 *
 * Status is deliberately forward-looking: a category at 60% on day 12 of 30 is
 * "healthy", but at 60% on day 6 it is flagged, because the point of the app is to
 * warn before the money is gone rather than confirm it afterwards.
 */
export function evaluateBudgets(
  budgets: readonly BudgetInput[],
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  progress: CycleProgress,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
  nearLimitPercent = 85,
): BudgetEvaluation[] {
  const overallSpend = totalsOf(transactions, options).totalSpend;
  const elapsed = Math.max(progress.elapsedFraction, 0.0001);

  return budgets
    .map((budget): BudgetEvaluation => {
      // A budget covers its category and every subcategory beneath it, so a "Food"
      // budget captures Food Delivery and a "Food Delivery" budget captures only that.
      const spent =
        budget.categoryId === null
          ? overallSpend
          : sum(
              transactions
                .filter((t) => categories.isUnder(t.categoryId, budget.categoryId!))
                .map((t) => spendOf(t, options)),
            );

      const percentUsed = percentage(spent, budget.amount);
      // Straight-line projection is right here: a category budget is a straight-line
      // allowance, and the curve-based projection belongs to the whole-cycle view.
      const projected = progress.isComplete ? spent : divide(spent, elapsed);
      const projectedOverspend = clampAtZero(sub(projected, budget.amount));

      let status: BudgetStatus = 'healthy';
      if (spent > budget.amount) status = 'over_budget';
      else if (percentUsed !== null && percentUsed >= nearLimitPercent) status = 'near_limit';
      else if (projectedOverspend > 0 && !progress.isComplete) status = 'projected_over';

      const category = categories.get(budget.categoryId);
      return {
        categoryId: budget.categoryId,
        label: budget.categoryId === null ? 'Overall' : category?.name ?? 'Uncategorised',
        budget: budget.amount,
        spent,
        remaining: sub(budget.amount, spent),
        percentUsed,
        projected,
        projectedOverspend,
        status,
        ...(category?.color ? { color: category.color } : {}),
        ...(category?.icon ? { icon: category.icon } : {}),
      };
    })
    .sort((a, b) => {
      const rank: Record<BudgetStatus, number> = {
        over_budget: 0,
        near_limit: 1,
        projected_over: 2,
        healthy: 3,
      };
      return rank[a.status] - rank[b.status] || b.spent - a.spent;
    });
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export interface CycleTrendPoint {
  cycle: SalaryCycle;
  spend: Minor;
  income: Minor;
  savings: Minor;
  savingsRate: number | null;
  essential: Minor;
  discretionary: Minor;
}

export function cycleTrend(
  cycles: readonly SalaryCycle[],
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  expectedIncome: Minor,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): CycleTrendPoint[] {
  return cycles.map((cycle) => {
    const list = inCycle(transactions, cycle);
    const totals = totalsOf(list, options);
    const income = totals.totalIncome === 0 ? expectedIncome : totals.totalIncome;
    const split = essentialSplit(list, categories.isEssential, options);
    const savings = sub(income, totals.totalSpend);
    return {
      cycle,
      spend: totals.totalSpend,
      income,
      savings,
      savingsRate: percentage(savings, income),
      essential: split.essential,
      discretionary: split.discretionary,
    };
  });
}

/** Mean spend across the given cycles — the 3-month / 6-month baseline. */
export function averageCycleSpend(points: readonly CycleTrendPoint[]): Minor {
  if (points.length === 0) return ZERO;
  return divide(sum(points.map((p) => p.spend)), points.length);
}

/** Transaction count for a category across a window — for frequency comparisons. */
export function countInCategory(
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  categoryId: UUID,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): number {
  return transactions.filter(
    (t) => spendOf(t, options) > 0 && categories.rootOf(t.categoryId) === categoryId,
  ).length;
}

export { isEssential, totalsOf, essentialSplit };
