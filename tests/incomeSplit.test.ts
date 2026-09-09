import { describe, it, expect } from 'vitest';
import { incomeByCategory } from '../src/analytics';
import { categoryIndex, cat } from './helpers/categories';
import { txns, rs } from './helpers/factory';

/**
 * Guards the figure the user could not previously check: "Income: ₹70,116" against a
 * salary of ₹68,500. The split is what makes the difference findable.
 */
describe('incomeByCategory', () => {
  const rows = txns([
    { date: '2026-08-01', amount: '68500', kind: 'income', categoryId: cat('salary'), merchantKey: 'acme' },
    { date: '2026-08-20', amount: '1616.23', kind: 'income', categoryId: cat('interest_income'), merchantKey: 'bank' },
    { date: '2026-08-11', amount: '4200', kind: 'expense', merchantKey: 'swiggy' },
  ]);

  it('separates salary from interest rather than lumping them together', () => {
    const split = incomeByCategory(rows, categoryIndex);
    expect(split).toHaveLength(2);
    expect(split[0]!.label).toMatch(/salary/i);
    expect(split[0]!.amount).toBe(rs(68500));
    expect(split[1]!.amount).toBe(rs(1616.23));
  });

  it('ignores spending entirely', () => {
    const split = incomeByCategory(rows, categoryIndex);
    expect(split.some((r) => r.label.toLowerCase().includes('food'))).toBe(false);
  });

  it('sums to the same total the dashboard shows', () => {
    const total = incomeByCategory(rows, categoryIndex).reduce((a, r) => a + (r.amount as number), 0);
    expect(total).toBe(rs(70116.23));
  });

  it('does not roll interest up under a shared income parent', () => {
    // Rolling to parent would merge salary and interest, defeating the whole point.
    const labels = incomeByCategory(rows, categoryIndex).map((r) => r.label.toLowerCase());
    expect(new Set(labels).size).toBe(2);
  });

  it('names an uncategorised credit "Unclassified" rather than Other Income', () => {
    const split = incomeByCategory(
      txns([{ date: '2026-08-05', amount: '900', kind: 'income', categoryId: null, merchantKey: 'x' }]),
      categoryIndex,
    );
    expect(split[0]!.label).toBe('Unclassified');
  });

  it('reports each line as a share of income', () => {
    const split = incomeByCategory(rows, categoryIndex);
    expect(split[0]!.share).toBeCloseTo((68500 / 70116.23) * 100, 3);
  });

  it('counts how many credits make up each line', () => {
    const many = txns([
      { date: '2026-08-01', amount: '30000', kind: 'income', categoryId: cat('salary'), merchantKey: 'a' },
      { date: '2026-08-15', amount: '38500', kind: 'income', categoryId: cat('salary'), merchantKey: 'a' },
    ]);
    expect(incomeByCategory(many, categoryIndex)[0]!.count).toBe(2);
  });

  it('returns nothing when there is no income', () => {
    expect(incomeByCategory(txns([{ date: '2026-08-01', amount: '100', merchantKey: 'x' }]), categoryIndex)).toEqual([]);
  });

  it('excludes transfers, which are not income', () => {
    const withTransfer = txns([
      { date: '2026-08-01', amount: '68500', kind: 'income', categoryId: cat('salary'), merchantKey: 'a' },
      { date: '2026-08-09', amount: '25000', kind: 'transfer', merchantKey: 'self' },
    ]);
    const total = incomeByCategory(withTransfer, categoryIndex).reduce((a, r) => a + (r.amount as number), 0);
    expect(total).toBe(rs(68500));
  });
});
