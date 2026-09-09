import { describe, it, expect } from 'vitest';
import {
  buildYearSummary, cyclePeriod, cyclesOfYear, selectableYears, yearFinding, yearPeriod,
} from '../src/period';
import { cycleContaining } from '../src/cycle';
import { format } from '../src/money';
import { categoryIndex, cat } from './helpers/categories';
import { txns, rs } from './helpers/factory';

const MONTHLY = { startDay: 1, frequency: 'monthly' as const };
const money = (v: never) => format(v, { currency: 'INR' });

describe('cyclesOfYear', () => {
  it('returns twelve whole cycles for a calendar-aligned year', () => {
    const cycles = cyclesOfYear(2026, MONTHLY);
    expect(cycles).toHaveLength(12);
    expect(cycles[0]!.start).toBe('2026-01-01');
    expect(cycles[11]!.end).toBe('2026-12-31');
  });

  it('keeps cycles whole when payday is mid-month', () => {
    const cycles = cyclesOfYear(2026, { startDay: 25, frequency: 'monthly' });
    // Anchored on the cycle containing 1 Jan, which starts in December.
    expect(cycles[0]!.start).toBe('2025-12-25');
    expect(cycles).toHaveLength(12);
    // No cycle is split across the boundary — each ends the day before the next starts.
    for (let i = 1; i < cycles.length; i++) {
      expect(cycles[i]!.start > cycles[i - 1]!.end).toBe(true);
    }
  });

  it('does not overlap with the following year', () => {
    const a = cyclesOfYear(2026, MONTHLY);
    const b = cyclesOfYear(2027, MONTHLY);
    expect(a[a.length - 1]!.end < b[0]!.start).toBe(true);
  });
});

describe('period identity', () => {
  it('gives a cycle a stable key', () => {
    const p = cyclePeriod(cycleContaining('2026-08-14', MONTHLY));
    expect(p.kind).toBe('cycle');
    expect(p.key).toBe('cycle:2026-08-01');
    expect(p.start).toBe('2026-08-01');
    expect(p.end).toBe('2026-08-31');
  });

  it('spans a whole year', () => {
    const p = yearPeriod(2026, MONTHLY);
    expect(p.key).toBe('year:2026');
    expect(p.start).toBe('2026-01-01');
    expect(p.end).toBe('2026-12-31');
    expect(p.label).toBe('2026');
  });
});

const YEAR_TXNS = txns([
  { date: '2026-01-10', amount: '10000', merchantKey: 'rent', categoryId: cat('rent') },
  { date: '2026-02-10', amount: '30000', merchantKey: 'rent', categoryId: cat('rent') },
  { date: '2026-03-10', amount: '20000', merchantKey: 'swiggy', categoryId: cat('food-delivery') },
  { date: '2026-01-01', amount: '50000', kind: 'income', merchantKey: 'salary' },
  { date: '2026-02-01', amount: '50000', kind: 'income', merchantKey: 'salary' },
]);

describe('buildYearSummary', () => {
  const cycles = cyclesOfYear(2026, MONTHLY);
  const summary = buildYearSummary(2026, cycles, YEAR_TXNS, categoryIndex, '2026-08-28');

  it('breaks the year into one point per cycle', () => {
    expect(summary.months).toHaveLength(12);
    expect(summary.months[0]!.cycle.start).toBe('2026-01-01');
  });

  it('totals spending across the whole year', () => {
    expect(summary.totalSpend).toBe(rs(60000));
    expect(summary.totalIncome).toBe(rs(100000));
    expect(summary.totalSaved).toBe(rs(40000));
  });

  it('computes a savings rate from the year, not a month', () => {
    expect(summary.savingsRate).toBeCloseTo(40, 5);
  });

  it('names the busiest and quietest completed months', () => {
    expect(summary.busiest!.cycle.start).toBe('2026-02-01');
    expect(summary.quietest!.cycle.start).toBe('2026-01-01');
  });

  it('excludes months with no activity from busiest and quietest', () => {
    // April onward is empty; the quietest is January's ₹10,000, not an empty April.
    expect(summary.quietest!.spend).toBe(rs(10000));
  });

  it('averages only completed cycles with data', () => {
    // (10,000 + 30,000 + 20,000) / 3
    expect(summary.averageSpend).toBe(rs(20000));
  });

  it('counts how many months actually have data', () => {
    expect(summary.monthsWithData).toBe(3);
  });

  it('rolls categories up across the whole year', () => {
    // Rolled to the parent: Rent sits under Housing, which is the level a yearly
    // view should show — twenty subcategories in an annual breakdown is a table, not
    // an insight.
    const housing = summary.categories.find((c) => c.label.toLowerCase().includes('housing'));
    expect(housing?.amount).toBe(rs(40000));
  });

  it('marks the running cycle partial and keeps it out of the average', () => {
    const august = summary.months.find((m) => m.cycle.start === '2026-08-01')!;
    expect(august.isPartial).toBe(true);
  });

  it('reports a negative net for a month that cost more than it earned', () => {
    const march = summary.months.find((m) => m.cycle.start === '2026-03-01')!;
    expect(march.net).toBe(rs(-20000));
  });
});

describe('yearFinding', () => {
  const cycles = cyclesOfYear(2026, MONTHLY);

  it('says when there is nothing recorded', () => {
    const empty = buildYearSummary(2026, cycles, [], categoryIndex, '2026-08-28');
    expect(yearFinding(empty, money as never)).toMatch(/nothing recorded/i);
  });

  it('states the month count when there is no income to compare against', () => {
    const one = buildYearSummary(2026, cycles, txns([
      { date: '2026-01-10', amount: '500', merchantKey: 'a' },
    ]), categoryIndex, '2026-08-28');
    expect(yearFinding(one, money as never)).toBe('₹500 spent across 1 month.');
  });

  it('qualifies a savings rate drawn from a single month', () => {
    const thin = buildYearSummary(2026, cycles, txns([
      { date: '2026-01-10', amount: '10000', merchantKey: 'a' },
      { date: '2026-01-01', amount: '50000', kind: 'income', merchantKey: 'salary' },
    ]), categoryIndex, '2026-08-28');
    const text = yearFinding(thin, money as never);
    expect(text).toMatch(/kept 80%/);
    expect(text).toMatch(/one month of data/i);
  });

  it('leads with the share kept', () => {
    const s = buildYearSummary(2026, cycles, YEAR_TXNS, categoryIndex, '2026-08-28');
    expect(yearFinding(s, money as never)).toMatch(/kept 40%/);
  });

  it('says so when the year cost more than it earned', () => {
    const over = buildYearSummary(2026, cycles, txns([
      { date: '2026-01-10', amount: '80000', merchantKey: 'a' },
      { date: '2026-01-01', amount: '50000', kind: 'income', merchantKey: 'salary' },
    ]), categoryIndex, '2026-08-28');
    expect(yearFinding(over, money as never)).toMatch(/more than came in/i);
    // The thin-data caveat is kept, but after the finding rather than instead of it.
    expect(yearFinding(over, money as never)).toMatch(/one month of data/i);
  });
});

describe('selectableYears', () => {
  it('runs back to the earliest recorded year, newest first', () => {
    expect(selectableYears('2024-03-02', '2026-08-28')).toEqual([2026, 2025, 2024]);
  });

  it('offers this year alone when there is no history', () => {
    expect(selectableYears(null, '2026-08-28')).toEqual([2026]);
  });

  it('caps how far back it offers', () => {
    expect(selectableYears('2000-01-01', '2026-08-28', 3)).toEqual([2026, 2025, 2024]);
  });
});
