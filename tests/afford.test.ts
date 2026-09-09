import { describe, it, expect } from 'vitest';
import { evaluateAffordability } from '../src/afford';
import { cycleContaining, cycleProgress, type CycleConfig } from '../src/cycle';
import { computeVelocity } from '../src/velocity';
import { format, fromMajor, ZERO, type Minor } from '../src/money';

const monthly: CycleConfig = { startDay: 1, frequency: 'monthly' };
const cycle = cycleContaining('2026-09-15', monthly); // 30 days
const fmt = (v: Minor) => format(v, { currency: 'INR', decimals: false });

function scenario(options: {
  day: number;
  spent: string;
  income?: string;
  savingsTarget?: string;
  upcoming?: string;
  purchase: string;
}) {
  const progress = cycleProgress(cycle, `2026-09-${String(options.day).padStart(2, '0')}`);
  const income = fromMajor(options.income ?? '75000');
  const savingsTarget = fromMajor(options.savingsTarget ?? '0');
  const spent = fromMajor(options.spent);
  const upcoming = fromMajor(options.upcoming ?? '0');

  const velocity = computeVelocity({
    progress,
    spentToDate: spent,
    referenceAmount: (income - savingsTarget) as Minor,
    upcomingCommitments: upcoming,
  });

  return evaluateAffordability({
    amount: fromMajor(options.purchase),
    progress,
    velocity,
    income,
    spentToDate: spent,
    savingsTarget,
    upcomingCommitments: upcoming,
    formatMoney: fmt,
  });
}

describe('evaluateAffordability — the brief’s ₹10,000 headphones', () => {
  it('is comfortable early in a cycle with little spent', () => {
    const result = scenario({ day: 5, spent: '5000', purchase: '10000' });
    expect(result.verdict).toBe('comfortable');
    expect(result.headline).toMatch(/fits comfortably/i);
  });

  it('is possible but flags the savings cost', () => {
    // Affordable within income, but it eats into the ₹20,000 the user wanted to keep.
    const result = scenario({ day: 20, spent: '30000', savingsTarget: '20000', purchase: '15000' });
    expect(result.verdict).toBe('possible');
    expect(result.savingsShortfall).toBeGreaterThan(0);
    expect(result.reasons.join(' ')).toMatch(/savings target/i);
  });

  it('recommends against a purchase that projects past the user’s income', () => {
    // Already spending ahead of pace: 50,000 by day 20 of 30 on a 75,000 income.
    const result = scenario({ day: 20, spent: '50000', savingsTarget: '20000', purchase: '10000' });
    expect(result.verdict).toBe('not_recommended');
    expect(result.reasons.join(' ')).toMatch(/over what you earn/i);
  });

  it('is not recommended when it would exceed income', () => {
    const result = scenario({ day: 25, spent: '70000', purchase: '10000' });
    expect(result.verdict).toBe('not_recommended');
  });

  it('never says "you cannot afford this" — it states the consequence', () => {
    const result = scenario({ day: 28, spent: '74000', purchase: '50000' });
    expect(result.verdict).toBe('not_recommended');
    expect(result.headline).not.toMatch(/cannot|can't|forbidden|denied/i);
    expect(result.headline).toMatch(/past what is left|past your income/i);
  });
});

describe('evaluateAffordability — arithmetic', () => {
  it('subtracts commitments that are still due', () => {
    const withoutBills = scenario({ day: 10, spent: '20000', purchase: '30000' });
    const withBills = scenario({ day: 10, spent: '20000', upcoming: '25000', purchase: '30000' });
    expect(withBills.remainingAfter).toBeLessThan(withoutBills.remainingAfter);
  });

  it('recomputes the daily allowance after the purchase', () => {
    const result = scenario({ day: 15, spent: '20000', purchase: '10000' });
    // 75,000 − 20,000 − 10,000 = 45,000 across the 15 remaining days.
    expect(result.remainingAfter).toBe(fromMajor('45000'));
    expect(result.safeDailyAfter).toBe(fromMajor('3000'));
  });

  it('flags a purchase that eats most of what is left, even when it fits', () => {
    // Late in a cycle that is otherwise on track: it fits, but only just.
    const result = scenario({ day: 28, spent: '60000', purchase: '9000' });
    expect(result.shareOfRemaining).toBeGreaterThan(0.5);
    expect(result.projectedOverspendAfter).toBe(0);
    expect(result.verdict).toBe('possible');
    expect(result.headline).toMatch(/large share/i);
  });

  it('never returns a negative safe daily allowance', () => {
    const result = scenario({ day: 29, spent: '70000', purchase: '20000' });
    expect(result.safeDailyAfter).toBeGreaterThanOrEqual(0);
  });

  it('handles a zero savings target without reporting a shortfall', () => {
    const result = scenario({ day: 10, spent: '10000', savingsTarget: '0', purchase: '5000' });
    expect(result.savingsShortfall).toBe(0);
  });

  it('does not divide by zero on the last day of a cycle', () => {
    const progress = cycleProgress(cycle, '2026-09-30');
    const velocity = computeVelocity({
      progress,
      spentToDate: fromMajor('40000'),
      referenceAmount: fromMajor('75000'),
    });
    const result = evaluateAffordability({
      amount: fromMajor('1000'),
      progress,
      velocity,
      income: fromMajor('75000'),
      spentToDate: fromMajor('40000'),
      savingsTarget: ZERO,
      upcomingCommitments: ZERO,
      formatMoney: fmt,
    });
    expect(Number.isFinite(result.safeDailyAfter)).toBe(true);
  });

  it('states the working, not just the verdict', () => {
    const result = scenario({ day: 15, spent: '20000', purchase: '10000' });
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    // Every reason must contain a real figure the user can check.
    expect(result.reasons.some((r) => /₹[\d,]+/.test(r))).toBe(true);
  });
});
