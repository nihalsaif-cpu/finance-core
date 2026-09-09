/**
 * Insight generation.
 *
 * Rules, not vibes. Every insight must:
 *   1. cite a real number the user can verify against their own transactions,
 *   2. compare it to a stated baseline,
 *   3. and, where there is an honest one, name an action.
 *
 * "Save more money" is banned by construction: an insight cannot be produced without
 * a computed magnitude, so there is nowhere for generic advice to come from. Insights
 * that would fire on thin data (one prior cycle, a handful of transactions) are
 * suppressed rather than stated weakly — a wrong warning costs more trust than a
 * missing one.
 */

import type { BudgetEvaluation, CategoryIndex, CycleSnapshot } from './analytics';
import { compareCategories, countInCategory, spendByCategory } from './analytics';
import { formatApprox, percentage, sub, sum, type Minor, ZERO, divide } from './money';
import { DEFAULT_LEDGER_OPTIONS, essentialSplit, type LedgerOptions, spendOf } from './ledger';
import type { VelocityResult } from './velocity';
import type { AnalyzableTransaction, Insight, InsightSeverity } from './types';
import { SUBSCRIPTION_SLUGS } from './categories';

export interface InsightInput {
  snapshot: CycleSnapshot;
  velocity: VelocityResult;
  budgets: readonly BudgetEvaluation[];
  categories: CategoryIndex;
  currentTransactions: readonly AnalyzableTransaction[];
  /** Prior cycles, oldest first. */
  priorCycles: readonly (readonly AnalyzableTransaction[])[];
  savingsTarget: Minor;
  currency: string;
  ledgerOptions?: LedgerOptions;
}

/** Minimum prior cycles before trend claims are trustworthy enough to state. */
const MIN_CYCLES_FOR_TREND = 2;

/** Below this, a percentage change is noise dressed up as a finding. */
const MIN_MEANINGFUL_PERCENT = 15;

/** Below this rupee amount, a change is not worth a notification. */
const MIN_MEANINGFUL_AMOUNT = 50_000 as Minor; // ₹500

const severityWeight: Record<InsightSeverity, number> = {
  critical: 400,
  warning: 300,
  neutral: 150,
  positive: 100,
};

