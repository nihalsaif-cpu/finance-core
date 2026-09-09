import { CategoryIndex } from '../../src/analytics';
import { flattenCategories } from '../../src/categories';
import type { Category } from '../../src/types';

/** Category rows as they would exist after seeding, with `cat-<slug>` ids. */
export const CATEGORY_ROWS: Category[] = flattenCategories().map((seed) => ({
  id: `cat-${seed.slug}`,
  userId: 'user-1',
  parentId: seed.parentSlug ? `cat-${seed.parentSlug}` : null,
  name: seed.name,
  slug: seed.slug,
  kind: seed.kind,
  classification: seed.classification,
  icon: seed.icon,
  color: seed.color,
  isActive: true,
  isSystem: true,
  sortOrder: seed.sortOrder,
}));

export const categoryIndex = new CategoryIndex(CATEGORY_ROWS);

export const cat = (slug: string) => `cat-${slug}`;
