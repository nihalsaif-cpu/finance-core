/**
 * Money — integer minor units (paise for INR).
 *
 * Financial arithmetic NEVER uses floating point. Every amount in the domain is a
 * `Minor`: a branded integer count of the currency's smallest unit. The brand makes
 * it a type error to add a raw number to a money value, which forces all arithmetic
 * through the audited helpers below.
 *
 * Postgres stores these as `bigint`. Values stay far inside Number.MAX_SAFE_INTEGER
 * (9.007e15 paise = ~90 trillion rupees), so JS numbers are exact here.
 */

declare const MinorBrand: unique symbol;

/** An exact integer count of currency minor units (e.g. paise). */
export type Minor = number & { readonly [MinorBrand]: 'minor' };

export const ZERO = 0 as Minor;

/** Minor units per major unit, per currency. INR/USD/EUR = 100. */
const MINOR_SCALE: Record<string, number> = {
  INR: 100,
  USD: 100,
  EUR: 100,
  GBP: 100,
  AED: 100,
  JPY: 1,
};

export function minorScale(currency: string): number {
  return MINOR_SCALE[currency.toUpperCase()] ?? 100;
}

export class MoneyError extends Error {}

/** Wrap an already-minor integer (e.g. a `bigint` column read back from Postgres). */
export function fromMinor(n: number | string | bigint): Minor {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) throw new MoneyError(`Not a finite amount: ${String(n)}`);
  if (!Number.isInteger(v)) throw new MoneyError(`Minor units must be integers, got ${v}`);
  if (!Number.isSafeInteger(v)) throw new MoneyError(`Amount exceeds safe integer range: ${v}`);
  return v as Minor;
}

/**
 * Convert a major-unit value ("1234.56", 1234.56) to minor units.
 *
 * Strings are parsed digit-by-digit so no float ever touches the value — `19.99`
 * as a float is 19.989999999999998, and `Math.round(19.99 * 100)` only happens to
 * work for small values. Numbers are routed through their string form for the same
 * reason.
 */
export function fromMajor(value: number | string, currency = 'INR'): Minor {
  const scale = minorScale(currency);
  const decimals = Math.round(Math.log10(scale));
  const raw = typeof value === 'number' ? numberToPlainString(value) : value.trim();

  const cleaned = raw.replace(/[\s,_]/g, '');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new MoneyError(`Cannot parse amount: ${String(value)}`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] || '0';
  const fracRaw = m[3] ?? '';

  // Pad or round the fractional part to the currency's precision.
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  const roundUp = decimals < fracRaw.length && Number(fracRaw[decimals]) >= 5;

  let total = Number(whole) * scale + (decimals > 0 ? Number(frac) : 0);
  if (roundUp) total += 1;
  if (!Number.isSafeInteger(total)) throw new MoneyError(`Amount too large: ${String(value)}`);
  return (sign * total) as Minor;
}

/** Avoid exponential notation ("1e-7") leaking into the parser. */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`Not a finite amount: ${n}`);
  if (Math.abs(n) >= 1e-6 && Math.abs(n) < 1e21) return n.toString();
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Lenient parse of free-text user/OCR input. Returns null instead of throwing.
 * Handles "₹1,234.56", "Rs. 1234", "1234/-", "INR 1,234", "(1,234.00)" (negative).
 */
export function parseAmountInput(input: string, currency = 'INR'): Minor | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/(^|\s)(dr|debit)(\s|$)/i.test(s)) negative = true;

  s = s
    .replace(/(?:INR|Rs\.?|₹|₹)/gi, ' ')
    .replace(/\b(?:CR|DR|credit|debit)\b/gi, ' ')
    .replace(/\/-\s*$/, ' ')
    .replace(/[\s,_]/g, '');

  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  if (!/^\d*(?:\.\d+)?$/.test(s) || s === '' || s === '.') return null;

  try {
    const v = fromMajor(s, currency);
    return (negative ? -v : v) as Minor;
  } catch {
    return null;
  }
}

export const add = (a: Minor, b: Minor): Minor => fromMinor(a + b);
export const sub = (a: Minor, b: Minor): Minor => fromMinor(a - b);
export const neg = (a: Minor): Minor => fromMinor(-a);
export const abs = (a: Minor): Minor => fromMinor(Math.abs(a));
export const isZero = (a: Minor): boolean => a === 0;
export const isNegative = (a: Minor): boolean => a < 0;
export const isPositive = (a: Minor): boolean => a > 0;
export const max = (a: Minor, b: Minor): Minor => (a >= b ? a : b);
export const min = (a: Minor, b: Minor): Minor => (a <= b ? a : b);
export const clampAtZero = (a: Minor): Minor => (a < 0 ? ZERO : a);

export function sum(values: readonly Minor[]): Minor {
  let acc = 0;
  for (const v of values) acc += v;
  return fromMinor(acc);
}

/** Multiply by a plain scalar, rounding half away from zero. */
export function scale(a: Minor, factor: number): Minor {
  if (!Number.isFinite(factor)) throw new MoneyError(`Bad scale factor: ${factor}`);
  const raw = a * factor;
  return fromMinor(raw < 0 ? -Math.round(-raw) : Math.round(raw));
}

