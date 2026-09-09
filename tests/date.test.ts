import { describe, it, expect } from 'vitest';
import * as D from '../src/date';

describe('civil date arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(D.addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(D.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(D.addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles leap years', () => {
    expect(D.addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(D.addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(D.daysInMonth(2024, 2)).toBe(29);
    expect(D.daysInMonth(2100, 2)).toBe(28);
    expect(D.daysInMonth(2000, 2)).toBe(29);
  });

  it('clamps the day when adding months', () => {
    expect(D.addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(D.addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(D.addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(D.addMonths('2026-08-15', 6)).toBe('2027-02-15');
  });

  it('counts days between dates', () => {
    expect(D.daysBetween('2026-08-01', '2026-08-31')).toBe(30);
    expect(D.inclusiveDayCount('2026-08-01', '2026-08-31')).toBe(31);
    expect(D.daysBetween('2026-08-31', '2026-08-01')).toBe(-30);
  });

  it('does not drift by a day regardless of process timezone', () => {
    // toEpochDay/fromEpochDay run in UTC; a naive local-time Date would shift here.
    expect(D.fromEpochDay(D.toEpochDay('2026-08-14'))).toBe('2026-08-14');
    expect(D.fromEpochDay(D.toEpochDay('1970-01-01'))).toBe('1970-01-01');
  });

  it('validates', () => {
    expect(D.isValidISODate('2026-02-30')).toBe(false);
    expect(D.isValidISODate('2026-13-01')).toBe(false);
    expect(D.isValidISODate('2024-02-29')).toBe(true);
    expect(D.isValidISODate('14/08/2026')).toBe(false);
  });

  it('reads today in a named timezone', () => {
    // 2026-08-14T20:00Z is already the 15th in Asia/Kolkata (UTC+5:30).
    const instant = new Date('2026-08-14T20:00:00Z');
    expect(D.todayISO('Asia/Kolkata', instant)).toBe('2026-08-15');
    expect(D.todayISO('UTC', instant)).toBe('2026-08-14');
  });
});

describe('display', () => {
  it('formats', () => {
    expect(D.formatDayMonth('2026-08-14')).toBe('14 Aug');
    expect(D.formatFull('2026-08-14')).toBe('14 Aug 2026');
    expect(D.formatMonthYear('2026-08-14')).toBe('August 2026');
    expect(D.formatWeekday('2026-08-14')).toBe('Fri');
  });

  it('formats relative days', () => {
    expect(D.formatRelativeDay('2026-08-14', '2026-08-14')).toBe('Today');
    expect(D.formatRelativeDay('2026-08-13', '2026-08-14')).toBe('Yesterday');
    expect(D.formatRelativeDay('2026-08-01', '2026-08-14')).toBe('1 Aug');
    expect(D.formatRelativeDay('2025-08-01', '2026-08-14')).toBe('1 Aug 2025');
  });
});

describe('parseLooseDate', () => {
  const today = '2026-08-26';

  it('parses the formats Indian statements actually use', () => {
    const cases: Array<[string, string]> = [
      ['2026-08-14', '2026-08-14'],
      ['14/08/2026', '2026-08-14'],
      ['14-08-2026', '2026-08-14'],
      ['14.08.2026', '2026-08-14'],
      ['14/08/26', '2026-08-14'],
      ['14 Aug 2026', '2026-08-14'],
      ['14-Aug-26', '2026-08-14'],
      ['14 August 2026', '2026-08-14'],
      ['Aug 14, 2026', '2026-08-14'],
      ['August 14 2026', '2026-08-14'],
      ['14th Sept 2026', '2026-09-14'],
    ];
    for (const [input, expected] of cases) {
      expect(D.parseLooseDate(input, { today })?.date, input).toBe(expected);
    }
  });

  it('resolves DD/MM vs MM/DD by preference and flags the ambiguity', () => {
    expect(D.parseLooseDate('05/06/2026', { today })).toEqual({ date: '2026-06-05', ambiguous: true });
    expect(D.parseLooseDate('05/06/2026', { today, preference: 'month-first' })).toEqual({
      date: '2026-05-06',
      ambiguous: true,
    });
  });

  it('forces the layout when one component cannot be a month', () => {
    expect(D.parseLooseDate('25/06/2026', { today })).toEqual({ date: '2026-06-25', ambiguous: false });
    // Unambiguously month-first even though the preference is day-first.
    expect(D.parseLooseDate('06/25/2026', { today })).toEqual({ date: '2026-06-25', ambiguous: false });
  });

  it('is not ambiguous when both components are equal', () => {
    expect(D.parseLooseDate('07/07/2026', { today })?.ambiguous).toBe(false);
  });

  it('infers a missing year as the most recent past occurrence', () => {
    expect(D.parseLooseDate('14 Aug', { today })?.date).toBe('2026-08-14');
    expect(D.parseLooseDate('14 Dec', { today })?.date).toBe('2025-12-14');
  });

  it('expands two-digit years into the nearest century', () => {
    expect(D.parseLooseDate('01/01/99', { today })?.date).toBe('1999-01-01');
    expect(D.parseLooseDate('01/01/27', { today })?.date).toBe('2027-01-01');
  });

  it('returns null rather than guessing', () => {
    expect(D.parseLooseDate('not a date', { today })).toBeNull();
    expect(D.parseLooseDate('32/13/2026', { today })).toBeNull();
    expect(D.parseLooseDate('31/02/2026', { today })).toBeNull();
    expect(D.parseLooseDate('', { today })).toBeNull();
  });
});
