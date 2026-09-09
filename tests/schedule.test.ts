import { describe, it, expect } from 'vitest';
import {
  buildCalendar, calendarMonth, forecastCycle, occurrencesBetween, projectSchedule,
  type ScheduledCommitment,
} from '../src/schedule';
import { fromMajor, ZERO } from '../src/money';
import { txns, rs } from './helpers/factory';
import { cat } from './helpers/categories';

const today = '2026-08-27';

const rent: ScheduledCommitment = {
  id: 'c-rent', name: 'Rent', amount: fromMajor('25000'), interval: 'monthly',
  categoryId: cat('rent'), merchantKey: 'rent', isEssential: true,
  lastSeenDate: '2026-08-02', nextDueDate: '2026-09-02',
};

const netflix: ScheduledCommitment = {
  id: 'c-netflix', name: 'Netflix', amount: fromMajor('649'), interval: 'monthly',
  categoryId: cat('streaming'), merchantKey: 'netflix', isEssential: false,
  lastSeenDate: '2026-08-15', nextDueDate: '2026-09-15',
};

describe('occurrencesBetween', () => {
  it('lists every due date in the window', () => {
    expect(occurrencesBetween(rent, '2026-09-01', '2026-12-31')).toEqual([
      '2026-09-02', '2026-10-02', '2026-11-02', '2026-12-02',
    ]);
  });

  it('includes due dates already past inside the window', () => {
    const dates = occurrencesBetween(rent, '2026-06-01', '2026-09-30');
    expect(dates).toContain('2026-07-02');
    expect(dates).toContain('2026-08-02');
    expect(dates).toContain('2026-09-02');
  });

  it('clamps a month-end due date into short months', () => {
    const emi: ScheduledCommitment = { ...rent, id: 'c-emi', lastSeenDate: '2026-01-31', nextDueDate: null };
    const dates = occurrencesBetween(emi, '2026-02-01', '2026-04-30');
    expect(dates).toContain('2026-02-28');
  });

  it('returns nothing when the series has no anchor', () => {
    expect(occurrencesBetween({ ...rent, lastSeenDate: null, nextDueDate: null }, '2026-09-01', '2026-12-31')).toEqual([]);
  });

  it('returns nothing for an inverted window', () => {
    expect(occurrencesBetween(rent, '2026-12-31', '2026-01-01')).toEqual([]);
  });
});

describe('projectSchedule', () => {
  const paid = txns([
    { date: '2026-08-02', amount: '25000', merchantKey: 'rent', merchantName: 'Rent', categoryId: cat('rent') },
    { date: '2026-08-15', amount: '649', merchantKey: 'netflix', merchantName: 'Netflix', categoryId: cat('streaming') },
  ]);

  it('marks an occurrence paid when a matching payment exists', () => {
    const schedule = projectSchedule([rent, netflix], paid, '2026-08-01', '2026-08-31', today);
    const august = schedule.filter((o) => o.dueDate.startsWith('2026-08'));
    expect(august.every((o) => o.status === 'paid')).toBe(true);
    expect(august[0]!.paidBy?.amount).toBe(rs(25000));
  });

  it('marks a missed past occurrence overdue', () => {
    const schedule = projectSchedule([rent], [], '2026-08-01', '2026-08-31', today);
    expect(schedule.find((o) => o.dueDate === '2026-08-02')!.status).toBe('overdue');
  });

  it('marks a future occurrence upcoming', () => {
    const schedule = projectSchedule([rent], paid, '2026-09-01', '2026-09-30', today);
    expect(schedule[0]!.status).toBe('upcoming');
  });

  it('marks an occurrence falling exactly today as due', () => {
    const gym: ScheduledCommitment = {
      ...rent, id: 'c-gym', name: 'Gym', merchantKey: 'gym',
      lastSeenDate: '2026-07-27', nextDueDate: '2026-08-27',
    };
    const schedule = projectSchedule([gym], [], '2026-08-01', '2026-08-31', today);
    expect(schedule.find((o) => o.dueDate === today)!.status).toBe('due');
  });

  it('never lets one payment settle two occurrences', () => {
    // Only one rent payment exists, but two months are in the window.
    const schedule = projectSchedule([rent], paid, '2026-07-01', '2026-08-31', today);
    expect(schedule.filter((o) => o.status === 'paid')).toHaveLength(1);
    expect(schedule.filter((o) => o.status === 'overdue')).toHaveLength(1);
  });

  it('does not match a payment to a different merchant', () => {
    const wrongMerchant = txns([
      { date: '2026-08-02', amount: '25000', merchantKey: 'swiggy', merchantName: 'Swiggy' },
    ]);
    const schedule = projectSchedule([rent], wrongMerchant, '2026-08-01', '2026-08-31', today);
    expect(schedule[0]!.status).toBe('overdue');
  });

  it('does not match a payment weeks away from the due date', () => {
    const late = txns([
      { date: '2026-08-25', amount: '25000', merchantKey: 'rent', merchantName: 'Rent' },
    ]);
    const schedule = projectSchedule([rent], late, '2026-08-01', '2026-08-05', today);
    expect(schedule[0]!.status).toBe('overdue');
  });
});

