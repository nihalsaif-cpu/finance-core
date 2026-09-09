import { describe, it, expect } from 'vitest';
import * as M from '../src/money';

describe('fromMajor', () => {
  it('parses whole and decimal rupee strings exactly', () => {
    expect(M.fromMajor('1234.56')).toBe(123456);
    expect(M.fromMajor('1234')).toBe(123400);
    expect(M.fromMajor('0.01')).toBe(1);
    expect(M.fromMajor('.5')).toBe(50);
  });

  it('avoids the float representation trap', () => {
    // Math.round(19.99 * 100) is the naive version; these are the cases it breaks on.
    expect(M.fromMajor('19.99')).toBe(1999);
    expect(M.fromMajor(19.99)).toBe(1999);
    expect(M.fromMajor('1.005')).toBe(101); // half rounds away from zero
    expect(M.fromMajor('8.165')).toBe(817); // float 8.165*100 = 816.4999...
    expect(M.fromMajor('4.475')).toBe(448);
  });

  it('handles signs, separators and over-precision', () => {
    expect(M.fromMajor('-250.75')).toBe(-25075);
    expect(M.fromMajor('1,23,456.50')).toBe(12345650);
    expect(M.fromMajor('10.004')).toBe(1000);
    expect(M.fromMajor('10.005')).toBe(1001);
  });

  it('respects zero-decimal currencies', () => {
    expect(M.fromMajor('1234', 'JPY')).toBe(1234);
  });

  it('rejects garbage', () => {
    expect(() => M.fromMajor('abc')).toThrow(M.MoneyError);
    expect(() => M.fromMajor('')).toThrow(M.MoneyError);
  });
});

describe('fromMinor', () => {
  it('rejects non-integers so a stray float cannot enter the domain', () => {
    expect(() => M.fromMinor(10.5)).toThrow(M.MoneyError);
    expect(() => M.fromMinor(NaN)).toThrow(M.MoneyError);
    expect(() => M.fromMinor(Number.MAX_SAFE_INTEGER + 2)).toThrow(M.MoneyError);
  });

  it('accepts bigint and string forms from the database', () => {
    expect(M.fromMinor('84700')).toBe(84700);
    expect(M.fromMinor(84700n)).toBe(84700);
  });
});

describe('parseAmountInput', () => {
  const cases: Array<[string, number | null]> = [
    ['₹847', 84700],
    ['Rs. 1,234.50', 123450],
    ['INR 2499', 249900],
    ['1234/-', 123400],
    ['(1,250.00)', -125000],
    ['500 DR', -50000],
    ['500 CR', 50000],
    ['-99.99', -9999],
    ['', null],
    ['n/a', null],
    ['12.3.4', null],
  ];
  it.each(cases)('parses %s', (input, expected) => {
    expect(M.parseAmountInput(input)).toBe(expected);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = M.fromMajor('0.1');
    const b = M.fromMajor('0.2');
    expect(M.add(a, b)).toBe(M.fromMajor('0.3')); // 0.1 + 0.2 !== 0.3 in float
  });

  it('sums a long list without drift', () => {
    const items = Array.from({ length: 1000 }, () => M.fromMajor('0.07'));
    expect(M.sum(items)).toBe(M.fromMajor('70'));
  });

  it('scales and divides with half-away-from-zero rounding', () => {
    expect(M.scale(M.fromMajor('100'), 0.335)).toBe(3350);
    expect(M.divide(M.fromMajor('100'), 3)).toBe(3333);
    expect(M.scale(M.fromMajor('-1.5'), 1 / 100)).toBe(-2);
  });

  it('means an empty list to zero, not NaN', () => {
    expect(M.mean([])).toBe(0);
  });

  it('splits without losing minor units', () => {
    const parts = M.split(M.fromMajor('100'), 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(M.sum(parts)).toBe(M.fromMajor('100'));
  });

  it('splits negatives symmetrically', () => {
    const parts = M.split(M.fromMajor('-10'), 3);
    expect(M.sum(parts)).toBe(M.fromMajor('-10'));
  });
});

describe('ratio', () => {
  it('returns null instead of Infinity or NaN when the base is zero', () => {
    expect(M.ratio(M.fromMajor('10'), M.ZERO)).toBeNull();
    expect(M.percentage(M.fromMajor('10'), M.ZERO)).toBeNull();
    expect(M.formatPercent(null)).toBe('—');
  });

  it('computes percentages', () => {
    expect(M.percentage(M.fromMajor('4320'), M.fromMajor('7500'))).toBeCloseTo(57.6);
  });
});

describe('format', () => {
  it('uses Indian digit grouping', () => {
    expect(M.format(M.fromMajor('75000'))).toBe('₹75,000');
    expect(M.format(M.fromMajor('123456'))).toBe('₹1,23,456');
    expect(M.format(M.fromMajor('12345678'))).toBe('₹1,23,45,678');
    expect(M.format(M.fromMajor('999'))).toBe('₹999');
  });

  it('shows paise only when present, unless forced', () => {
    expect(M.format(M.fromMajor('847.50'))).toBe('₹847.50');
    expect(M.format(M.fromMajor('847'))).toBe('₹847');
    expect(M.format(M.fromMajor('847'), { decimals: true })).toBe('₹847.00');
  });

  it('formats negatives, deltas and compact values', () => {
    expect(M.format(M.fromMajor('-1200'))).toBe('-₹1,200');
    expect(M.formatDelta(M.fromMajor('6400'))).toBe('+₹6,400');
    expect(M.format(M.fromMajor('1234567'), { compact: true })).toBe('₹12.3L');
    expect(M.format(M.fromMajor('45000'), { compact: true })).toBe('₹45K');
    expect(M.format(M.fromMajor('25000000'), { compact: true })).toBe('₹2.5Cr');
  });

  it('round-trips through toMajorString', () => {
    expect(M.toMajorString(M.fromMajor('1234.05'))).toBe('1234.05');
    expect(M.toMajorString(M.fromMajor('-0.09'))).toBe('-0.09');
  });
});
