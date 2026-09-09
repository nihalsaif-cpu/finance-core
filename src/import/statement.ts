/**
 * Statement row parsing.
 *
 * Turns detected columns plus raw cells into candidate transactions. Every row that
 * cannot be parsed confidently carries an explicit warning rather than being dropped
 * — a silently skipped row is a missing expense the user will never know about, which
 * is worse than a row they have to correct.
 */

import { isValidISODate, parseLooseDate, type DayFirstPreference, type ISODate } from '../date';
import { parseAmountInput, type Minor } from '../money';
import type { ColumnMap, DetectionResult } from './columns';
import { detectColumns } from './columns';

export interface ParsedRow {
  rowIndex: number;
  /** The source row verbatim, so a mis-parse can be diagnosed later. */
  rawText: string;
  date: ISODate | null;
  /** Signed: negative for money out, positive for money in. */
  signedAmount: Minor | null;
  description: string;
  referenceNo: string | null;
  balance: Minor | null;
  /** 0–1 confidence in this row specifically. */
  confidence: number;
  warnings: string[];
}

export interface StatementParseResult {
  rows: ParsedRow[];
  detection: DetectionResult;
  /** Rows skipped because they were blank, totals, or page furniture. */
  skipped: number;
  /** Whether dates were read day-first or month-first. */
  datePreference: DayFirstPreference;
}

export const WARNINGS = {
  dateMissing: 'date_missing',
  dateAmbiguous: 'date_ambiguous',
  amountMissing: 'amount_missing',
  amountUncertain: 'amount_uncertain',
  descriptionMissing: 'description_missing',
  directionUnknown: 'direction_unknown',
} as const;

/** Rows that are totals, page furniture or blanks rather than transactions. */
const NON_TRANSACTION_PATTERNS: RegExp[] = [
  /^\s*(?:total|grand\s*total|sub\s*total|opening\s*balance|closing\s*balance|balance\s*b\/?f|balance\s*c\/?f)\b/i,
  /^\s*(?:statement\s*of|account\s*statement|page\s*\d+|continued)/i,
  /^\s*\*+\s*end\s*of\s*statement/i,
  /^[\s,|-]*$/,
];

function looksLikeTransactionRow(text: string): boolean {
  return !NON_TRANSACTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Decide day-first vs month-first for the whole file at once.
 *
 * Per-row guessing is dangerous: a statement where most dates are unambiguous but a
 * few are not would silently mix conventions. If ANY date in the file has a
 * day component above 12, the layout is proven for every row.
 */
export interface DateLayout {
  preference: DayFirstPreference;
  /**
   * True when at least one date in the file has a component above 12, which settles
   * the layout for every other row. Individual rows are then no longer ambiguous,
   * even though each one read alone would be.
   */
  proven: boolean;
}

export function detectDatePreference(
  rows: readonly (readonly string[])[],
  dateColumn: number | undefined,
): DateLayout {
  if (dateColumn === undefined) return { preference: 'day-first', proven: false };
  let dayFirstEvidence = 0;
  let monthFirstEvidence = 0;

  for (const row of rows) {
    const cell = (row[dateColumn] ?? '').trim();
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(cell);
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a > 12 && b <= 12) dayFirstEvidence += 1;
    else if (b > 12 && a <= 12) monthFirstEvidence += 1;
  }

  if (monthFirstEvidence > dayFirstEvidence) return { preference: 'month-first', proven: true };
  if (dayFirstEvidence > 0) return { preference: 'day-first', proven: true };
  // Nothing in the file settles it. Indian statements are overwhelmingly day-first,
  // so that is the assumption — but each row stays flagged as ambiguous.
  return { preference: 'day-first', proven: false };
}

export interface ParseOptions {
  today?: ISODate;
  /** Overrides automatic detection when the user corrects the mapping. */
  columns?: ColumnMap;
  datePreference?: DayFirstPreference;
}

export function parseStatementRows(
  rows: readonly (readonly string[])[],
  options: ParseOptions = {},
): StatementParseResult {
  const detection = options.columns
    ? { headerRowIndex: -1, columns: options.columns, confidence: 1, warnings: [] }
    : detectColumns(rows);

  const columns = detection.columns;
  const bodyStart = detection.headerRowIndex >= 0 ? detection.headerRowIndex + 1 : 0;
  const body = rows.slice(bodyStart);

  const detectedLayout = detectDatePreference(body, columns.date);
  const datePreference = options.datePreference ?? detectedLayout.preference;
  // An explicit user override is as settled as file-level evidence.
  const layoutProven = options.datePreference !== undefined || detectedLayout.proven;

  const parsed: ParsedRow[] = [];
  let skipped = 0;

  body.forEach((cells, offset) => {
    const rawText = cells.map((cell) => (cell ?? '').trim()).filter(Boolean).join(' | ');
    if (!rawText || !looksLikeTransactionRow(rawText)) {
      skipped += 1;
      return;
    }

    const warnings: string[] = [];
    let confidence = 1;

    // --- Date ---------------------------------------------------------------
    let date: ISODate | null = null;
    const dateCell = columns.date !== undefined ? (cells[columns.date] ?? '').trim() : '';
    if (dateCell) {
      const result = parseLooseDate(dateCell, { preference: datePreference, ...(options.today ? { today: options.today } : {}) });
      if (result) {
        date = result.date;
        if (result.ambiguous && !layoutProven) {
          warnings.push(WARNINGS.dateAmbiguous);
          confidence -= 0.2;
        }
      }
    }
    if (!date && columns.value_date !== undefined) {
      const fallback = parseLooseDate((cells[columns.value_date] ?? '').trim(), {
        preference: datePreference,
        ...(options.today ? { today: options.today } : {}),
      });
      if (fallback) date = fallback.date;
    }
    if (!date) {
      warnings.push(WARNINGS.dateMissing);
      confidence -= 0.35;
    }

    // --- Amount -------------------------------------------------------------
    const { signedAmount, amountWarnings, amountPenalty } = readAmount(cells, columns);
    warnings.push(...amountWarnings);
    confidence -= amountPenalty;

    // --- Description --------------------------------------------------------
    const description =
      columns.description !== undefined ? (cells[columns.description] ?? '').trim() : '';
    if (!description) {
      warnings.push(WARNINGS.descriptionMissing);
      confidence -= 0.15;
    }

    const referenceNo =
      columns.reference !== undefined ? (cells[columns.reference] ?? '').trim() || null : null;
    const balance =
      columns.balance !== undefined ? parseAmountInput(cells[columns.balance] ?? '') : null;

    parsed.push({
      rowIndex: bodyStart + offset,
      rawText,
      date,
      signedAmount,
      // Fall back to the raw row so an unmapped description column does not leave the
      // user staring at a blank merchant.
      description: description || rawText,
      referenceNo,
      balance,
      confidence: Math.max(0, Math.min(1, confidence)),
      warnings,
    });
  });

  return { rows: parsed, detection, skipped, datePreference };
}

