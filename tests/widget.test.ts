import { describe, it, expect } from 'vitest';
import { buildWidgetSnapshot } from '../src/widget';
import { format, fromMajor } from '../src/money';
import { rs } from './helpers/factory';

const money = (v: never) => format(v, { currency: 'INR' });
const build = (today: string, remaining: string, daysLeft: number) =>
  buildWidgetSnapshot({
    today: fromMajor(today),
    remaining: fromMajor(remaining),
    daysLeft,
    currency: 'INR',
    asOf: '2026-08-28',
    money: money as never,
  });

describe('buildWidgetSnapshot', () => {
  it('divides what is left across the days remaining', () => {
    expect(build('0', '9000', 9).safeDaily).toBe(rs(1000));
  });

  it('counts today among the days left', () => {
    // 3 days left means today plus two more — not three more.
    expect(build('0', '3000', 3).safeDaily).toBe(rs(1000));
  });

  it('does not divide by zero on the last day', () => {
    const s = build('0', '2500', 0);
    expect(s.safeDaily).toBe(rs(2500));
  });

  it('is good when today is under the daily allowance', () => {
    expect(build('400', '9000', 9).tone).toBe('good');
  });

  it('warns when today has passed the daily allowance', () => {
    expect(build('1600', '9000', 9).tone).toBe('watch');
  });

  it('flags an overspent cycle regardless of today', () => {
    expect(build('0', '-500', 5).tone).toBe('over');
  });

  it('says how much is still available today', () => {
    expect(build('400', '9000', 9).caption).toBe('₹600 left today');
  });

  it('names the limit that was passed rather than a negative figure', () => {
    // "-₹600 left today" is technically true and useless on a glanceable surface.
    expect(build('1600', '9000', 9).caption).toBe("₹1,000 was today's limit");
  });

  it('is blunt about being over budget', () => {
    expect(build('0', '-1', 5).caption).toBe('Past your budget');
  });

  it('carries the date so a stale widget can admit it', () => {
    expect(build('0', '1000', 1).asOf).toBe('2026-08-28');
  });
});