/** Divide by a plain scalar, rounding half away from zero. */
export function divide(a: Minor, divisor: number): Minor {
  if (!Number.isFinite(divisor) || divisor === 0) throw new MoneyError(`Bad divisor: ${divisor}`);
  return scale(a, 1 / divisor);
}

/** Mean of a list; ZERO for an empty list rather than NaN. */
export function mean(values: readonly Minor[]): Minor {
  if (values.length === 0) return ZERO;
  return divide(sum(values), values.length);
}

export const pct = (a: Minor, p: number): Minor => scale(a, p / 100);

/**
 * `part` as a fraction of `whole`. Ratios are dimensionless, so plain floats are
 * correct here — the guarantee we need is that no *amount* is ever a float.
 * Returns null when `whole` is zero, so callers must handle "undefined ratio"
 * rather than rendering NaN% or Infinity%.
 */
export function ratio(part: Minor, whole: Minor): number | null {
  if (whole === 0) return null;
  return part / whole;
}

export function percentage(part: Minor, whole: Minor): number | null {
  const r = ratio(part, whole);
  return r === null ? null : r * 100;
}

/**
 * Split `total` into `n` parts that sum back to exactly `total`, distributing the
 * remainder one minor unit at a time. Used for spreading annual/quarterly recurring
 * charges across cycles without losing paise.
 */
export function split(total: Minor, n: number): Minor[] {
  if (!Number.isInteger(n) || n <= 0) throw new MoneyError(`Bad split count: ${n}`);
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);
  const base = Math.floor(magnitude / n);
  let remainder = magnitude - base * n;
  const out: Minor[] = [];
  for (let i = 0; i < n; i++) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out.push(fromMinor(sign * (base + extra)));
  }
  return out;
}

export function toMajorNumber(a: Minor, currency = 'INR'): number {
  return a / minorScale(currency);
}

export function toMajorString(a: Minor, currency = 'INR'): string {
  const scaleN = minorScale(currency);
  const decimals = Math.round(Math.log10(scaleN));
  const sign = a < 0 ? '-' : '';
  const magnitude = Math.abs(a);
  const whole = Math.floor(magnitude / scaleN);
  if (decimals === 0) return `${sign}${whole}`;
  const frac = String(magnitude % scaleN).padStart(decimals, '0');
  return `${sign}${whole}.${frac}`;
}

const SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED ',
  JPY: '¥',
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
}

/**
 * Indian digit grouping (1,23,456) — implemented directly rather than via Intl so
 * it is deterministic across Hermes/Node and covered by unit tests.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function groupWestern(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatOptions {
  currency?: string;
  /** Show the currency symbol. Default true. */
  symbol?: boolean;
  /** Force decimals on/off. Default: hide when the amount is a whole major unit. */
  decimals?: boolean;
  /** Render 12,34,567 as "12.3L". Useful for dense dashboard tiles. */
  compact?: boolean;
  /** Always render an explicit + or - sign. */
  signed?: boolean;
}

export function format(a: Minor, options: FormatOptions = {}): string {
  const currency = options.currency ?? 'INR';
  const useSymbol = options.symbol !== false;
  const scaleN = minorScale(currency);
  const decimals = Math.round(Math.log10(scaleN));
  const indian = currency.toUpperCase() === 'INR';

  const negative = a < 0;
  const magnitude = Math.abs(a);

  let body: string;
  if (options.compact) {
    body = compactBody(magnitude, scaleN, indian);
  } else {
    const showDecimals = options.decimals ?? magnitude % scaleN !== 0;
    const whole = Math.floor(magnitude / scaleN);
    const grouped = indian ? groupIndian(String(whole)) : groupWestern(String(whole));
    body =
      showDecimals && decimals > 0
        ? `${grouped}.${String(magnitude % scaleN).padStart(decimals, '0')}`
        : grouped;
  }

  const sign = negative ? '-' : options.signed ? '+' : '';
  return `${sign}${useSymbol ? currencySymbol(currency) : ''}${body}`;
}

function compactBody(magnitude: number, scaleN: number, indian: boolean): string {
  const major = magnitude / scaleN;
  const units: Array<[number, string]> = indian
    ? [
        [1e7, 'Cr'],
        [1e5, 'L'],
        [1e3, 'K'],
      ]
    : [
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K'],
      ];
  for (const [threshold, suffix] of units) {
    if (major >= threshold) {
      const scaled = major / threshold;
      const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  const whole = Math.floor(major);
  return indian ? groupIndian(String(whole)) : groupWestern(String(whole));
}

/**
 * Format a PROJECTED or DERIVED figure — always whole units.
 *
 * A projection carrying paise ("you will have ₹58,990.12 spare") claims a precision
 * the number does not have, and false precision is the fastest way for a finance app
 * to lose trust. Recorded amounts keep their paise; anything the app inferred is
 * rounded to whole currency units.
 */
export function formatApprox(a: Minor, options: FormatOptions = {}): string {
  return format(a, { ...options, decimals: false });
}

/** Signed display used for deltas: "+₹1,200" / "-₹340". */
export function formatDelta(a: Minor, options: FormatOptions = {}): string {
  return format(a, { ...options, signed: true });
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}
