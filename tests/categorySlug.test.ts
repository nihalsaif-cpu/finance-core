import { describe, it, expect } from 'vitest';
import { categorySlug } from '../src/categories';

describe('categorySlug', () => {
  it('slugifies an ordinary name', () => {
    expect(categorySlug('Sharma Kirana Store')).toBe('sharma-kirana-store');
  });

  it('strips punctuation and collapses separators', () => {
    expect(categorySlug('Coffee  &  Snacks!!')).toBe('coffee-snacks');
  });

  it('does not leave leading or trailing dashes', () => {
    expect(categorySlug('  — Rent —  ')).toBe('rent');
  });

  it('suffixes a collision rather than failing the insert', () => {
    expect(categorySlug('Coffee', ['coffee'])).toBe('coffee-2');
    expect(categorySlug('Coffee', ['coffee', 'coffee-2'])).toBe('coffee-3');
  });

  it('gives an emoji-only name a valid slug', () => {
    // Would otherwise slugify to an empty string and violate the not-blank constraint.
    expect(categorySlug('🍕🍕')).toBe('category');
  });

  it('keeps emoji-only collisions distinct', () => {
    expect(categorySlug('🍕', ['category'])).toBe('category-2');
  });

  it('caps the length so it cannot overflow the column', () => {
    expect(categorySlug('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it('handles accents by folding them', () => {
    expect(categorySlug('Café')).toBe('cafe');
  });

  it('is stable for the same input', () => {
    expect(categorySlug('Gym')).toBe(categorySlug('Gym'));
  });
});
