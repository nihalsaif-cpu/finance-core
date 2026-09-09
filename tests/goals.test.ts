import { describe, expect, it } from 'vitest';
import { fromMajor, goalProgress, ZERO } from '../src/index';

const base = {
  targetAmount: fromMajor('200000'),
  currentAmount: fromMajor('50000'),
  targetDate: '2027-09-09' as const,
  monthlyContribution: fromMajor('12500'),
  today: '2026-09-09' as const,
};

describe('goalProgress', () => {
  it('is on track when the contribution covers what is required', () => {
    // 150,000 remaining over ~12 months needs ~12,500 a month.
    const p = goalProgress(base);
    expect(p.status).toBe('on_track');
    expect(p.monthlyShortfall).toBe(0);
    expect(p.percentComplete).toBe(25);
  });

  it('is behind, not stalled, when it will arrive late', () => {
    // Arriving late is not the same as not arriving. The useful number is the gap.
    const p = goalProgress({ ...base, monthlyContribution: fromMajor('5000') });
    expect(p.status).toBe('behind');
    expect(p.monthlyShortfall).toBeGreaterThan(0);
    expect(p.projectedDate).not.toBeNull();
  });

  it('is stalled with no contribution, and offers no completion date', () => {
    // A date derived from dividing by zero is worse than admitting the plan does not
    // reach the target.
    const p = goalProgress({ ...base, monthlyContribution: ZERO });
    expect(p.status).toBe('stalled');
    expect(p.projectedDate).toBeNull();
    expect(p.projectedMonths).toBeNull();
  });

  it('refuses a completion date beyond fifty years', () => {
    const p = goalProgress({
      ...base,
      targetAmount: fromMajor('10000000'),
      currentAmount: ZERO,
      monthlyContribution: fromMajor('100'),
    });
    expect(p.projectedDate).toBeNull();
  });

  it('cannot be behind without a target date', () => {
    // "On track" implies a schedule. Without one there is nothing to be on track
    // against, and inventing a status would sound more informed than the data is.
    const p = goalProgress({ ...base, targetDate: null, monthlyContribution: fromMajor('1') });
    expect(p.status).toBe('undated');
    expect(p.requiredMonthly).toBeNull();
    expect(p.monthlyShortfall).toBeNull();
    expect(p.monthsToTarget).toBeNull();
  });

  it('reports complete once the target is met, and does not exceed 100%', () => {
    const p = goalProgress({ ...base, currentAmount: fromMajor('250000') });
    expect(p.status).toBe('complete');
    expect(p.percentComplete).toBe(100);
    expect(p.remaining).toBe(0);
  });

  it('requires the whole remainder when the target date is today', () => {
    // Zero months left is not a division by zero — it is "all of it, now".
    const p = goalProgress({ ...base, targetDate: '2026-09-09' });
    expect(p.monthsToTarget).toBe(0);
    expect(p.requiredMonthly).toBe(fromMajor('150000'));
  });

  it('floors the months left rather than rounding up', () => {
    // Rounding up understates what is needed each month, which is the direction that
    // costs the user the goal.
    const p = goalProgress({ ...base, targetDate: '2026-10-24' });
    expect(p.monthsToTarget).toBe(1);
  });
});
