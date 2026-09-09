/**
 * The default category tree.
 *
 * Seeded per user (not shared) so a user can rename, reclassify or deactivate any of
 * them without affecting anyone else, and so every category row can carry a `user_id`
 * for row-level security. Slugs are stable identifiers used by the merchant rules, so
 * renaming a category never breaks categorisation.
 */

import type { CategoryClassification, CategoryKind } from './types';

export interface CategorySeed {
  slug: string;
  name: string;
  kind: CategoryKind;
  classification: CategoryClassification;
  icon: string;
  color: string;
  children?: CategorySeed[];
}

/**
 * Classification notes: "essential" means the money is not realistically optional
 * month to month. Groceries are essential; restaurants are not. Categories that
 * genuinely go either way are 'mixed', and `ledger.isEssential` resolves those as
 * discretionary so the discretionary figure is never flatteringly low.
 */
export const DEFAULT_CATEGORIES: CategorySeed[] = [
  {
    slug: 'housing',
    name: 'Housing',
    kind: 'expense',
    classification: 'essential',
    icon: 'home',
    color: '#4C6FFF',
    children: [
      { slug: 'rent', name: 'Rent', kind: 'expense', classification: 'essential', icon: 'key', color: '#4C6FFF' },
      { slug: 'electricity', name: 'Electricity', kind: 'expense', classification: 'essential', icon: 'zap', color: '#5B7CFF' },
      { slug: 'water', name: 'Water', kind: 'expense', classification: 'essential', icon: 'droplet', color: '#6A88FF' },
      { slug: 'internet', name: 'Internet', kind: 'expense', classification: 'essential', icon: 'wifi', color: '#7994FF' },
      { slug: 'maintenance', name: 'Maintenance', kind: 'expense', classification: 'essential', icon: 'tool', color: '#88A0FF' },
    ],
  },
  {
    slug: 'food',
    name: 'Food',
    kind: 'expense',
    classification: 'mixed',
    icon: 'utensils',
    color: '#FF8A4C',
    children: [
      { slug: 'groceries', name: 'Groceries', kind: 'expense', classification: 'essential', icon: 'shopping-basket', color: '#FF8A4C' },
      { slug: 'restaurants', name: 'Restaurants', kind: 'expense', classification: 'discretionary', icon: 'utensils', color: '#FF9A64' },
      { slug: 'food_delivery', name: 'Food Delivery', kind: 'expense', classification: 'discretionary', icon: 'bike', color: '#FFAA7C' },
      { slug: 'coffee_snacks', name: 'Coffee & Snacks', kind: 'expense', classification: 'discretionary', icon: 'coffee', color: '#FFBA94' },
    ],
  },
  {
    slug: 'transportation',
    name: 'Transportation',
    kind: 'expense',
    classification: 'mixed',
    icon: 'car',
    color: '#26C6A6',
    children: [
      { slug: 'fuel', name: 'Fuel', kind: 'expense', classification: 'essential', icon: 'fuel', color: '#26C6A6' },
      { slug: 'taxi', name: 'Taxi & Ride Hailing', kind: 'expense', classification: 'mixed', icon: 'car-taxi-front', color: '#3ACFB2' },
      { slug: 'public_transport', name: 'Public Transport', kind: 'expense', classification: 'essential', icon: 'train', color: '#4ED8BE' },
      { slug: 'parking', name: 'Parking & Tolls', kind: 'expense', classification: 'mixed', icon: 'parking-circle', color: '#62E1CA' },
      { slug: 'vehicle_maintenance', name: 'Vehicle Maintenance', kind: 'expense', classification: 'essential', icon: 'wrench', color: '#76EAD6' },
    ],
  },
  {
    slug: 'shopping',
    name: 'Shopping',
    kind: 'expense',
    classification: 'discretionary',
    icon: 'shopping-bag',
    color: '#B45CFF',
    children: [
      { slug: 'clothing', name: 'Clothing', kind: 'expense', classification: 'discretionary', icon: 'shirt', color: '#B45CFF' },
      { slug: 'electronics', name: 'Electronics', kind: 'expense', classification: 'discretionary', icon: 'smartphone', color: '#BE70FF' },
      { slug: 'personal_items', name: 'Personal Items', kind: 'expense', classification: 'mixed', icon: 'sparkles', color: '#C884FF' },
      { slug: 'online_shopping', name: 'Online Shopping', kind: 'expense', classification: 'discretionary', icon: 'package', color: '#D298FF' },
    ],
  },
  {
    slug: 'lifestyle',
    name: 'Lifestyle',
    kind: 'expense',
    classification: 'discretionary',
    icon: 'party-popper',
    color: '#FF5C8A',
    children: [
      { slug: 'entertainment', name: 'Entertainment', kind: 'expense', classification: 'discretionary', icon: 'clapperboard', color: '#FF5C8A' },
      { slug: 'hobbies', name: 'Hobbies', kind: 'expense', classification: 'discretionary', icon: 'palette', color: '#FF7099' },
      { slug: 'travel', name: 'Travel', kind: 'expense', classification: 'discretionary', icon: 'plane', color: '#FF84A8' },
      { slug: 'gym', name: 'Gym & Fitness', kind: 'expense', classification: 'discretionary', icon: 'dumbbell', color: '#FF98B7' },
      { slug: 'events', name: 'Events', kind: 'expense', classification: 'discretionary', icon: 'ticket', color: '#FFACC6' },
    ],
  },
  {
    slug: 'bills',
    name: 'Bills & Subscriptions',
    kind: 'expense',
    classification: 'essential',
    icon: 'receipt',
    color: '#F2B705',
    children: [
      { slug: 'mobile', name: 'Mobile', kind: 'expense', classification: 'essential', icon: 'smartphone', color: '#F2B705' },
      { slug: 'streaming', name: 'Streaming', kind: 'expense', classification: 'discretionary', icon: 'tv', color: '#F5C227' },
      { slug: 'software', name: 'Software', kind: 'expense', classification: 'mixed', icon: 'app-window', color: '#F7CD49' },
      { slug: 'insurance', name: 'Insurance', kind: 'expense', classification: 'essential', icon: 'shield', color: '#F9D86B' },
      { slug: 'other_subscriptions', name: 'Other Subscriptions', kind: 'expense', classification: 'discretionary', icon: 'repeat', color: '#FBE38D' },
    ],
  },
  {
    slug: 'financial',
    name: 'Financial',
    kind: 'expense',
    classification: 'essential',
    icon: 'landmark',
    color: '#5B8DEF',
    children: [
      { slug: 'emi', name: 'EMI', kind: 'expense', classification: 'essential', icon: 'calendar-clock', color: '#5B8DEF' },
      { slug: 'credit_card_payment', name: 'Credit Card Payment', kind: 'transfer', classification: 'essential', icon: 'credit-card', color: '#6F9BF1' },
      { slug: 'loan', name: 'Loan', kind: 'expense', classification: 'essential', icon: 'banknote', color: '#83A9F3' },
      { slug: 'investment', name: 'Investment', kind: 'savings', classification: 'essential', icon: 'trending-up', color: '#97B7F5' },
      { slug: 'savings', name: 'Savings', kind: 'savings', classification: 'essential', icon: 'piggy-bank', color: '#ABC5F7' },
      { slug: 'bank_fees', name: 'Bank Fees & Charges', kind: 'expense', classification: 'essential', icon: 'percent', color: '#BFD3F9' },
    ],
  },
  {
    slug: 'healthcare',
    name: 'Healthcare',
    kind: 'expense',
    classification: 'essential',
    icon: 'heart-pulse',
    color: '#EF5B5B',
    children: [
      { slug: 'doctor', name: 'Doctor', kind: 'expense', classification: 'essential', icon: 'stethoscope', color: '#EF5B5B' },
      { slug: 'medicine', name: 'Medicine', kind: 'expense', classification: 'essential', icon: 'pill', color: '#F16F6F' },
      { slug: 'health_insurance', name: 'Health Insurance', kind: 'expense', classification: 'essential', icon: 'shield-plus', color: '#F38383' },
    ],
  },
  {
    slug: 'education',
    name: 'Education',
    kind: 'expense',
    classification: 'essential',
    icon: 'graduation-cap',
    color: '#00A6A6',
    children: [
      { slug: 'courses', name: 'Courses', kind: 'expense', classification: 'mixed', icon: 'book-open', color: '#00A6A6' },
      { slug: 'books', name: 'Books', kind: 'expense', classification: 'mixed', icon: 'book', color: '#22B5B5' },
      { slug: 'tuition', name: 'Tuition & Fees', kind: 'expense', classification: 'essential', icon: 'school', color: '#44C4C4' },
    ],
  },
  {
    slug: 'people',
    name: 'People & Gifts',
    kind: 'expense',
    classification: 'mixed',
    icon: 'gift',
    color: '#C77DFF',
    children: [
      { slug: 'family_support', name: 'Family Support', kind: 'expense', classification: 'essential', icon: 'users', color: '#C77DFF' },
      { slug: 'gifts', name: 'Gifts', kind: 'expense', classification: 'discretionary', icon: 'gift', color: '#D191FF' },
      { slug: 'charity', name: 'Charity', kind: 'expense', classification: 'discretionary', icon: 'hand-heart', color: '#DBA5FF' },
      { slug: 'household_help', name: 'Household Help', kind: 'expense', classification: 'essential', icon: 'user-check', color: '#E5B9FF' },
    ],
  },
  {
    slug: 'income',
    name: 'Income',
    kind: 'income',
    classification: 'essential',
    icon: 'wallet',
    color: '#22C55E',
    children: [
      { slug: 'salary', name: 'Salary', kind: 'income', classification: 'essential', icon: 'briefcase', color: '#22C55E' },
      { slug: 'bonus', name: 'Bonus', kind: 'income', classification: 'essential', icon: 'award', color: '#3ACF70' },
      { slug: 'freelance', name: 'Freelance', kind: 'income', classification: 'essential', icon: 'laptop', color: '#52D982' },
      { slug: 'interest_income', name: 'Interest & Dividends', kind: 'income', classification: 'essential', icon: 'coins', color: '#6AE394' },
      { slug: 'other_income', name: 'Other Income', kind: 'income', classification: 'essential', icon: 'plus-circle', color: '#82EDA6' },
    ],
  },
  {
    slug: 'transfers',
    name: 'Transfers',
    kind: 'transfer',
    classification: 'essential',
    icon: 'arrow-left-right',
    color: '#8A94A6',
    children: [
      { slug: 'self_transfer', name: 'Between My Accounts', kind: 'transfer', classification: 'essential', icon: 'repeat', color: '#8A94A6' },
      { slug: 'cash_withdrawal', name: 'Cash Withdrawal', kind: 'transfer', classification: 'essential', icon: 'banknote', color: '#98A2B3' },
    ],
  },
  {
    slug: 'other',
    name: 'Other',
    kind: 'expense',
    classification: 'discretionary',
    icon: 'circle-help',
    color: '#8A94A6',
  },
];

