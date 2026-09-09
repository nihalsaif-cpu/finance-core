/**
 * A single financial health score.
 *
 * A score is easy to compute and easy to make meaningless. Three rules keep this one
 * honest:
 *
 *   1. It says what it is MADE OF. A bare number nobody can decompose is a horoscope;
 *      every component here reports its own value, weight and one-line explanation.
 *   2. It refuses to score what it cannot see. Fewer than two completed cycles is not
 *      enough to judge consistency, and a component with no data is dropped and its
 *      weight redistributed rather than scored as zero — penalising someone for not
 *      having set a budget would make the number say something it does not mean.
 *   3. It reports its own confidence. A score from one month is provisional and says so.
 *
 * Pure, so every band boundary and weighting is testable.
 */

import { divide, sub, sum, ZERO, type Minor } from './money';
import type { CycleTrendPoint } from './analytics';
import type { BudgetEvaluation } from './analytics';

export type HealthGrade = 'strong' | 'steady' | 'stretched' | 'strained';
export type HealthConfidence = 'provisional' | 'fair' | 'good';

export interface HealthComponent {
  key: 'savings' | 'commitments' | 'consistency' | 'budgets';
  label: string;
  /** 0–100. What this component scored on its own. */
  score: number;
  /** Share of the final score, after redistribution. 0–1. */
  weight: number;
  /** One line the user can act on. */
  detail: string;
  /**
   * How this component names itself when it is the thing dragging the score down.
   *
   * Splicing `label` into a sentence produced "Committed costs is holding it back" —
   * the labels are column headings, and headings do not conjugate. This is the same
   * component said as a phrase that fits mid-sentence.
   */
  drag: string;
}

export interface HealthScore {
  /** 0–100, or null when there is not enough to say anything. */
  score: number | null;
  grade: HealthGrade;
  confidence: HealthConfidence;
  components: HealthComponent[];
  /** The one thing most worth fixing, or null when nothing stands out. */
  weakest: HealthComponent | null;
  /** Plain-language summary. Never a number on its own. */
  headline: string;
  /** Why the confidence is what it is. */
  basis: string;
}

export interface HealthInput {
  savingsRate: number | null;
  /** Fixed commitments as a share of income, 0–1. */
  fixedExpenseRatio: number | null;
  /** Completed cycles, oldest first. */
  history: readonly CycleTrendPoint[];
  budgets: readonly BudgetEvaluation[];
}

/** Base weights. Redistributed proportionally when a component has no data. */
const WEIGHTS = { savings: 0.35, commitments: 0.25, consistency: 0.2, budgets: 0.2 } as const;

/**
 * Savings rate → score.
 *
 * 20% is the figure most personal-finance guidance settles on, so it scores well
 * rather than perfectly; 30%+ is genuinely strong. A negative rate — spending more
 * than came in — floors at zero rather than going negative, because the score is a
 * 0–100 scale and a component that can drag it below zero breaks the arithmetic.
 */
function savingsScore(rate: number): number {
  if (rate <= 0) return 0;
  if (rate >= 30) return 100;
  if (rate >= 20) return 80 + ((rate - 20) / 10) * 20;
  if (rate >= 10) return 55 + ((rate - 10) / 10) * 25;
  return (rate / 10) * 55;
}

/**
 * Commitment ratio → score. Lower is better.
 *
 * Under half of income committed leaves room to absorb a surprise. Past 70% almost
 * nothing is movable, which is the state that turns one bad month into a debt.
 */
function commitmentScore(ratio: number): number {
  if (ratio <= 0.3) return 100;
  if (ratio >= 0.8) return 0;
  return Math.round(((0.8 - ratio) / 0.5) * 100);
}

/**
 * Consistency → score, from how much spending swings between cycles.
 *
 * Uses the mean absolute deviation against the average rather than a standard
 * deviation: it is far less distorted by one unusual month, which on three or four
 * data points is exactly the distortion that matters.
 */
function consistencyScore(history: readonly CycleTrendPoint[]): { score: number; swing: number } | null {
  const spends = history.map((h) => h.spend as number).filter((v) => v > 0);
  if (spends.length < 2) return null;

  const mean = spends.reduce((a, b) => a + b, 0) / spends.length;
  if (mean <= 0) return null;

  const deviation = spends.reduce((a, v) => a + Math.abs(v - mean), 0) / spends.length;
  const swing = (deviation / mean) * 100;

  // 10% swing is normal life; 50% means the months have nothing in common.
  if (swing <= 10) return { score: 100, swing };
  if (swing >= 50) return { score: 0, swing };
  return { score: Math.round(((50 - swing) / 40) * 100), swing };
}

