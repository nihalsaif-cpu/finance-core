import { describe, it, expect } from 'vitest';
import { buildCategoryBreakdown } from '../src/breakdown';
import { categoryIndex, cat } from './helpers/categories';
import { txns, rs } from './helpers/factory';

/**
 * The question this answers: "Home cost ₹9,000 — on what?" Previously unanswerable
 * without scrolling the whole transaction list and adding up by hand.
 */
const ROWS = txns([
  { date: '2026-08-02', amount: '6000', categoryId: cat('rent'), merchantKey: 'landlord', merchantName: 'Landlord' },
  { date: '2026-08-11', amount: '1800', categoryId: cat('electricity'), merchantKey: 'bescom', merchantName: 'BESCOM' },
  { date: '2026-08-11', amount: '700', categoryId: cat('internet'), merchantKey: 'act', merchantName: 'ACT' },
  { date: '2026-08-19', amount: '500', categoryId: cat('water'), merchantKey: 'bwssb', merchantName: 'BWSSB' },
  // Somewhere else entirely — must not appear.
  { date: '2026-08-05', amount: '900', categoryId: cat('groceries'), merchantKey: 'more', merchantName: 'More' },
]);

const housing = () => buildCategoryBreakdown(cat('housing'), ROWS, categoryIndex);

describe('buildCategoryBreakdown', () => {
  it('totals everything filed under the category', () => {
    expect(housing().total).toBe(rs(9000));
  });

  it('excludes categories that are not under it', () => {
    expect(housing().transactionCount).toBe(4);
  });

  it('splits into subcategories, largest first', () => {
    const children = housing().children;
    expect(children[0]!.label).toMatch(/rent/i);
    expect(children[0]!.amount).toBe(rs(6000));
    expect(children.map((c) => c.label.toLowerCase())).toContain('electricity');
  });

  it('gives each subcategory its share of the parent', () => {
    const rent = housing().children.find((c) => c.label.toLowerCase() === 'rent')!;
    expect(rent.share).toBeCloseTo((6000 / 9000) * 100, 4);
  });

  it('groups transactions by day, newest first', () => {
    const days = housing().days;
    expect(days[0]!.date).toBe('2026-08-19');
    expect(days.at(-1)!.date).toBe('2026-08-02');
  });

  it('totals each day', () => {
    // Two bills landed on the 11th.
    const day = housing().days.find((d) => d.date === '2026-08-11')!;
    expect(day.total).toBe(rs(2500));
    expect(day.transactions).toHaveLength(2);
  });

  it('orders a day’s transactions by size', () => {
    const day = housing().days.find((d) => d.date === '2026-08-11')!;
    expect(day.transactions[0]!.amount).toBe(rs(1800));
  });

  it('names the largest single transaction', () => {
    expect(housing().largest?.amount).toBe(rs(6000));
  });

  it('rolls up merchants inside the category', () => {
    const merchants = housing().merchants;
    expect(merchants[0]!.label).toBe('Landlord');
    expect(merchants).toHaveLength(4);
  });

  it('handles a leaf category with no children of its own', () => {
    const rent = buildCategoryBreakdown(cat('rent'), ROWS, categoryIndex);
    expect(rent.total).toBe(rs(6000));
    expect(rent.days).toHaveLength(1);
  });

  it('returns empty figures for a category with no spending', () => {
    const empty = buildCategoryBreakdown(cat('travel'), ROWS, categoryIndex);
    expect(empty.total).toBe(0);
    expect(empty.days).toEqual([]);
    expect(empty.largest).toBeNull();
  });

  it('ignores income and transfers, which are not spending', () => {
    const mixed = txns([
      { date: '2026-08-02', amount: '6000', categoryId: cat('rent'), merchantKey: 'landlord' },
      { date: '2026-08-03', amount: '5000', kind: 'transfer', categoryId: cat('rent'), merchantKey: 'self' },
    ]);
    expect(buildCategoryBreakdown(cat('housing'), mixed, categoryIndex).total).toBe(rs(6000));
  });

  it('sums the subcategories to the parent total', () => {
    // If these disagree, the screen shows a total its own rows do not add up to.
    const b = housing();
    const childSum = b.children.reduce((a, c) => a + (c.amount as number), 0);
    expect(childSum).toBe(b.total);
  });
});
