import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CATEGORIES, flattenCategories, CATEGORY_SLUGS, SUBSCRIPTION_SLUGS } from '../src/categories';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedSql = readFileSync(path.join(root, 'schema/20260826000300_seed.sql'), 'utf8');

describe('category seed stays in sync with the SQL migration', () => {
  it('seeds every category defined in TypeScript', () => {
    const flat = flattenCategories();
    for (const category of flat) {
      expect(seedSql, category.slug).toContain(`'${category.slug}'`);
    }
    // The SQL row count must match exactly — no orphans left behind by an edit.
    const rowCount = (seedSql.match(/::category_kind/g) ?? []).length;
    expect(rowCount).toBe(flat.length);
  });

  it('emits parents before their children so the parent id is resolvable', () => {
    const flat = flattenCategories();
    const seen = new Set<string>();
    for (const category of flat) {
      if (category.parentSlug) expect(seen.has(category.parentSlug), category.slug).toBe(true);
      seen.add(category.slug);
    }
  });
});

describe('category definitions', () => {
  it('has unique slugs', () => {
    const slugs = flattenCategories().map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('covers every category group the brief specifies', () => {
    const roots = DEFAULT_CATEGORIES.map((c) => c.slug);
    expect(roots).toEqual(
      expect.arrayContaining([
        'housing', 'food', 'transportation', 'shopping', 'lifestyle',
        'bills', 'financial', 'healthcare', 'other',
      ]),
    );
  });

  it('resolves every slug the app references by name', () => {
    const slugs = new Set(flattenCategories().map((c) => c.slug));
    for (const slug of Object.values(CATEGORY_SLUGS)) {
      expect(slugs.has(slug), slug).toBe(true);
    }
    for (const slug of SUBSCRIPTION_SLUGS) {
      expect(slugs.has(slug), slug).toBe(true);
    }
  });

  it('keeps credit card payments and transfers out of the expense kinds', () => {
    const flat = flattenCategories();
    expect(flat.find((c) => c.slug === 'credit_card_payment')?.kind).toBe('transfer');
    expect(flat.find((c) => c.slug === 'self_transfer')?.kind).toBe('transfer');
    expect(flat.find((c) => c.slug === 'investment')?.kind).toBe('savings');
  });
});

describe('schema invariants', () => {
  const initSql = readFileSync(path.join(root, 'schema/20260826000100_init.sql'), 'utf8');
  const rlsSql = readFileSync(path.join(root, 'schema/20260826000200_rls.sql'), 'utf8');

  it('stores every money column as bigint, never a float type', () => {
    // Any real/double/money column would be a precision bug waiting to happen.
    expect(initSql).not.toMatch(/\b(amount|balance|limit|target|threshold)\w*\s+(real|double|float|money|numeric)/i);
    expect(initSql).toMatch(/amount\s+bigint/);
  });

  it('enables row level security on every user-owned table', () => {
    const tables = [
      'profiles', 'categories', 'accounts', 'transactions', 'income_records', 'budgets',
      'recurring_expenses', 'financial_goals', 'merchant_mappings', 'imports',
      'import_transactions', 'salary_cycles', 'insights', 'notification_preferences',
    ];
    for (const table of tables) {
      expect(rlsSql, table).toMatch(new RegExp(`alter table public\\.${table}\\s+enable row level security`));
    }
  });

  it('keeps the statements bucket private', () => {
    expect(rlsSql).toMatch(/'statements'[\s\S]{0,60}false/);
    expect(rlsSql).toContain('storage.foldername(name))[1] = (select auth.uid())::text');
  });

  it('creates the indexes the hot queries depend on', () => {
    for (const index of [
      'transactions_user_date_idx',
      'transactions_user_category_idx',
      'transactions_dedupe_idx',
    ]) {
      expect(initSql, index).toContain(index);
    }
  });
});