function budgetScore(budgets: readonly BudgetEvaluation[]): number | null {
  if (budgets.length === 0) return null;
  const kept = budgets.filter((b) => b.status !== 'over_budget').length;
  return Math.round((kept / budgets.length) * 100);
}

export function buildHealthScore(input: HealthInput): HealthScore {
  const parts: Array<{ component: Omit<HealthComponent, 'weight'>; weight: number }> = [];

  if (input.savingsRate !== null) {
    const score = Math.round(savingsScore(input.savingsRate));
    parts.push({
      weight: WEIGHTS.savings,
      component: {
        key: 'savings',
        label: 'Savings rate',
        drag: 'how little is left over',
        score,
        detail:
          input.savingsRate <= 0
            ? 'You are spending everything that comes in.'
            : `Keeping ${Math.round(input.savingsRate)}% of your income.`,
      },
    });
  }

  if (input.fixedExpenseRatio !== null) {
    const score = commitmentScore(input.fixedExpenseRatio);
    const percent = Math.round(input.fixedExpenseRatio * 100);
    parts.push({
      weight: WEIGHTS.commitments,
      component: {
        key: 'commitments',
        label: 'Committed costs',
        drag: 'how much is already committed',
        score,
        detail:
          percent >= 70
            ? `${percent}% of income is committed — very little is movable.`
            : `${percent}% of income goes to fixed costs.`,
      },
    });
  }

  const consistency = consistencyScore(input.history);
  if (consistency) {
    parts.push({
      weight: WEIGHTS.consistency,
      component: {
        key: 'consistency',
        label: 'Consistency',
        drag: 'how much spending swings month to month',
        score: consistency.score,
        detail:
          consistency.swing <= 10
            ? 'Your months look much like each other.'
            : `Spending swings about ${Math.round(consistency.swing)}% between cycles.`,
      },
    });
  }

  const budgets = budgetScore(input.budgets);
  if (budgets !== null) {
    const over = input.budgets.filter((b) => b.status === 'over_budget').length;
    parts.push({
      weight: WEIGHTS.budgets,
      component: {
        key: 'budgets',
        label: 'Budgets kept',
        drag: 'budgets being overrun',
        score: budgets,
        detail:
          over === 0
            ? `All ${input.budgets.length} budgets are holding.`
            : `${over} of ${input.budgets.length} budgets are over.`,
      },
    });
  }

  if (parts.length === 0) {
    return {
      score: null,
      grade: 'steady',
      confidence: 'provisional',
      components: [],
      weakest: null,
      headline: 'Not enough recorded yet to score anything.',
      basis: 'Record a cycle of spending and set your income to see this.',
    };
  }

  /*
   * Weights are redistributed across what IS known.
   *
   * Scoring a missing component as zero would punish someone for not having set a
   * budget, which is a different thing from having set one and blown it.
   */
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const components: HealthComponent[] = parts.map((p) => ({
    ...p.component,
    weight: p.weight / totalWeight,
  }));

  const score = Math.round(components.reduce((a, c) => a + c.score * c.weight, 0));
  const completed = input.history.filter((h) => (h.spend as number) > 0).length;

  const confidence: HealthConfidence =
    completed >= 4 ? 'good' : completed >= 2 ? 'fair' : 'provisional';

  const weakest = [...components].sort((a, b) => a.score - b.score)[0] ?? null;

  return {
    score,
    grade: gradeFor(score),
    confidence,
    components,
    // Only worth naming when it is actually dragging: a "weakest" of 90 is not a problem.
    weakest: weakest && weakest.score < 70 ? weakest : null,
    headline: headlineFor(score, weakest),
    basis: basisFor(confidence, completed),
  };
}

function gradeFor(score: number): HealthGrade {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'steady';
  if (score >= 40) return 'stretched';
  return 'strained';
}

function headlineFor(score: number, weakest: HealthComponent | null): string {
  const grade = gradeFor(score);
  const base =
    grade === 'strong'
      ? 'Your finances are in good shape.'
      : grade === 'steady'
        ? 'Steady, with room to improve.'
        : grade === 'stretched'
          ? 'Stretched — worth tightening something.'
          : 'Under strain.';

  if (weakest && weakest.score < 70) {
    return `${base} The main drag is ${weakest.drag}.`;
  }
  return base;
}

function basisFor(confidence: HealthConfidence, completed: number): string {
  if (confidence === 'good') return `Based on ${completed} completed cycles.`;
  if (confidence === 'fair') return `Based on ${completed} cycles — it will settle as more build up.`;
  return 'Provisional — based on less than two completed cycles.';
}

export { divide, sub, sum, ZERO };
export type { Minor };
