import { describe, it, expect } from 'vitest';
import * as C from '../src/cycle';

const first: C.CycleConfig = { startDay: 1, frequency: 'monthly' };
const twentyEighth: C.CycleConfig = { startDay: 28, frequency: 'monthly' };
const thirtyFirst: C.CycleConfig = { startDay: 31, frequency: 'monthly' };

describe('monthly cycles', () => {
  it('aligns with the calendar month when payday is the 1st', () => {
    const c = C.cycleContaining('2026-08-14', first);
    expect(c.start).toBe('2026-08-01');
    expect(c.end).toBe('2026-08-31');
    expect(c.totalDays).toBe(31);
    expect(c.label).toBe('Aug 2026');
  });

  it('spans two calendar months when payday is the 28th', () => {
    const c = C.cycleContaining('2026-09-02', twentyEighth);
    expect(c.start).toBe('2026-08-28');
    expect(c.end).toBe('2026-09-27');
    expect(c.totalDays).toBe(31);
    expect(c.label).toBe('28 Aug – 27 Sep');
  });

  it('puts a date before the payday into the previous cycle', () => {
    const c = C.cycleContaining('2026-08-27', twentyEighth);
    expect(c.start).toBe('2026-07-28');
    expect(c.end).toBe('2026-08-27');
  });

  it('clamps a 31st payday into short months', () => {
    // Jan 31 -> Feb 27 (Feb payday clamps to the 28th).
    const jan = C.cycleContaining('2026-02-10', thirtyFirst);
    expect(jan.start).toBe('2026-01-31');
    expect(jan.end).toBe('2026-02-27');

    const feb = C.nextCycle(jan, thirtyFirst);
    expect(feb.start).toBe('2026-02-28');
    expect(feb.end).toBe('2026-03-30');

    const mar = C.nextCycle(feb, thirtyFirst);
    expect(mar.start).toBe('2026-03-31');
    expect(mar.end).toBe('2026-04-29');
  });

  it('never leaves a gap or an overlap between consecutive cycles', () => {
    for (const config of [first, twentyEighth, thirtyFirst, { startDay: 15, frequency: 'monthly' } as const]) {
      let c = C.cycleContaining('2025-01-05', config);
      for (let i = 0; i < 40; i++) {
        const next = C.nextCycle(c, config);
        expect(C.cycleContaining(next.start, config).start, `${config.startDay}`).toBe(next.start);
        // The day after this cycle's end must be exactly the next cycle's start.
        expect(next.start > c.end).toBe(true);
        expect(C.cycleContaining(c.end, config).start).toBe(c.start);
        c = next;
      }
    }
  });

  it('round-trips next/previous', () => {
    const c = C.cycleContaining('2026-08-14', twentyEighth);
    expect(C.previousCycle(C.nextCycle(c, twentyEighth), twentyEighth)).toEqual(c);
  });

  it('crosses the year boundary', () => {
    const c = C.cycleContaining('2027-01-05', twentyEighth);
    expect(c.start).toBe('2026-12-28');
    expect(c.end).toBe('2027-01-27');
  });
});

describe('other frequencies', () => {
  it('handles weekly cycles from an anchor', () => {
    const config: C.CycleConfig = { startDay: 1, frequency: 'weekly', anchorDate: '2026-08-03' };
    const c = C.cycleContaining('2026-08-14', config);
    expect(c.start).toBe('2026-08-10');
    expect(c.end).toBe('2026-08-16');
    expect(c.totalDays).toBe(7);
  });

  it('handles biweekly cycles', () => {
    const config: C.CycleConfig = { startDay: 1, frequency: 'biweekly', anchorDate: '2026-08-03' };
    const c = C.cycleContaining('2026-08-20', config);
    expect(c.start).toBe('2026-08-17');
    expect(c.totalDays).toBe(14);
  });

  it('handles semimonthly cycles', () => {
    const config: C.CycleConfig = { startDay: 1, frequency: 'semimonthly' };
    expect(C.cycleContaining('2026-08-05', config).start).toBe('2026-08-01');
    expect(C.cycleContaining('2026-08-05', config).end).toBe('2026-08-15');
    expect(C.cycleContaining('2026-08-20', config).start).toBe('2026-08-16');
    expect(C.cycleContaining('2026-08-20', config).end).toBe('2026-08-31');
  });
});

describe('cycleProgress', () => {
  it('reports day N of M', () => {
    const c = C.cycleContaining('2026-08-15', first);
    const p = C.cycleProgress(c, '2026-08-15');
    expect(p.dayIndex).toBe(15);
    expect(p.daysRemaining).toBe(16);
    expect(p.isCurrent).toBe(true);
    expect(C.progressLabel(p)).toBe('Day 15 of 31');
  });

  it('treats a finished cycle as fully elapsed', () => {
    const c = C.cycleContaining('2026-07-15', first);
    const p = C.cycleProgress(c, '2026-08-26');
    expect(p.dayIndex).toBe(31);
    expect(p.daysRemaining).toBe(0);
    expect(p.elapsedFraction).toBe(1);
    expect(p.isComplete).toBe(true);
  });

  it('reports nothing elapsed for a future cycle', () => {
    const c = C.cycleContaining('2026-12-15', first);
    const p = C.cycleProgress(c, '2026-08-26');
    expect(p.daysElapsed).toBe(0);
    expect(p.elapsedFraction).toBe(0);
    expect(p.isCurrent).toBe(false);
  });

  it('reports the last day as fully elapsed but current', () => {
    const c = C.cycleContaining('2026-08-15', first);
    const p = C.cycleProgress(c, '2026-08-31');
    expect(p.dayIndex).toBe(31);
    expect(p.daysRemaining).toBe(0);
    expect(p.isCurrent).toBe(true);
  });
});

describe('recentCycles', () => {
  it('returns N cycles oldest-first ending with the current one', () => {
    const cycles = C.recentCycles('2026-08-14', first, 3);
    expect(cycles.map((c) => c.start)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
  });

  it('lists cycles across a range', () => {
    const cycles = C.cyclesBetween('2026-06-10', '2026-08-14', first);
    expect(cycles.map((c) => c.label)).toEqual(['Jun 2026', 'Jul 2026', 'Aug 2026']);
  });
});

describe('nextPayday', () => {
  it('finds the upcoming payday', () => {
    expect(C.nextPayday('2026-08-14', twentyEighth)).toBe('2026-08-28');
    expect(C.nextPayday('2026-08-28', twentyEighth)).toBe('2026-08-28');
    expect(C.nextPayday('2026-08-29', twentyEighth)).toBe('2026-09-28');
  });
});