/** Flattened seed list with parent slugs resolved, in insertion order. */
export interface FlatCategorySeed extends Omit<CategorySeed, 'children'> {
  parentSlug: string | null;
  sortOrder: number;
}

export function flattenCategories(seeds: CategorySeed[] = DEFAULT_CATEGORIES): FlatCategorySeed[] {
  const out: FlatCategorySeed[] = [];
  seeds.forEach((seed, index) => {
    const { children, ...rest } = seed;
    out.push({ ...rest, parentSlug: null, sortOrder: index * 100 });
    (children ?? []).forEach((child, childIndex) => {
      const { children: _ignored, ...childRest } = child;
      out.push({ ...childRest, parentSlug: seed.slug, sortOrder: index * 100 + childIndex + 1 });
    });
  });
  return out;
}

/** Slugs the app references directly, so a typo is a compile error rather than a bug. */
export const CATEGORY_SLUGS = {
  uncategorised: 'other',
  salary: 'salary',
  foodDelivery: 'food_delivery',
  groceries: 'groceries',
  restaurants: 'restaurants',
  shopping: 'shopping',
  onlineShopping: 'online_shopping',
  streaming: 'streaming',
  software: 'software',
  creditCardPayment: 'credit_card_payment',
  selfTransfer: 'self_transfer',
  cashWithdrawal: 'cash_withdrawal',
  investment: 'investment',
  rent: 'rent',
  emi: 'emi',
} as const;

/** Subscription-like slugs, used for the "subscriptions consume X% of salary" insight. */
export const SUBSCRIPTION_SLUGS = ['streaming', 'software', 'other_subscriptions', 'gym'] as const;

/**
 * A URL-safe, unique slug for a user-created category.
 *
 * Slugs are `unique (user_id, slug)` in the database, so a collision is a failed
 * insert rather than a silently merged category. Suffixing here means "Coffee" can be
 * created twice — once under Food, once as a standalone tag — without the second
 * attempt erroring in the user's face at the moment they are trying to save a payment.
 *
 * Pure so it can be tested: the interesting cases are all edge cases (an emoji-only
 * name, a name that collides, a name that slugifies to nothing).
 */
export function categorySlug(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) ||
    // A name of only emoji or punctuation still needs a stable, valid slug.
    'category';

  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let i = 2; i < 200; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // Practically unreachable; better than returning a slug known to collide.
  return `${base}-${Date.now()}`;
}