function readAmount(
  cells: readonly string[],
  columns: ColumnMap,
): { signedAmount: Minor | null; amountWarnings: string[]; amountPenalty: number } {
  const warnings: string[] = [];

  // Separate debit and credit columns: the populated one determines direction.
  if (columns.debit !== undefined || columns.credit !== undefined) {
    const debit = columns.debit !== undefined ? parseAmountInput(cells[columns.debit] ?? '') : null;
    const credit = columns.credit !== undefined ? parseAmountInput(cells[columns.credit] ?? '') : null;

    if (debit !== null && debit !== 0 && credit !== null && credit !== 0) {
      // Both populated is contradictory; take the larger and flag it.
      warnings.push(WARNINGS.amountUncertain);
      const value = Math.abs(debit) >= Math.abs(credit) ? -Math.abs(debit) : Math.abs(credit);
      return { signedAmount: value as Minor, amountWarnings: warnings, amountPenalty: 0.3 };
    }
    if (debit !== null && debit !== 0) {
      return { signedAmount: (-Math.abs(debit)) as Minor, amountWarnings: warnings, amountPenalty: 0 };
    }
    if (credit !== null && credit !== 0) {
      return { signedAmount: Math.abs(credit) as Minor, amountWarnings: warnings, amountPenalty: 0 };
    }
    warnings.push(WARNINGS.amountMissing);
    return { signedAmount: null, amountWarnings: warnings, amountPenalty: 0.5 };
  }

  // Single amount column, direction from an indicator or the sign.
  if (columns.amount !== undefined) {
    const raw = (cells[columns.amount] ?? '').trim();
    const value = parseAmountInput(raw);
    if (value === null || value === 0) {
      warnings.push(WARNINGS.amountMissing);
      return { signedAmount: null, amountWarnings: warnings, amountPenalty: 0.5 };
    }

    const indicator =
      columns.direction !== undefined ? (cells[columns.direction] ?? '').trim().toUpperCase() : '';

    if (/^(?:DR|D|DEBIT|WITHDRAWAL)$/.test(indicator)) {
      return { signedAmount: (-Math.abs(value)) as Minor, amountWarnings: warnings, amountPenalty: 0 };
    }
    if (/^(?:CR|C|CREDIT|DEPOSIT)$/.test(indicator)) {
      return { signedAmount: Math.abs(value) as Minor, amountWarnings: warnings, amountPenalty: 0 };
    }

    // No indicator: an explicit sign in the cell is trustworthy; otherwise assume a
    // debit (most statement rows are spending) but flag it for review.
    if (/^[-(]/.test(raw) || value < 0) {
      return { signedAmount: (-Math.abs(value)) as Minor, amountWarnings: warnings, amountPenalty: 0 };
    }
    if (/(?:CR|credit)\b/i.test(raw)) {
      return { signedAmount: Math.abs(value) as Minor, amountWarnings: warnings, amountPenalty: 0 };
    }

    warnings.push(WARNINGS.directionUnknown);
    return { signedAmount: (-Math.abs(value)) as Minor, amountWarnings: warnings, amountPenalty: 0.25 };
  }

  warnings.push(WARNINGS.amountMissing);
  return { signedAmount: null, amountWarnings: warnings, amountPenalty: 0.6 };
}

/** Human-readable warning text for the review screen. */
export const WARNING_LABELS: Record<string, string> = {
  [WARNINGS.dateMissing]: 'No date found',
  [WARNINGS.dateAmbiguous]: 'Date could be read two ways',
  [WARNINGS.amountMissing]: 'No amount found',
  [WARNINGS.amountUncertain]: 'Amount is unclear',
  [WARNINGS.descriptionMissing]: 'No description',
  [WARNINGS.directionUnknown]: 'Assumed to be money out',
};

export function describeWarning(code: string): string {
  return WARNING_LABELS[code] ?? code;
}

export { isValidISODate };