describe('buildCalendar', () => {
  const spend = txns([
    { date: '2026-08-02', amount: '25000', merchantKey: 'rent', merchantName: 'Rent' },
    { date: '2026-08-02', amount: '400', merchantKey: 'cafe', merchantName: 'Cafe' },
    { date: '2026-08-27', amount: '640', merchantKey: 'zomato', merchantName: 'Zomato' },
  ]);

  it('gives one entry per day with the day’s spending', () => {
    const days = buildCalendar('2026-08-01', '2026-08-31', spend, [], today);
    expect(days).toHaveLength(31);
    const second = days.find((d) => d.date === '2026-08-02')!;
    expect(second.spent).toBe(rs(25400));
    expect(second.transactionCount).toBe(2);
  });

  it('marks today and future days', () => {
    const days = buildCalendar('2026-08-01', '2026-08-31', spend, [], today);
    expect(days.find((d) => d.date === today)!.isToday).toBe(true);
    expect(days.find((d) => d.date === '2026-08-31')!.isFuture).toBe(true);
    expect(days.find((d) => d.date === '2026-08-01')!.isFuture).toBe(false);
  });

  it('attaches commitments to their due day and excludes settled ones from the total', () => {
    const schedule = projectSchedule([rent], spend, '2026-08-01', '2026-08-31', today);
    const days = buildCalendar('2026-08-01', '2026-08-31', spend, schedule, today);
    const second = days.find((d) => d.date === '2026-08-02')!;
    expect(second.due).toHaveLength(1);
    // Already paid, so nothing is still owed that day.
    expect(second.dueTotal).toBe(0);
  });

  it('is empty of spending on a day with none', () => {
    const days = buildCalendar('2026-08-01', '2026-08-31', spend, [], today);
    const quiet = days.find((d) => d.date === '2026-08-10')!;
    expect(quiet.spent).toBe(0);
    expect(quiet.transactionCount).toBe(0);
  });
});

describe('calendarMonth', () => {
  it('pads the month out to whole Monday-start weeks', () => {
    const { from, to, monthStart, monthEnd } = calendarMonth('2026-08-15');
    expect(monthStart).toBe('2026-08-01');
    expect(monthEnd).toBe('2026-08-31');
    // 1 Aug 2026 is a Saturday, so the grid starts on Monday 27 July.
    expect(from).toBe('2026-07-27');
    expect(to).toBe('2026-09-06');
  });
});

