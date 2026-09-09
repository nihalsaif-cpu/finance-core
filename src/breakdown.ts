/**
 * What is inside a category.
 *
 * A rollup tells you Home cost ₹9,000; it does not tell you that ₹6,000 of it was rent
 * and the rest was three utility bills. That second question is the one people
 * actually have when they look at a total and it surprises them — and it is currently
 * unanswerable without scrolling the whole transaction list and doing the sums.
 *
 * Pure: takes the transactions and a category index, returns figures. It knows nothing
 * about how the rows were fetched or which period they came from.
 */

import { spendOf, DEFAULT_LEDGER_OPTIONS, type LedgerOptions } from './ledger';
import { sum, ZERO, type Minor } from './money';
import type { ISODate } from './date';
import type { CategoryIndex, Rollup } from './analytics';
import type { AnalyzableTransaction, UUID } from './types';

export interface DayGroup {
  date: ISODate;
  total: Minor;
  transactions: AnalyzableTransaction[];
}

export interface CategoryBreakdown {
  categoryId: UUID;
  label: string;
  color: string;
  total: Minor;
  transactionCount: number;
  /** Subcategories with spending, largest first. Empty for a leaf category. */
  children: Rollup[];
  /** Every contributing transaction, newest day first. */
  days: DayGroup[];
  /** The single biggest transaction — usually the reason the total surprised anyone. */
  largest: AnalyzableTransaction | null;
  /** Merchants inside this category, largest first. */
  merchants: Rollup[];
}

/**
 * Break a category open.
 *
 * Includes everything filed UNDER the category as well as directly on it — a total
 * shown against "Home" is a rolled-up figure, so a breakdown that only counted rows
 * tagged Home exactly would come to less than the number the user tapped, which reads
 * as a bug rather than a distinction.
 */
export function buildCategoryBreakdown(
  categoryId: UUID,
  transactions: readonly AnalyzableTransaction[],
  categories: CategoryIndex,
  options: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
): CategoryBreakdown {
  const rows = transactions.filter((t) => {
    if (spendOf(t, options) <= 0) return false;
    return t.categoryId === categoryId || categories.isUnder(t.categoryId, categoryId);
  });

  // --- Subcategories ---------------------------------------------------------
  const childTotals = new Map<string, { label: string; amount: number; count: number; color?: string }>();
  for (const t of rows) {
    const spend = spendOf(t, options);
    // Rows tagged directly on the parent group under its own name, not under a child
    // they were never in.
    const key = t.categoryId === categoryId ? categoryId : childUnder(t.categoryId, categoryId, categories);
    const id = key ?? categoryId;
    const existing = childTotals.get(id);
    if (existing) {
      existing.amount += spend;
      existing.count += 1;
      continue;
    }
    const entry: { label: string; amount: number; count: number; color?: string } = {
      label: categories.name(id),
      amount: spend,
      count: 1,
    };
    const color = categories.color(id);
    if (color) entry.color = color;
    childTotals.set(id, entry);
  }

  const total = sum(rows.map((t) => spendOf(t, options)));

  // --- By day ----------------------------------------------------------------
  const byDay = new Map<ISODate, AnalyzableTransaction[]>();
  for (const t of rows) {
    const list = byDay.get(t.date) ?? [];
    list.push(t);
    byDay.set(t.date, list);
  }

  const days: DayGroup[] = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      total: sum(list.map((t) => spendOf(t, options))),
      transactions: [...list].sort((a, b) => spendOf(b, options) - spendOf(a, options)),
    }));

  // --- Merchants -------------------------------------------------------------
  const byMerchant = new Map<string, { label: string; amount: number; count: number }>();
  for (const t of rows) {
    const key = t.merchantKey ?? 'other';
    const label = t.merchantName ?? t.description ?? 'Unknown';
    const existing = byMerchant.get(key);
    if (existing) {
      existing.amount += spendOf(t, options);
      existing.count += 1;
      continue;
    }
    byMerchant.set(key, { label, amount: spendOf(t, options), count: 1 });
  }

  const largest = rows.reduce<AnalyzableTransaction | null>(
    (best, t) => (best === null || spendOf(t, options) > spendOf(best, options) ? t : best),
    null,
  );

  return {
    categoryId,
    label: categories.name(categoryId),
    color: categories.color(categoryId),
    total,
    transactionCount: rows.length,
    children: finalise(childTotals, total),
    days,
    largest,
    merchants: finalise(byMerchant, total).slice(0, 8),
  };
}

/** The direct child of `ancestor` that `id` sits under, or null. */
function childUnder(id: UUID | null, ancestor: UUID, categories: CategoryIndex): UUID | null {
  if (!id) return null;
  const chain = categories.ancestorsOf(id);
  // ancestorsOf runs from the row's own category up to the root; the entry just below
  // the ancestor is the branch it belongs to.
  const index = chain.indexOf(ancestor);
  if (index <= 0) return id === ancestor ? null : id;
  return chain[index - 1] ?? id;
}

function finalise(
  map: Map<string, { label: string; amount: number; count: number; color?: string }>,
  total: Minor,
): Rollup[] {
  return [...map.entries()]
    .map(([key, v]) => {
      const entry: Rollup = {
        key,
        label: v.label,
        amount: v.amount as Minor,
        count: v.count,
        share: (total as number) === 0 ? null : (v.amount / (total as number)) * 100,
      };
      if (v.color) entry.color = v.color;
      return entry;
    })
    .sort((a, b) => b.amount - a.amount);
}

export { ZERO };
