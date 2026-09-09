/**
 * What the home-screen widget shows.
 *
 * A widget is glanced at, not read. It answers one question — "am I alright today?" —
 * and everything here exists to make that answerable without opening the app.
 *
 * Pure, and deliberately tiny: the widget renders in a headless task with no access to
 * the app's query cache or Supabase session, so the app has to hand it a finished
 * snapshot rather than anything it would need to compute.
 */

import { divide, sub, type Minor } from './money';
import type { ISODate } from './date';

export type WidgetTone = 'good' | 'watch' | 'over';

export interface WidgetSnapshot {
  /** Spent today, so far. */
  today: Minor;
  /** What can be spent per remaining day and still land on target. */
  safeDaily: Minor;
  /** Left in the cycle, after the savings target. */
  remaining: Minor;
  daysLeft: number;
  tone: WidgetTone;
  /** One short line. Never a sentence — a widget is glanced at. */
  caption: string;
  currency: string;
  /** When this was computed, so a stale widget can say so. */
  asOf: ISODate;
}

export interface WidgetInput {
  today: Minor;
  remaining: Minor;
  daysLeft: number;
  currency: string;
  asOf: ISODate;
  /** Formatter injected so core stays free of currency policy. */
  money: (value: Minor) => string;
}

/**
 * Build the snapshot.
 *
 * `safeDaily` divides what is left by the days remaining INCLUDING today — spending
 * the last day's allowance twice is exactly the error this figure exists to prevent.
 * With no days left it is whatever remains, not a division by zero.
 */
export function buildWidgetSnapshot(input: WidgetInput): WidgetSnapshot {
  const days = Math.max(1, input.daysLeft);
  const safeDaily = input.daysLeft <= 0 ? input.remaining : divide(input.remaining, days);

  const tone: WidgetTone =
    (input.remaining as number) <= 0
      ? 'over'
      : (input.today as number) > (safeDaily as number)
        ? 'watch'
        : 'good';

  return {
    today: input.today,
    safeDaily,
    remaining: input.remaining,
    daysLeft: input.daysLeft,
    tone,
    caption: captionFor(tone, safeDaily, sub(safeDaily, input.today), input.money),
    currency: input.currency,
    asOf: input.asOf,
  };
}

function captionFor(
  tone: WidgetTone,
  safeDaily: Minor,
  headroom: Minor,
  money: (value: Minor) => string,
): string {
  if (tone === 'over') return 'Past your budget';
  if (tone === 'watch') return `${money(safeDaily)} was today's limit`;
  return `${money(headroom)} left today`;
}

/** Storage key shared between the app and the widget's headless task. */
export const WIDGET_SNAPSHOT_KEY = 'spendcents.widget.snapshot';
