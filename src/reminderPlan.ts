/**
 * What to remind the user about, and when.
 *
 * Deliberately free of any notification API. Deciding which payments deserve a
 * warning, how far ahead, and what the message says is domain logic that has to be
 * testable without a device — `src/data/paymentReminders.ts` takes this plan and
 * hands it to the OS.
 */

import { occurrencesBetween, type ScheduledCommitment } from './schedule';
import { addDays, formatDayMonth, type ISODate, todayISO } from './date';
import { format as formatMoney, type Minor } from './money';

/**
 * iOS keeps only 64 pending local notifications and silently discards the rest, so a
 * user with many commitments would lose whichever ones happened to be scheduled last
 * — including the daily reminder. Staying well under the limit keeps the behaviour
 * predictable, and the schedule is rewritten on every launch anyway, so a horizon of
 * a few weeks loses nothing.
 */
export const MAX_SCHEDULED = 24;
const HORIZON_DAYS = 60;

export interface RemindableCommitment extends ScheduledCommitment {
  reminderEnabled: boolean;
  remindDaysBefore: number;
}

/** One notification we intend to schedule. Pure data, so it can be tested. */
export interface PlannedReminder {
  commitmentId: string;
  dueDate: ISODate;
  /** The day the notification fires — `remindDaysBefore` ahead of the due date. */
  fireDate: ISODate;
  title: string;
  body: string;
}

/**
 * Work out what should be scheduled, without touching the OS.
 *
 * Split out from the scheduling itself so the decisions — which commitments, how far
 * ahead, what the message says, what happens at the cap — are testable without a
 * device. Occurrences already in the past are dropped: the OS would fire them
 * immediately, which reads as a bug rather than a reminder.
 */
export function planReminders(
  commitments: RemindableCommitment[],
  today: ISODate = todayISO(),
  limit: number = MAX_SCHEDULED,
  settled: ReadonlySet<string> = new Set(),
): PlannedReminder[] {
  const horizon = addDays(today, HORIZON_DAYS);
  const planned: PlannedReminder[] = [];

  for (const commitment of commitments) {
    if (!commitment.reminderEnabled) continue;

    for (const dueDate of occurrencesBetween(commitment, today, horizon)) {
      const warning = Math.min(14, Math.max(0, Math.round(commitment.remindDaysBefore)));
      const fireDate = addDays(dueDate, -warning);
      // A due date whose warning window has already elapsed is not resurrected; the
      // calendar still shows it as due, which is the honest place for it.
      if (fireDate < today) continue;
      // Already paid. Reminding someone about rent they settled last week is how a
      // notification channel gets muted, and once muted the useful ones go too.
      if (settled.has(settledKey(commitment.id, dueDate))) continue;

      planned.push({
        commitmentId: commitment.id,
        dueDate,
        fireDate,
        title: warning === 0 ? `${commitment.name} is due today` : `${commitment.name} is due soon`,
        body: describe(commitment.name, commitment.amount, dueDate, warning),
      });
    }
  }

  // Soonest first, so the cap drops the most distant reminders rather than an
  // arbitrary subset — the near ones are the ones the user can still act on.
  planned.sort((a, b) => (a.fireDate === b.fireDate ? a.dueDate.localeCompare(b.dueDate) : a.fireDate.localeCompare(b.fireDate)));
  return planned.slice(0, limit);
}

/** Stable key for "this commitment, this due date" — shared with the caller. */
export function settledKey(commitmentId: string, dueDate: ISODate): string {
  return `${commitmentId}|${dueDate}`;
}

function describe(name: string, amount: Minor, dueDate: ISODate, warning: number): string {
  const money = formatMoney(amount);
  if (warning === 0) return `${money} for ${name} is due today.`;
  if (warning === 1) return `${money} for ${name} is due tomorrow.`;
  return `${money} for ${name} is due on ${formatDayMonth(dueDate)}.`;
}
