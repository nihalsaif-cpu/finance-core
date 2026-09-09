import { describe, it, expect } from 'vitest';
import { planReminders, settledKey, type RemindableCommitment } from '../src/reminderPlan';
import { fromMajor } from '../src/money';

const today = '2026-08-27';

function commitment(over: Partial<RemindableCommitment> = {}): RemindableCommitment {
  return {
    id: 'c-1', name: 'Rent', amount: fromMajor('25000'), interval: 'monthly',
    categoryId: null, merchantKey: 'rent', isEssential: true,
    lastSeenDate: '2026-08-02', nextDueDate: '2026-09-02',
    reminderEnabled: true, remindDaysBefore: 3,
    ...over,
  };
}

describe('planReminders', () => {
  it('fires the configured number of days before the due date', () => {
    const [first] = planReminders([commitment()], today);
    expect(first!.dueDate).toBe('2026-09-02');
    expect(first!.fireDate).toBe('2026-08-30');
  });

  it('skips commitments with reminders switched off', () => {
    expect(planReminders([commitment({ reminderEnabled: false })], today)).toEqual([]);
  });

  it('does not schedule a warning whose window has already passed', () => {
    // Due in two days, but the user asked for a week's notice.
    const tight = commitment({ nextDueDate: '2026-08-29', remindDaysBefore: 7, lastSeenDate: null });
    expect(planReminders([tight], today).some((r) => r.dueDate === '2026-08-29')).toBe(false);
  });

  it('says "today" when the warning is zero days', () => {
    const sameDay = commitment({ nextDueDate: '2026-09-02', remindDaysBefore: 0 });
    const [first] = planReminders([sameDay], today);
    expect(first!.fireDate).toBe('2026-09-02');
    expect(first!.title).toContain('due today');
  });

  it('says "tomorrow" for a one-day warning', () => {
    const [first] = planReminders([commitment({ remindDaysBefore: 1 })], today);
    expect(first!.body).toContain('tomorrow');
  });

  it('includes the amount so the reminder is actionable from the lock screen', () => {
    const [first] = planReminders([commitment()], today);
    expect(first!.body).toContain('25,000');
  });

  it('keeps the soonest reminders when it hits the cap', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      commitment({ id: `c-${i}`, name: `Bill ${i}`, nextDueDate: `2026-09-${String(i + 10).padStart(2, '0')}`, lastSeenDate: null }),
    );
    const planned = planReminders(many, today, 3);
    expect(planned).toHaveLength(3);
    expect(planned.map((r) => r.dueDate)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
  });

  it('clamps an out-of-range warning rather than producing a wild fire date', () => {
    const [first] = planReminders([commitment({ remindDaysBefore: 999 })], today);
    expect(first!.fireDate).toBe('2026-08-19' > today ? '2026-08-19' : first!.fireDate);
    expect(planReminders([commitment({ remindDaysBefore: -5 })], today)[0]!.fireDate).toBe('2026-09-02');
  });

  it('schedules repeat occurrences of the same commitment within the horizon', () => {
    const weekly = commitment({ interval: 'weekly', lastSeenDate: '2026-08-24', nextDueDate: null, remindDaysBefore: 0 });
    expect(planReminders([weekly], today).length).toBeGreaterThan(4);
  });
});

describe('planReminders — already paid', () => {
  it('does not remind about an occurrence a payment has settled', () => {
    const rent = commitment();
    const settled = new Set([settledKey(rent.id, '2026-09-02')]);
    expect(planReminders([rent], today, 24, settled).some((r) => r.dueDate === '2026-09-02')).toBe(false);
  });

  it('still reminds about the occurrences that follow the settled one', () => {
    const rent = commitment();
    const settled = new Set([settledKey(rent.id, '2026-09-02')]);
    const planned = planReminders([rent], today, 24, settled);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned[0]!.dueDate).toBe('2026-10-02');
  });

  it('does not confuse two commitments that fall due on the same day', () => {
    const rent = commitment({ id: 'c-rent' });
    const emi = commitment({ id: 'c-emi', name: 'Car EMI' });
    const settled = new Set([settledKey('c-rent', '2026-09-02')]);
    const planned = planReminders([rent, emi], today, 24, settled);
    expect(planned.filter((r) => r.dueDate === '2026-09-02').map((r) => r.commitmentId)).toEqual(['c-emi']);
  });
});