describe('forecastCycle', () => {
  const schedule = projectSchedule([rent, netflix], [], '2026-08-27', '2026-09-30', today);

  it('separates what is committed from what is estimated', () => {
    const f = forecastCycle({
      income: fromMajor('75000'),
      spentToDate: fromMajor('20000'),
      schedule,
      today,
      cycleEnd: '2026-09-30',
      typicalDailyDiscretionary: fromMajor('500'),
    });
    expect(f.committed).toBe(rs(25649));
    expect(f.remainingBeforeEstimate).toBe(rs(29351));
    expect(f.estimatedDiscretionary).toBe(rs(17000)); // 34 days × ₹500
    expect(f.projectedRemaining).toBe(rs(12351));
    expect(f.hasHistory).toBe(true);
  });

  it('says so when there is no history to estimate from', () => {
    const f = forecastCycle({
      income: fromMajor('75000'),
      spentToDate: fromMajor('20000'),
      schedule,
      today,
      cycleEnd: '2026-09-30',
    });
    expect(f.hasHistory).toBe(false);
    expect(f.estimatedDiscretionary).toBe(0);
    expect(f.projectedRemaining).toBe(f.remainingBeforeEstimate);
  });

  it('ignores commitments already settled', () => {
    const settled = projectSchedule(
      [rent],
      txns([{ date: '2026-09-02', amount: '25000', merchantKey: 'rent', merchantName: 'Rent' }]),
      '2026-08-27', '2026-09-30', today,
    );
    const f = forecastCycle({
      income: fromMajor('75000'), spentToDate: fromMajor('20000'),
      schedule: settled, today, cycleEnd: '2026-09-30',
    });
    expect(f.committed).toBe(0);
  });

  it('can report a negative projection rather than hiding it', () => {
    const f = forecastCycle({
      income: fromMajor('30000'), spentToDate: fromMajor('20000'),
      schedule, today, cycleEnd: '2026-09-30',
    });
    expect(f.projectedRemaining).toBeLessThan(0);
  });

  it('handles the last day of a cycle without dividing by zero', () => {
    const f = forecastCycle({
      income: fromMajor('75000'), spentToDate: fromMajor('20000'),
      schedule: [], today, cycleEnd: today, typicalDailyDiscretionary: fromMajor('500'),
    });
    expect(f.daysRemaining).toBe(0);
    expect(f.estimatedDiscretionary).toBe(0);
  });
});

describe('forecastCycle with undated commitments', () => {
  it('counts committed money the schedule cannot place', () => {
    // Three bills with no anchor generate no occurrences at all. Leaving them out
    // understated `committed` by their whole value and made the projection look far
    // healthier than it was.
    const forecast = forecastCycle({
      income: fromMajor('56000'),
      spentToDate: fromMajor('25544'),
      schedule: [],
      today: '2026-09-03',
      cycleEnd: '2026-09-30',
      undatedCommitted: fromMajor('27161'),
    });
    expect(forecast.committed).toBe(fromMajor('27161'));
    expect(forecast.undatedCommitted).toBe(fromMajor('27161'));
    expect(forecast.remainingBeforeEstimate).toBe(fromMajor('3295'));
  });

  it('adds undated money on top of what is scheduled', () => {
    const forecast = forecastCycle({
      income: fromMajor('50000'),
      spentToDate: ZERO,
      schedule: [
        {
          commitmentId: 'c1', name: 'Rent', amount: fromMajor('8500'),
          dueDate: '2026-09-10', categoryId: null, isEssential: true, status: 'upcoming',
        },
      ],
      today: '2026-09-03',
      cycleEnd: '2026-09-30',
      undatedCommitted: fromMajor('6661'),
    });
    expect(forecast.committed).toBe(fromMajor('15161'));
  });

  it('defaults to zero so an unaware caller is unaffected', () => {
    const forecast = forecastCycle({
      income: fromMajor('50000'), spentToDate: ZERO, schedule: [],
      today: '2026-09-03', cycleEnd: '2026-09-30',
    });
    expect(forecast.undatedCommitted).toBe(ZERO);
    expect(forecast.committed).toBe(ZERO);
  });
});
