/**
 * Deciding what is worth interrupting someone for.
 *
 * The app already knows when a budget is blown; until now it could only say so if you
 * happened to open it. This module decides WHAT to say and WHETHER it is worth saying
 * — the scheduling is somebody else's problem.
 *
 * The governing rule is that a notification the user did not need costs more than one
 * they missed. A muted channel delivers nothing at all, so every rule here is biased
 * toward silence: one alert at a time, never the same one twice, and nothing at all
 * for a situation the user cannot act on.
 */

import type { BudgetEvaluation } from './analytics';
import type { VelocityResult } from './velocity';
import { formatPercent, type Minor } from './money';
import type { ISODate } from './date';

export type AlertKind =
  | 'budget_exceeded'
  | 'budget_warning'
  | 'projected_over'
  | 'pace_critical'
  | 'pace_warning'
  | 'savings_risk';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  /** Stable across evaluations, so the same alert is not sent twice. */
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** Notification title. Short enough to survive a lock screen. */
  title: string;
  /** One sentence. Says the number and what it means. */
  body: string;
}

export interface AlertPreferences {
  enabled: boolean;
  budgetWarning: boolean;
  budgetExceeded: boolean;
  paceWarning: boolean;
  savingsRisk: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

export interface AlertInput {
  budgets: readonly BudgetEvaluation[];
  velocity: VelocityResult;
  /** Days left in the cycle, including today. */
  daysRemaining: number;
  savingsTarget: Minor;
  projectedSavings: Minor;
  preferences: AlertPreferences;
  money: (value: Minor) => string;
  /** Identifies this cycle, so an alert can fire again next month. */
  cycleKey: string;
}

/** A budget is "near" its limit here. Below this it is just a number going up. */
const WARN_AT = 80;

/**
 * Everything currently worth saying, most severe first.
 *
 * Returns all of them; the caller decides how many to send. Keeping the ranking here
 * means the daily digest and an immediate alert agree about what matters most.
 */
export function evaluateAlerts(input: AlertInput): Alert[] {
  const { preferences: prefs } = input;
  if (!prefs.enabled) return [];

  const alerts: Alert[] = [];
  const suffix = `:${input.cycleKey}`;

  for (const budget of input.budgets) {
    const label = budget.label;

    if (prefs.budgetExceeded && budget.status === 'over_budget') {
      alerts.push({
        key: `budget_exceeded:${budget.categoryId ?? 'all'}${suffix}`,
        kind: 'budget_exceeded',
        severity: 'critical',
        title: `${label} is over budget`,
        body: `${input.money(budget.spent)} of ${input.money(budget.budget)} — ${formatPercent(budget.percentUsed)} used.`,
      });
      continue;
    }

    /*
     * Projected-over is reported only while there is still time to act on it.
     *
     * On the last day of the cycle the projection is a formality — the money is
     * effectively spent, and saying so achieves nothing but a buzz.
     */
    if (prefs.budgetWarning && budget.status === 'projected_over' && input.daysRemaining > 2) {
      alerts.push({
        key: `projected_over:${budget.categoryId ?? 'all'}${suffix}`,
        kind: 'projected_over',
        severity: 'warning',
        title: `${label} is heading over`,
        body: `On track for ${input.money(budget.projected)} against a ${input.money(budget.budget)} budget.`,
      });
      continue;
    }

    if (
      prefs.budgetWarning &&
      budget.status === 'near_limit' &&
      (budget.percentUsed ?? 0) >= WARN_AT
    ) {
      alerts.push({
        key: `budget_warning:${budget.categoryId ?? 'all'}${suffix}`,
        kind: 'budget_warning',
        severity: 'warning',
        title: `${label} is nearly spent`,
        body: `${formatPercent(budget.percentUsed)} used, ${input.money(budget.remaining)} left for ${input.daysRemaining} ${input.daysRemaining === 1 ? 'day' : 'days'}.`,
      });
    }
  }

  if (prefs.paceWarning) {
    if (input.velocity.status === 'critical') {
      alerts.push({
        key: `pace_critical${suffix}`,
        kind: 'pace_critical',
        severity: 'critical',
        title: 'Spending well ahead of plan',
        body: `On course to finish ${input.money(input.velocity.projectedOverspend)} over.`,
      });
    } else if (input.velocity.status === 'over' && input.daysRemaining > 2) {
      alerts.push({
        key: `pace_warning${suffix}`,
        kind: 'pace_warning',
        severity: 'warning',
        title: 'Spending ahead of plan',
        body: `${input.money(input.velocity.safeDailySpend)} a day keeps you on track for the last ${input.daysRemaining} days.`,
      });
    }
  }

  /*
   * A savings target only raises an alert when there IS one.
   *
   * Warning someone about missing a goal they never set is the clearest possible way
   * to teach them the notifications are noise.
   */
  if (
    prefs.savingsRisk &&
    (input.savingsTarget as number) > 0 &&
    (input.projectedSavings as number) < (input.savingsTarget as number) &&
    input.daysRemaining > 3
  ) {
    alerts.push({
      key: `savings_risk${suffix}`,
      kind: 'savings_risk',
      severity: 'warning',
      title: 'Savings target at risk',
      body: `Heading for ${input.money(input.projectedSavings)} against a ${input.money(input.savingsTarget)} target.`,
    });
  }

  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Whether the clock is inside the user's quiet hours.
 *
 * Handles a window that crosses midnight (22:00–07:00), which is the normal case and
 * the one a naive `start <= hour < end` gets exactly backwards.
 */
export function inQuietHours(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * Which alerts are new since the last time we notified.
 *
 * Keyed by cycle, so "Food is over budget" fires once this month and again next month
 * — but not every time the app refreshes, which would be several times an hour.
 */
export function unsentAlerts(alerts: readonly Alert[], alreadySent: Iterable<string>): Alert[] {
  const sent = new Set(alreadySent);
  return alerts.filter((a) => !sent.has(a.key));
}

/** The one line a daily digest should lead with, or null when all is well. */
export function digestLine(alerts: readonly Alert[]): Alert | null {
  return alerts[0] ?? null;
}

export type { ISODate };
