import { describe, it, expect } from 'vitest';
import { digestLine, evaluateAlerts, inQuietHours, unsentAlerts, type AlertPreferences } from '../src/alerts';
import { format, fromMajor, ZERO } from '../src/money';
import type { BudgetEvaluation } from '../src/analytics';
import type { VelocityResult } from '../src/velocity';

const money = (v: never) => format(v, { currency: 'INR' });

const PREFS: AlertPreferences = {
  enabled: true, budgetWarning: true, budgetExceeded: true,
  paceWarning: true, savingsRisk: true, quietHoursStart: null, quietHoursEnd: null,
};

const budget = (over: Partial<BudgetEvaluation> = {}): BudgetEvaluation => ({
  categoryId: 'cat-food', label: 'Food', budget: fromMajor('10000'),
  spent: fromMajor('5000'), remaining: fromMajor('5000'), percentUsed: 50,
  projected: fromMajor('9000'), projectedOverspend: ZERO, status: 'healthy',
  ...over,
});

const velocity = (over: Partial<VelocityResult> = {}): VelocityResult =>
  ({
    status: 'on_track', projectedOverspend: ZERO, safeDailySpend: fromMajor('900'),
    ...over,
  }) as VelocityResult;

const run = (over: Partial<Parameters<typeof evaluateAlerts>[0]> = {}) =>
  evaluateAlerts({
    budgets: [], velocity: velocity(), daysRemaining: 10,
    savingsTarget: ZERO, projectedSavings: ZERO, preferences: PREFS,
    money: money as never, cycleKey: '2026-09', ...over,
  });

describe('evaluateAlerts', () => {
  it('says nothing when everything is fine', () => {
    expect(run({ budgets: [budget()] })).toEqual([]);
  });

  it('reports a blown budget with the figures', () => {
    const [a] = run({
      budgets: [budget({ status: 'over_budget', spent: fromMajor('11500'), percentUsed: 115 })],
    });
    expect(a!.kind).toBe('budget_exceeded');
    expect(a!.severity).toBe('critical');
    expect(a!.body).toContain('11,500');
    expect(a!.body).toContain('115%');
  });

  it('warns before the limit, not only after', () => {
    const [a] = run({
      budgets: [budget({ status: 'near_limit', percentUsed: 92, remaining: fromMajor('800') })],
    });
    expect(a!.kind).toBe('budget_warning');
    expect(a!.body).toContain('800');
  });

  it('does not warn at half spent', () => {
    expect(run({ budgets: [budget({ status: 'near_limit', percentUsed: 55 })] })).toEqual([]);
  });

  it('reports a budget heading over while there is still time', () => {
    const [a] = run({
      budgets: [budget({ status: 'projected_over', projected: fromMajor('13000') })],
      daysRemaining: 8,
    });
    expect(a!.kind).toBe('projected_over');
  });

  it('stays quiet about a projection on the last days', () => {
    // The money is effectively spent; a buzz achieves nothing.
    expect(run({
      budgets: [budget({ status: 'projected_over' })],
      daysRemaining: 1,
    })).toEqual([]);
  });

  it('raises one alert per budget, not two', () => {
    const alerts = run({
      budgets: [budget({ status: 'over_budget', percentUsed: 120 })],
    });
    expect(alerts).toHaveLength(1);
  });

  it('reports critical pace with the overspend', () => {
    const [a] = run({ velocity: velocity({ status: 'critical', projectedOverspend: fromMajor('6200') }) });
    expect(a!.kind).toBe('pace_critical');
    expect(a!.body).toContain('6,200');
  });

  it('tells the user the daily figure that fixes an over pace', () => {
    const [a] = run({ velocity: velocity({ status: 'over', safeDailySpend: fromMajor('740') }) });
    expect(a!.body).toContain('740');
  });

  it('never warns about a savings target that was never set', () => {
    expect(run({ savingsTarget: ZERO, projectedSavings: fromMajor('-500') })).toEqual([]);
  });

  it('warns when a real savings target is at risk', () => {
    const [a] = run({ savingsTarget: fromMajor('15000'), projectedSavings: fromMajor('4000') });
    expect(a!.kind).toBe('savings_risk');
  });

  it('respects every preference switch', () => {
    const off = { ...PREFS, budgetExceeded: false };
    expect(run({
      budgets: [budget({ status: 'over_budget', percentUsed: 120 })],
      preferences: off,
    })).toEqual([]);
  });

  it('says nothing at all when notifications are off', () => {
    expect(run({
      budgets: [budget({ status: 'over_budget', percentUsed: 200 })],
      velocity: velocity({ status: 'critical' }),
      preferences: { ...PREFS, enabled: false },
    })).toEqual([]);
  });

  it('puts the most severe first', () => {
    const alerts = run({
      budgets: [
        budget({ categoryId: 'cat-a', label: 'Travel', status: 'near_limit', percentUsed: 85 }),
        budget({ categoryId: 'cat-b', label: 'Food', status: 'over_budget', percentUsed: 130 }),
      ],
    });
    expect(alerts[0]!.severity).toBe('critical');
    expect(alerts[0]!.title).toContain('Food');
  });
});

describe('inQuietHours', () => {
  it('handles a window that crosses midnight', () => {
    // 22:00–07:00 is the normal setting and the one a naive comparison inverts.
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(3, 22, 7)).toBe(true);
    expect(inQuietHours(12, 22, 7)).toBe(false);
  });

  it('handles a daytime window', () => {
    expect(inQuietHours(10, 9, 17)).toBe(true);
    expect(inQuietHours(20, 9, 17)).toBe(false);
  });

  it('is off when unset', () => {
    expect(inQuietHours(3, null, null)).toBe(false);
  });
});

describe('unsentAlerts', () => {
  it('filters out anything already sent this cycle', () => {
    const alerts = run({ budgets: [budget({ status: 'over_budget', percentUsed: 120 })] });
    expect(unsentAlerts(alerts, [alerts[0]!.key])).toEqual([]);
  });

  it('keys by cycle so the same alert can fire again next month', () => {
    const sept = run({ budgets: [budget({ status: 'over_budget', percentUsed: 120 })], cycleKey: '2026-09' });
    const oct = run({ budgets: [budget({ status: 'over_budget', percentUsed: 120 })], cycleKey: '2026-10' });
    expect(unsentAlerts(oct, [sept[0]!.key])).toHaveLength(1);
  });
});

describe('digestLine', () => {
  it('leads with the most severe', () => {
    const alerts = run({ budgets: [budget({ status: 'over_budget', percentUsed: 120 })] });
    expect(digestLine(alerts)?.kind).toBe('budget_exceeded');
  });

  it('is null when there is nothing to say', () => {
    expect(digestLine([])).toBeNull();
  });
});
