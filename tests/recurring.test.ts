import { describe, it, expect } from 'vitest';
import { detectRecurring, monthlyEquivalent, nextOccurrence } from '../src/recurring';
import { fromMajor } from '../src/money';
import { txns, rs } from './helpers/factory';
import { cat } from './helpers/categories';

const today = '2026-08-27';

/** Monthly payments to one merchant, same day each month. */
const monthly = (merchant: string, amount: string, day: string, months: string[]) =>
  txns(months.map((m) => ({
    date: `2026-${m}-${day}`,
    amount,
    merchantKey: merchant,
    merchantName: merchant,
    categoryId: cat('rent'),
  })));

describe('detectRecurring', () => {
  it('finds a monthly rent payment', () => {
    const found = detectRecurring(monthly('rent', '25000', '02', ['05', '06', '07', '08']), { today });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      merchantKey: 'rent',
      amount: rs(25000),
      interval: 'monthly',
      occurrences: 4,
      fixedAmount: true,
    });
    expect(found[0]!.nextDueDate).toBe('2026-09-02');
  });

  it('needs at least three occurrences', () => {
    expect(detectRecurring(monthly('rent', '25000', '02', ['07', '08']), { today })).toHaveLength(0);
  });

  it('tolerates a payment landing a few days late', () => {
    const found = detectRecurring(
      txns([
        { date: '2026-05-02', amount: '649', merchantKey: 'netflix', merchantName: 'Netflix' },
        { date: '2026-06-04', amount: '649', merchantKey: 'netflix', merchantName: 'Netflix' },
        { date: '2026-07-02', amount: '649', merchantKey: 'netflix', merchantName: 'Netflix' },
        { date: '2026-08-03', amount: '649', merchantKey: 'netflix', merchantName: 'Netflix' },
      ]),
      { today },
    );
    expect(found[0]?.interval).toBe('monthly');
  });

  it('does not call irregular spending recurring', () => {
    const found = detectRecurring(
      txns([
        { date: '2026-08-02', amount: '400', merchantKey: 'swiggy', merchantName: 'Swiggy' },
        { date: '2026-08-05', amount: '900', merchantKey: 'swiggy', merchantName: 'Swiggy' },
        { date: '2026-08-19', amount: '350', merchantKey: 'swiggy', merchantName: 'Swiggy' },
        { date: '2026-08-21', amount: '1200', merchantKey: 'swiggy', merchantName: 'Swiggy' },
      ]),
      { today },
    );
    expect(found).toHaveLength(0);
  });

  it('rejects a regular interval with wildly varying amounts', () => {
    const found = detectRecurring(
      txns([
        { date: '2026-05-02', amount: '500', merchantKey: 'shop', merchantName: 'Shop' },
        { date: '2026-06-02', amount: '4000', merchantKey: 'shop', merchantName: 'Shop' },
        { date: '2026-07-02', amount: '900', merchantKey: 'shop', merchantName: 'Shop' },
        { date: '2026-08-02', amount: '7000', merchantKey: 'shop', merchantName: 'Shop' },
      ]),
      { today },
    );
    expect(found).toHaveLength(0);
  });

  it('detects weekly, quarterly and yearly intervals', () => {
    const weekly = detectRecurring(
      txns(['08-06', '08-13', '08-20', '08-27'].map((d) => ({
        date: `2026-${d}`, amount: '300', merchantKey: 'maid', merchantName: 'Maid',
      }))),
      { today },
    );
    expect(weekly[0]?.interval).toBe('weekly');

    const quarterly = detectRecurring(
      txns(['2025-11-10', '2026-02-10', '2026-05-10', '2026-08-10'].map((date) => ({
        date, amount: '2400', merchantKey: 'insurance', merchantName: 'Insurance',
      }))),
      { today },
    );
    expect(quarterly[0]?.interval).toBe('quarterly');
  });

  it('ignores income, transfers and card payments', () => {
    const found = detectRecurring(
      txns(['05', '06', '07', '08'].flatMap((m) => [
        { date: `2026-${m}-01`, amount: '75000', kind: 'income' as const, merchantKey: 'salary', merchantName: 'Salary' },
        { date: `2026-${m}-09`, amount: '25000', kind: 'cc_payment' as const, merchantKey: 'card', merchantName: 'Card' },
      ])),
      { today },
    );
    expect(found).toHaveLength(0);
  });

  it('collapses several payments on the same day into one occurrence', () => {
    const found = detectRecurring(
      txns(['05', '06', '07'].flatMap((m) => [
        { date: `2026-${m}-02`, amount: '200', merchantKey: 'cafe', merchantName: 'Cafe' },
        { date: `2026-${m}-02`, amount: '200', merchantKey: 'cafe', merchantName: 'Cafe' },
      ])),
      { today },
    );
    expect(found[0]?.occurrences).toBe(3);
  });

  it('drops a commitment that stopped long ago', () => {
    const found = detectRecurring(
      txns(['2023-01-02', '2023-02-02', '2023-03-02'].map((date) => ({
        date, amount: '500', merchantKey: 'oldgym', merchantName: 'Old Gym',
      }))),
      { today },
    );
    expect(found).toHaveLength(0);
  });

  it('scores confidence higher for a longer, steadier history', () => {
    const short = detectRecurring(monthly('rent', '25000', '02', ['06', '07', '08']), { today });
    const long = detectRecurring(monthly('rent', '25000', '02', ['03', '04', '05', '06', '07', '08']), { today });
    expect(long[0]!.confidence).toBeGreaterThan(short[0]!.confidence);
  });
});

describe('nextOccurrence', () => {
  it('steps forward past today', () => {
    expect(nextOccurrence('2026-08-02', 'monthly', '2026-08-27')).toBe('2026-09-02');
    // Due exactly today reports today, not next week.
    expect(nextOccurrence('2026-08-20', 'weekly', '2026-08-27')).toBe('2026-08-27');
    expect(nextOccurrence('2026-08-27', 'weekly', '2026-08-27')).toBe('2026-09-03');
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-01')).toBe('2026-02-28');
  });
});

describe('monthlyEquivalent', () => {
  it('normalises intervals so commitments can be summed', () => {
    expect(monthlyEquivalent(fromMajor('1200'), 'yearly')).toBe(rs(100));
    expect(monthlyEquivalent(fromMajor('900'), 'quarterly')).toBe(rs(300));
    expect(monthlyEquivalent(fromMajor('300'), 'weekly')).toBe(rs(1300));
    expect(monthlyEquivalent(fromMajor('649'), 'monthly')).toBe(rs(649));
  });
});
