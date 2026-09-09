/**
 * Civil dates — calendar days, not instants.
 *
 * A transaction happened on "14 August 2026". It did not happen at an instant that
 * shifts between days depending on the reader's timezone. Every date in the domain is
 * an `ISODate` string ("YYYY-MM-DD"), and all arithmetic runs in UTC internally so it
 * can never drift by a day. `Date` objects appear only at the edges: reading "today"
 * from the device clock, and formatting for display.
 */

export type ISODate = string; // YYYY-MM-DD

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function parseISO(value: ISODate): CivilDate {
  const m = ISO_RE.exec(value);
  if (!m) throw new Error(`Invalid ISO date: ${value}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function toISO(c: CivilDate): ISODate {
  const mm = String(c.month).padStart(2, '0');
  const dd = String(c.day).padStart(2, '0');
  return `${String(c.year).padStart(4, '0')}-${mm}-${dd}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] ?? 30;
}

/** Days since the Unix epoch — the integer we do all date arithmetic on. */
export function toEpochDay(value: ISODate): number {
  const { year, month, day } = parseISO(value);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function fromEpochDay(epochDay: number): ISODate {
  const d = new Date(epochDay * 86_400_000);
  return toISO({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
}

export function addDays(value: ISODate, days: number): ISODate {
  return fromEpochDay(toEpochDay(value) + days);
}

/**
 * Add calendar months, clamping the day to the target month's length.
 * 31 Jan + 1 month = 28/29 Feb — the behaviour a salary cycle needs.
 */
export function addMonths(value: ISODate, months: number): ISODate {
  const { year, month, day } = parseISO(value);
  const zeroBased = year * 12 + (month - 1) + months;
  const newYear = Math.floor(zeroBased / 12);
  const newMonth = (zeroBased % 12) + 1;
  return toISO({ year: newYear, month: newMonth, day: Math.min(day, daysInMonth(newYear, newMonth)) });
}

/** Signed difference in days: `b - a`. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** Inclusive day count of the closed interval [a, b]. */
export function inclusiveDayCount(a: ISODate, b: ISODate): number {
  return daysBetween(a, b) + 1;
}

export function compare(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const isBefore = (a: ISODate, b: ISODate): boolean => a < b;
export const isAfter = (a: ISODate, b: ISODate): boolean => a > b;

/** Inclusive on both ends. */
export function isWithin(value: ISODate, start: ISODate, end: ISODate): boolean {
  return value >= start && value <= end;
}

export function clamp(value: ISODate, start: ISODate, end: ISODate): ISODate {
  if (value < start) return start;
  if (value > end) return end;
  return value;
}

export const minDate = (a: ISODate, b: ISODate): ISODate => (a <= b ? a : b);
export const maxDate = (a: ISODate, b: ISODate): ISODate => (a >= b ? a : b);

export function startOfMonth(value: ISODate): ISODate {
  const { year, month } = parseISO(value);
  return toISO({ year, month, day: 1 });
}

export function endOfMonth(value: ISODate): ISODate {
  const { year, month } = parseISO(value);
  return toISO({ year, month, day: daysInMonth(year, month) });
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(value: ISODate): number {
  return ((toEpochDay(value) + 4) % 7 + 7) % 7;
}

export function isWeekend(value: ISODate): boolean {
  const d = dayOfWeek(value);
  return d === 0 || d === 6;
}

/**
 * Today as a civil date in the given IANA timezone. The timezone is explicit because
 * "today" is the one genuinely timezone-dependent question in the domain, and getting
 * it from the device's local offset silently breaks for a user who travels.
 */
export function todayISO(timeZone = 'Asia/Kolkata', now: Date = new Date()): ISODate {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    if (ISO_RE.test(parts)) return parts;
  } catch {
    // Fall through to the local-time approximation below.
  }
  return toISO({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function monthShort(month: number): string {
  return MONTH_SHORT[month - 1] ?? '';
}

export function monthLong(month: number): string {
  return MONTH_LONG[month - 1] ?? '';
}

/** "14 Aug" */
export function formatDayMonth(value: ISODate): string {
  const { month, day } = parseISO(value);
  return `${day} ${monthShort(month)}`;
}

/** "14 Aug 2026" */
export function formatFull(value: ISODate): string {
  const { year, month, day } = parseISO(value);
  return `${day} ${monthShort(month)} ${year}`;
}

/** "August 2026" */
export function formatMonthYear(value: ISODate): string {
  const { year, month } = parseISO(value);
  return `${monthLong(month)} ${year}`;
}

export function formatWeekday(value: ISODate): string {
  return DAY_SHORT[dayOfWeek(value)] ?? '';
}

/** "Today" / "Yesterday" / "14 Aug" — for transaction list headers. */
export function formatRelativeDay(value: ISODate, today: ISODate): string {
  const diff = daysBetween(value, today);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  const sameYear = parseISO(value).year === parseISO(today).year;
  return sameYear ? formatDayMonth(value) : formatFull(value);
}

// ---------------------------------------------------------------------------
// Lenient parsing (OCR / statement imports)
// ---------------------------------------------------------------------------

export type DayFirstPreference = 'day-first' | 'month-first';

export interface ParseDateResult {
  date: ISODate;
  /** True when the source was like "05/06/2026" and could be read either way. */
  ambiguous: boolean;
}

const MONTH_NAMES: Record<string, number> = {};
MONTH_LONG.forEach((name, i) => {
  MONTH_NAMES[name.toLowerCase()] = i + 1;
  MONTH_NAMES[MONTH_SHORT[i]!.toLowerCase()] = i + 1;
});
MONTH_NAMES['sept'] = 9;

/**
 * Parse the date formats that turn up in Indian bank statements, UPI screenshots and
 * card apps. Returns null rather than guessing wildly.
 *
 * `preference` decides 05/06/2026: Indian statements are overwhelmingly day-first,
 * but the caller can override per-import once a format is known.
 */
export function parseLooseDate(
  input: string,
  options: { preference?: DayFirstPreference; today?: ISODate } = {},
): ParseDateResult | null {
  if (!input) return null;
  const preference = options.preference ?? 'day-first';
  const today = options.today ?? todayISO();
  const s = String(input).trim().replace(/\s+/g, ' ');
  if (!s) return null;

  // 2026-08-14 / 2026/08/14
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]), false);

  // 14 Aug 2026 / 14-Aug-26 / 14 August 2026 / 14th Sept 2026 / 14 Aug
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([A-Za-z]{3,9})[\s\-/.,]*(\d{2,4})?$/.exec(s);
  if (m && MONTH_NAMES[m[2]!.toLowerCase()]) {
    const month = MONTH_NAMES[m[2]!.toLowerCase()]!;
    const day = Number(m[1]);
    return build(resolveYear(m[3], month, day, today), month, day, false);
  }

  // Aug 14, 2026 / August 14 2026 / Aug 14
  m = /^([A-Za-z]{3,9})[\s\-/.]*(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*(\d{2,4})?$/.exec(s);
  if (m && MONTH_NAMES[m[1]!.toLowerCase()]) {
    const month = MONTH_NAMES[m[1]!.toLowerCase()]!;
    const day = Number(m[2]);
    return build(resolveYear(m[3], month, day, today), month, day, false);
  }

  // 14/08/2026, 14-08-26, 08/14/2026
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = expandYear(m[3]!, today);
    // If one value can only be a day, the layout is forced regardless of preference.
    if (a > 12 && b <= 12) return build(year, b, a, false);
    if (b > 12 && a <= 12) return build(year, a, b, false);
    if (a > 12 && b > 12) return null;
    const ambiguous = a !== b;
    return preference === 'day-first' ? build(year, b, a, ambiguous) : build(year, a, b, ambiguous);
  }

  return null;

  function build(year: number, month: number, day: number, ambiguous: boolean): ParseDateResult | null {
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    if (year < 1970 || year > 2200) return null;
    return { date: toISO({ year, month, day }), ambiguous };
  }
}

/** A named-month date with no year infers the most recent past occurrence. */
function resolveYear(raw: string | undefined, month: number, day: number, today: ISODate): number {
  return raw ? expandYear(raw, today) : inferYear(month, day, today);
}

function expandYear(raw: string, today: ISODate): number {
  const n = Number(raw);
  if (raw.length === 4) return n;
  // Two-digit years: pick the century that lands closest to the current year.
  const currentCentury = Math.floor(parseISO(today).year / 100) * 100;
  const candidate = currentCentury + n;
  return candidate - parseISO(today).year > 20 ? candidate - 100 : candidate;
}

/** For "14 Aug" with no year: the most recent occurrence at or before today. */
function inferYear(month: number, day: number, today: ISODate): number {
  const { year } = parseISO(today);
  const thisYear = toISO({ year, month, day: Math.min(day, daysInMonth(year, month)) });
  return thisYear <= today ? year : year - 1;
}
