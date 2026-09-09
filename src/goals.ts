/**
 * Goal progress.
 *
 * A goal is a promise about the future, and the honest ways to be wrong about one are
 * specific:
 *
 *   * A GOAL WITH NO DATE CANNOT BE BEHIND. "On track" implies a schedule; without a
 *     target date there is nothing to be on track against, and saying so is better
 *     than picking a status that sounds informative.
 *   * A GOAL WITH NO CONTRIBUTION HAS NO COMPLETION DATE. Dividing by zero gives
 *     Infinity, and rendering that as a year is worse than admitting the plan does not
 *     reach the target. So does a date fifty years out.
 *   * ARRIVING LATE IS NOT THE SAME AS NOT ARRIVING. A goal funded too slowly still
 *     gets there; the useful number is what it would take to arrive on time.
 *
 * Pure, so each of those is a test rather than a convention.
 */

import { addMonths, parseISO, type ISODate } from './date';
import { ZERO, clampAtZero, divide, percentage, sub, type Minor } from './money';

/** Beyond this a completion date is arithmetic, not a plan. */
const MAX_PROJECTION_MONTHS = 600;

export type GoalStatus =
  /** Target reached. */
  | 'complete'
  /** On course to arrive by the target date. */
  | 'on_track'
  /** Will arrive, but after the target date. */
  | 'behind'
  /** Nothing is being contributed, so it will not arrive at all. */
  | 'stalled'
  /** No target date, so there is no schedule to judge against. */
  | 'undated';

export interface GoalProgress {
  status: GoalStatus;
  /** 0–100, capped: a goal at 140% funded is complete, not 140% on track. */
  percentComplete: number;
  remaining: Minor;
  /** Whole months until the target date, floored at zero. Null without one. */
  monthsToTarget: number | null;
  /**
   * What must go in each month to arrive by the target date. Null when there is no
   * date, and ZERO when the goal is already met.
   */
  requiredMonthly: Minor | null;
  /** requiredMonthly − monthlyContribution, floored at zero. Null without a date. */
  monthlyShortfall: Minor | null;
  /** When it lands at the current contribution. Null when it never does. */
  projectedDate: ISODate | null;
  /** Months to completion at the current contribution. Null when it never completes. */
  projectedMonths: number | null;
}

export interface GoalProgressInput {
  targetAmount: Minor;
  currentAmount: Minor;
  targetDate: ISODate | null;
  monthlyContribution: Minor;
  today: ISODate;
}

export function goalProgress(input: GoalProgressInput): GoalProgress {
  const { targetAmount, currentAmount, targetDate, monthlyContribution, today } = input;

  const remaining = clampAtZero(sub(targetAmount, currentAmount));
  const rawPercent = percentage(currentAmount, targetAmount) ?? 0;
  const percentComplete = Math.min(100, Math.max(0, rawPercent));

  const monthsToTarget = targetDate === null ? null : wholeMonthsBetween(today, targetDate);

  if (remaining === 0) {
    return {
      status: 'complete',
      percentComplete: 100,
      remaining: ZERO,
      monthsToTarget,
      requiredMonthly: targetDate === null ? null : ZERO,
      monthlyShortfall: targetDate === null ? null : ZERO,
      projectedDate: null,
      projectedMonths: 0,
    };
  }

  // Zero months left with money still owed means it is due now — the whole remainder
  // is required, not a division by zero.
  const requiredMonthly =
    monthsToTarget === null ? null : monthsToTarget === 0 ? remaining : divide(remaining, monthsToTarget);

  const contributes = (monthlyContribution as number) > 0;
  const projectedMonths = contributes
    ? Math.ceil((remaining as number) / (monthlyContribution as number))
    : null;

  const reachable = projectedMonths !== null && projectedMonths <= MAX_PROJECTION_MONTHS;
  const projectedDate = reachable ? addMonths(today, projectedMonths!) : null;

  const monthlyShortfall =
    requiredMonthly === null ? null : clampAtZero(sub(requiredMonthly, monthlyContribution));

  const status: GoalStatus = !contributes
    ? 'stalled'
    : targetDate === null
      ? 'undated'
      : (monthlyShortfall as number) > 0
        ? 'behind'
        : 'on_track';

  return {
    status,
    percentComplete,
    remaining,
    monthsToTarget,
    requiredMonthly,
    monthlyShortfall,
    projectedDate,
    projectedMonths,
  };
}

/**
 * Whole calendar months between two dates.
 *
 * Calendar arithmetic, not `days / 30.44`. That average floors a full year to eleven
 * months, which turns a correctly funded goal into one reported as behind — and the
 * user is then told to increase a contribution that was already right.
 *
 * Rounded down deliberately: a goal due in 45 days has one whole month of
 * contributions left, not one and a half. Rounding up would understate what is needed
 * each month, which is the direction that costs the user the goal.
 */
function wholeMonthsBetween(from: ISODate, to: ISODate): number {
  if (to <= from) return 0;
  const a = parseISO(from);
  const b = parseISO(to);
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  // The final month is not complete until the day-of-month is reached.
  return Math.max(0, b.day < a.day ? months - 1 : months);
}
