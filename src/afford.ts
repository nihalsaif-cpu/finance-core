/**
 * "Can I afford this?"
 *
 * The honest version of this feature is not a yes/no oracle — nobody can know your
 * future spending. What it can do is state the consequence: "yes, and it leaves you
 * ₹4,200 short of your savings target". The verdict is always accompanied by the
 * arithmetic behind it, so the user can disagree with the assumption rather than the
 * conclusion.
 *
 * Deliberately never says "you can't afford this". It is the user's money; the app's
 * job is to make the trade-off visible, not to forbid a purchase.
 */

import type { CycleProgress } from './cycle';
import { ZERO, clampAtZero, divide, sub, type Minor } from './money';
import type { VelocityResult } from './velocity';

export type AffordVerdict = 'comfortable' | 'possible' | 'not_recommended';

export interface AffordInput {
  amount: Minor;
  description?: string;
  progress: CycleProgress;
  velocity: VelocityResult;
  /** Income recorded (or expected) this cycle. */
  income: Minor;
  /** Spend so far this cycle. */
  spentToDate: Minor;
  /** The user's savings target for the cycle. Zero means "not set". */
  savingsTarget: Minor;
  /** Recurring charges still due before the cycle ends. */
  upcomingCommitments: Minor;
  /** Typical discretionary spend per cycle, for context. */
  typicalDiscretionary?: Minor;
  /**
   * Formats an amount for the reason strings. Injected rather than hardcoded so this
   * module carries no currency policy and stays testable with a stub.
   */
  formatMoney: (value: Minor) => string;
}

export interface AffordResult {
  verdict: AffordVerdict;
  /** One-line answer in plain language. */
  headline: string;
  /** The arithmetic, stated so the user can check it. */
  reasons: string[];
  /** Money left this cycle after the purchase and known commitments. */
  remainingAfter: Minor;
  /** New safe daily allowance for the rest of the cycle. */
  safeDailyAfter: Minor;
  /** How far the purchase pushes them below the savings target. Zero if it does not. */
  savingsShortfall: Minor;
  /** Projected end-of-cycle spend including this purchase. */
  projectedAfter: Minor;
  /** Amount by which the projection would exceed income. */
  projectedOverspendAfter: Minor;
  /** The purchase as a share of remaining spendable money, 0–1+. */
  shareOfRemaining: number | null;
}

export function evaluateAffordability(input: AffordInput): AffordResult {
  const {
    amount, progress, velocity, income, spentToDate, savingsTarget, upcomingCommitments,
  } = input;
  const fmtShort = input.formatMoney;

  const daysRemaining = progress.daysRemaining;

  // What is genuinely uncommitted right now: income, less what is already spent,
  // less what is contractually due before the cycle ends.
  const uncommitted = sub(sub(income, spentToDate), upcomingCommitments);
  const remainingAfter = sub(uncommitted, amount);

  const projectedAfter = (velocity.projectedTotal + amount) as Minor;
  const projectedOverspendAfter = clampAtZero(sub(projectedAfter, income));

  const projectedSavingsAfter = sub(income, projectedAfter);
  const savingsShortfall =
    savingsTarget > 0 ? clampAtZero(sub(savingsTarget, projectedSavingsAfter)) : ZERO;

  const safeDailyAfter =
    daysRemaining > 0 ? divide(clampAtZero(remainingAfter), daysRemaining) : clampAtZero(remainingAfter);

  const shareOfRemaining =
    (uncommitted as number) > 0 ? (amount as number) / (uncommitted as number) : null;

  const reasons: string[] = [];
  let verdict: AffordVerdict;
  let headline: string;

  if (remainingAfter < 0) {
    verdict = 'not_recommended';
    headline = 'This would take you past what is left for the cycle.';
    reasons.push(
      `After this you would be ${fmtShort(sub(ZERO, remainingAfter))} short of covering the rest of the cycle.`,
    );
  } else if (projectedOverspendAfter > 0) {
    verdict = 'not_recommended';
    headline = 'Possible, but it would push you past your income this cycle.';
    reasons.push(
      `At your current rate you would finish about ${fmtShort(projectedOverspendAfter)} over what you earn.`,
    );
  } else if (savingsShortfall > 0) {
    verdict = 'possible';
    headline = 'You can cover this, but it comes out of your savings.';
    reasons.push(`It would leave you about ${fmtShort(savingsShortfall)} short of your savings target.`);
  } else if (shareOfRemaining !== null && shareOfRemaining > 0.5) {
    verdict = 'possible';
    headline = 'Affordable, but it takes a large share of what is left.';
    reasons.push(`This is ${Math.round(shareOfRemaining * 100)}% of your uncommitted money for the cycle.`);
  } else {
    verdict = 'comfortable';
    headline = 'This fits comfortably.';
  }

  reasons.push(
    `${fmtShort(uncommitted)} is uncommitted right now, after ${fmtShort(spentToDate)} spent` +
      (upcomingCommitments > 0 ? ` and ${fmtShort(upcomingCommitments)} of bills still due.` : '.'),
  );

  if (daysRemaining > 0) {
    reasons.push(
      `That would leave about ${fmtShort(safeDailyAfter)} a day for the remaining ${daysRemaining} ` +
        `${daysRemaining === 1 ? 'day' : 'days'}.`,
    );
  }

  // State the ACTUAL reason confidence is low. "Early in the cycle" printed on day 26
  // is visibly wrong and undermines every other figure on the screen.
  if (velocity.confidence === 'low') {
    reasons.push(
      progress.elapsedFraction < 0.25
        ? 'This is early in the cycle, so the projection is rough.'
        : 'This uses a straight-line estimate — it will sharpen once you have a few cycles of history.',
    );
  }

  return {
    verdict,
    headline,
    reasons,
    remainingAfter,
    safeDailyAfter,
    savingsShortfall,
    projectedAfter,
    projectedOverspendAfter,
    shareOfRemaining,
  };
}

export const VERDICT_LABEL: Record<AffordVerdict, string> = {
  comfortable: 'Comfortable',
  possible: 'Possible, with a trade-off',
  not_recommended: 'Not recommended',
};