export function generateInsights(input: InsightInput): Insight[] {
  const options = input.ledgerOptions ?? DEFAULT_LEDGER_OPTIONS;
  const money = (value: Minor) => formatApprox(value, { currency: input.currency });
  const insights: Insight[] = [];

  const push = (
    insight: Omit<Insight, 'priority'> & { magnitude?: number },
  ) => {
    const { magnitude = 0, ...rest } = insight;
    insights.push({ ...rest, priority: severityWeight[insight.severity] + Math.min(99, magnitude) });
  };

  const { snapshot, velocity, categories } = input;
  const cycleKey = snapshot.cycle.key;
  const hasHistory = input.priorCycles.filter((c) => c.length > 0).length >= MIN_CYCLES_FOR_TREND;

  // --- Pace ------------------------------------------------------------------
  if (!snapshot.progress.isComplete && velocity.pacePercent !== null && velocity.spentToDate > 0) {
    if (velocity.status === 'critical' || velocity.status === 'over') {
      const over = velocity.projectedOverspend;
      push({
        id: `${cycleKey}:pace`,
        kind: 'pace',
        severity: velocity.status === 'critical' ? 'critical' : 'warning',
        title: hasHistory
          ? `Spending about ${Math.round(velocity.pacePercent)}% faster than your usual pace`
          : `Spending about ${Math.round(velocity.pacePercent)}% faster than an even spread allows`,
        detail:
          `You have spent ${money(velocity.spentToDate)} by day ${snapshot.progress.dayIndex} of ` +
          `${snapshot.cycle.totalDays}, against ${money(velocity.expectedToDate)} at the planned pace.` +
          (over > 0 ? ` At this rate you would finish about ${money(over)} over.` : ''),
        action:
          velocity.daysRemaining > 0
            ? `Hold to about ${money(velocity.safeDailySpend)} a day for the remaining ${velocity.daysRemaining} days to land on target.`
            : undefined,
        magnitude: Math.abs(velocity.pacePercent),
      });
    } else if (velocity.status === 'under' && velocity.projectedSurplus > MIN_MEANINGFUL_AMOUNT) {
      const baselineName = hasHistory ? 'your usual pace' : 'an even spread across the cycle';
      push({
        id: `${cycleKey}:pace-good`,
        kind: 'positive_trend',
        severity: 'positive',
        title: `On track to keep about ${money(velocity.projectedSurplus)}`,
        detail:
          `You have spent ${money(velocity.spentToDate)} by day ${snapshot.progress.dayIndex} of ` +
          `${snapshot.cycle.totalDays}, against ${money(velocity.expectedToDate)} measured on ${baselineName}.`,
        magnitude: Math.abs(velocity.pacePercent),
      });
    }
  }

  // --- Budgets ---------------------------------------------------------------
  for (const budget of input.budgets) {
    if (budget.status === 'over_budget') {
      const over = sub(budget.spent, budget.budget);
      push({
        id: `${cycleKey}:budget-over:${budget.categoryId ?? 'overall'}`,
        kind: 'category_overspend',
        severity: 'critical',
        title: `${budget.label} is over budget by ${money(over)}`,
        detail:
          `You have spent ${money(budget.spent)} against a ${money(budget.budget)} budget` +
          (snapshot.progress.daysRemaining > 0
            ? ` with ${snapshot.progress.daysRemaining} days still to go.`
            : '.'),
        action: snapshot.progress.daysRemaining > 0 ? `Pause ${budget.label.toLowerCase()} spending, or move the budget up if it was set too low.` : undefined,
        ...(budget.categoryId ? { categoryId: budget.categoryId, focus: { categoryId: budget.categoryId } } : {}),
        magnitude: budget.percentUsed ?? 0,
      });
    } else if (budget.status === 'near_limit' && snapshot.progress.daysRemaining > 2) {
      push({
        id: `${cycleKey}:budget-near:${budget.categoryId ?? 'overall'}`,
        kind: 'budget_risk',
        severity: 'warning',
        title: `${budget.label} has reached ${Math.round(budget.percentUsed ?? 0)}% of its budget`,
        detail: `${money(budget.spent)} of ${money(budget.budget)} used with ${snapshot.progress.daysRemaining} days remaining.`,
        action: `That leaves ${money(budget.remaining)} for ${snapshot.progress.daysRemaining} days.`,
        ...(budget.categoryId ? { categoryId: budget.categoryId, focus: { categoryId: budget.categoryId } } : {}),
        magnitude: budget.percentUsed ?? 0,
      });
    } else if (budget.status === 'projected_over' && budget.projectedOverspend > MIN_MEANINGFUL_AMOUNT) {
      push({
        id: `${cycleKey}:budget-projected:${budget.categoryId ?? 'overall'}`,
        kind: 'budget_risk',
        severity: 'warning',
        title: `${budget.label} is heading over budget`,
        detail:
          `At the current rate ${budget.label.toLowerCase()} finishes around ${money(budget.projected)}, ` +
          `about ${money(budget.projectedOverspend)} over the ${money(budget.budget)} budget.`,
        ...(budget.categoryId ? { categoryId: budget.categoryId, focus: { categoryId: budget.categoryId } } : {}),
        magnitude: budget.percentUsed ?? 0,
      });
    }
  }

  // --- Category trends vs the user's own baseline -----------------------------
  if (hasHistory) {
    const comparisons = compareCategories(input.currentTransactions, input.priorCycles, categories, options);
    const baselineLabel = `${input.priorCycles.length}-cycle average`;

    for (const comparison of comparisons.slice(0, 6)) {
      const { percentChange, delta, baseline } = comparison.comparison;
      if (percentChange === null || baseline === 0) continue;
      if (Math.abs(percentChange) < MIN_MEANINGFUL_PERCENT) continue;
      if (Math.abs(delta) < MIN_MEANINGFUL_AMOUNT) continue;

      if (percentChange > 0) {
        push({
          id: `${cycleKey}:trend:${comparison.key}`,
          kind: 'category_trend',
          severity: percentChange > 50 ? 'warning' : 'neutral',
          title: `${comparison.label} spending is ${Math.round(percentChange)}% above your ${baselineLabel}`,
          detail: `${money(comparison.amount)} this cycle against a typical ${money(baseline)} — ${money(delta)} more.`,
          ...(comparison.key !== 'uncategorised' ? { categoryId: comparison.key, focus: { categoryId: comparison.key } } : {}),
          magnitude: percentChange,
        });
      } else if (percentChange < -MIN_MEANINGFUL_PERCENT && snapshot.progress.elapsedFraction > 0.6) {
        // Only claim a reduction late in the cycle, when it is not just "not yet spent".
        push({
          id: `${cycleKey}:trend-down:${comparison.key}`,
          kind: 'positive_trend',
          severity: 'positive',
          title: `${comparison.label} is down ${Math.abs(Math.round(percentChange))}% on your ${baselineLabel}`,
          detail: `${money(comparison.amount)} this cycle against a typical ${money(baseline)}, saving ${money(sub(baseline, comparison.amount))}.`,
          magnitude: Math.abs(percentChange),
        });
      }
    }

    // --- Discretionary shift --------------------------------------------------
    const priorDiscretionary = input.priorCycles.map(
      (list) => essentialSplit(list, categories.isEssential, options).discretionary,
    );
    const baselineDiscretionary = divide(sum(priorDiscretionary), Math.max(1, priorDiscretionary.length));
    const discretionaryDelta = sub(snapshot.split.discretionary, baselineDiscretionary);

    if (discretionaryDelta > MIN_MEANINGFUL_AMOUNT && baselineDiscretionary > 0) {
      const pct = percentage(discretionaryDelta, baselineDiscretionary);
      push({
        id: `${cycleKey}:discretionary`,
        kind: 'discretionary_trend',
        severity: 'warning',
        title: `Discretionary spending is up ${money(discretionaryDelta)}`,
        detail:
          `Non-essential spending is ${money(snapshot.split.discretionary)} this cycle against a typical ` +
          `${money(baselineDiscretionary)}${pct === null ? '' : ` — ${Math.round(pct)}% more`}.`,
        action: 'Discretionary spending is the part you can actually change without disruption.',
        magnitude: pct ?? 0,
      });
    }

    // --- Frequency spikes -----------------------------------------------------
    const foodDeliveryId = categories.all().find((c) => c.slug === 'food_delivery')?.id;
    if (foodDeliveryId) {
      const currentCount = countInCategory(input.currentTransactions, categories, categories.rootOf(foodDeliveryId) ?? foodDeliveryId, options);
      const priorCounts = input.priorCycles.map((list) =>
        countInCategory(list, categories, categories.rootOf(foodDeliveryId) ?? foodDeliveryId, options),
      );
      const averagePrior = priorCounts.length
        ? priorCounts.reduce((a, b) => a + b, 0) / priorCounts.length
        : 0;
      if (currentCount >= 6 && averagePrior >= 1 && currentCount > averagePrior * 1.5) {
        push({
          id: `${cycleKey}:frequency:food`,
          kind: 'frequency_spike',
          severity: 'warning',
          title: `${currentCount} food orders this cycle, against about ${Math.round(averagePrior)} usually`,
          detail: `Ordering in has become more frequent, not just more expensive.`,
          action: 'Frequency is usually easier to change than the size of each order.',
          magnitude: (currentCount / Math.max(1, averagePrior)) * 10,
        });
      }
    }
  }

  // --- Subscription load -------------------------------------------------------
  const subscriptionIds = new Set(
    categories.all().filter((c) => (SUBSCRIPTION_SLUGS as readonly string[]).includes(c.slug)).map((c) => c.id),
  );
  if (subscriptionIds.size > 0 && snapshot.income > 0) {
    const subscriptionSpend = sum(
      input.currentTransactions
        .filter((t) => t.categoryId && subscriptionIds.has(t.categoryId))
        .map((t) => spendOf(t, options)),
    );
    const share = percentage(subscriptionSpend, snapshot.income);
    if (share !== null && share >= 3) {
      push({
        id: `${cycleKey}:subscriptions`,
        kind: 'subscription_load',
        severity: share >= 8 ? 'warning' : 'neutral',
        title: `Subscriptions take ${share.toFixed(1)}% of your income`,
        detail: `${money(subscriptionSpend)} of ${money(snapshot.income)} goes to recurring subscriptions.`,
        action: share >= 8 ? 'Worth checking which of these you actually used this month.' : undefined,
        magnitude: share,
      });
    }
  }

  // --- Savings target at risk ---------------------------------------------------
  if (input.savingsTarget > 0 && !snapshot.progress.isComplete) {
    const projectedSavings = sub(snapshot.income, velocity.projectedTotal);
    if (projectedSavings < input.savingsTarget) {
      const shortfall = sub(input.savingsTarget, projectedSavings);
      if (shortfall > MIN_MEANINGFUL_AMOUNT) {
        push({
          id: `${cycleKey}:savings-risk`,
          kind: 'savings_risk',
          severity: 'warning',
          title: `Savings target is about ${money(shortfall)} short`,
          detail:
            `Your target is ${money(input.savingsTarget)}; at the current rate this cycle would leave ` +
            `${money(projectedSavings > 0 ? projectedSavings : ZERO)}.`,
          action:
            velocity.daysRemaining > 0
              ? `Spending about ${money(divide(shortfall, velocity.daysRemaining))} less each day would close the gap.`
              : undefined,
          magnitude: 60,
        });
      }
    } else if (snapshot.progress.elapsedFraction > 0.5) {
      push({
        id: `${cycleKey}:savings-ok`,
        kind: 'goal_progress',
        severity: 'positive',
        title: `On course to hit your ${money(input.savingsTarget)} savings target`,
        detail: `Projected to finish the cycle with ${money(projectedSavings)} unspent.`,
        magnitude: 20,
      });
    }
  }

  // --- Fixed burden ------------------------------------------------------------
  if (snapshot.fixedExpenseRatio !== null && snapshot.fixedExpenseRatio > 55) {
    push({
      id: `${cycleKey}:fixed-burden`,
      kind: 'fixed_burden',
      severity: snapshot.fixedExpenseRatio > 70 ? 'warning' : 'neutral',
      title: `${Math.round(snapshot.fixedExpenseRatio)}% of your income is already committed`,
      detail:
        `${money(snapshot.fixedCommitments)} goes to rent, EMIs and subscriptions, leaving ` +
        `${money(snapshot.flexibleIncome)} to actually decide about.`,
      magnitude: snapshot.fixedExpenseRatio,
    });
  }

  // --- Unusually large single transaction --------------------------------------
  const spendRows = input.currentTransactions.filter((t) => spendOf(t, options) > 0);
  if (spendRows.length >= 5) {
    const amounts = spendRows.map((t) => spendOf(t, options) as number).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)] ?? 0;
    const largest = spendRows.reduce((best, t) =>
      (spendOf(t, options) as number) > (spendOf(best, options) as number) ? t : best,
    );
    const largestAmount = spendOf(largest, options);
    // A transaction 8x the median is genuinely out of pattern rather than merely big.
    if (median > 0 && (largestAmount as number) > median * 8 && !largest.isRecurring) {
      push({
        id: `${cycleKey}:large:${largest.id}`,
        kind: 'large_transaction',
        severity: 'neutral',
        title: `${money(largestAmount)} at ${largest.merchantName ?? largest.description}`,
        detail: `That is well above your typical ${money(median as Minor)} transaction this cycle.`,
        ...(largest.merchantKey ? { focus: { merchantKey: largest.merchantKey } } : {}),
        magnitude: 30,
      });
    }
  }

  // --- Nothing to say ----------------------------------------------------------
  if (insights.length === 0 && snapshot.totals.totalSpend > 0) {
    const top = spendByCategory(input.currentTransactions, categories, options)[0];
    if (top) {
      push({
        id: `${cycleKey}:steady`,
        kind: 'category_trend',
        severity: 'neutral',
        title: `Nothing unusual this cycle`,
        detail: `${money(snapshot.totals.totalSpend)} spent so far, most of it on ${top.label} (${money(top.amount)}).`,
        magnitude: 0,
      });
    }
  }

  return insights.sort((a, b) => b.priority - a.priority);
}

/** Stable identifier for persisting an insight without duplicating it on regeneration. */
export function insightFingerprint(insight: Insight): string {
  return insight.id;
}
