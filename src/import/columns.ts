/**
 * Column detection for tabular statements.
 *
 * No two Indian banks export the same CSV. HDFC uses "Narration" with separate
 * "Withdrawal Amt." and "Deposit Amt." columns; ICICI uses "Transaction Remarks" with
 * "Withdrawal Amount (INR)"; Axis uses "Particulars" with "Debit"/"Credit"; some
 * exports use a single signed "Amount" column plus a "Dr/Cr" indicator.
 *
 * So rather than a per-bank parser list that rots, we detect the *shape*: find the
 * header row, score each column against known synonyms, and fall back to inspecting
 * the data when headers are missing or unhelpful.
 */

import { parseLooseDate } from '../date';
import { parseAmountInput } from '../money';

export type ColumnRole =
  | 'date'
  | 'value_date'
  | 'description'
  | 'debit'
  | 'credit'
  | 'amount'
  | 'direction'
  | 'balance'
  | 'reference'
  | 'ignore';

interface RolePattern {
  role: ColumnRole;
  patterns: RegExp[];
  /** Higher wins when two roles both match a header. */
  weight: number;
}

const ROLE_PATTERNS: RolePattern[] = [
  { role: 'value_date', weight: 12, patterns: [/^value\s*date$/i, /value\s*dt/i] },
  {
    role: 'date',
    weight: 10,
    patterns: [/^date$/i, /txn\s*date/i, /transaction\s*date/i, /^tran\s*date/i, /posting\s*date/i, /^dt$/i, /booking\s*date/i],
  },
  {
    role: 'description',
    weight: 10,
    patterns: [
      /narration/i, /particular/i, /description/i, /remarks/i, /details/i,
      /transaction\s*(?:remarks|details|info)/i, /^merchant/i, /^payee/i, /^narrative/i,
    ],
  },
  {
    role: 'debit',
    weight: 12,
    patterns: [/withdrawal/i, /^debit/i, /debit\s*(?:amt|amount)/i, /^dr\s*(?:amt|amount)?$/i, /paid\s*out/i, /^spent$/i],
  },
  {
    role: 'credit',
    weight: 12,
    patterns: [/deposit/i, /^credit/i, /credit\s*(?:amt|amount)/i, /^cr\s*(?:amt|amount)?$/i, /paid\s*in/i, /^received$/i],
  },
  { role: 'amount', weight: 8, patterns: [/^amount/i, /^amt/i, /transaction\s*amount/i, /^value$/i] },
  { role: 'direction', weight: 10, patterns: [/^(?:dr|cr)\s*\/?\s*(?:cr|dr)$/i, /^type$/i, /^indicator$/i, /debit\s*\/\s*credit/i, /txn\s*type/i] },
  { role: 'balance', weight: 12, patterns: [/balance/i, /^bal$/i, /closing\s*bal/i, /running\s*total/i] },
  {
    role: 'reference',
    weight: 10,
    patterns: [/^ref/i, /reference/i, /^utr$/i, /cheque/i, /^chq/i, /transaction\s*id/i, /^rrn$/i],
  },
];

export type ColumnMap = Partial<Record<ColumnRole, number>>;

function scoreHeader(header: string): { role: ColumnRole; weight: number } | null {
  const cleaned = header.trim().replace(/[.\s]+$/g, '');
  if (!cleaned) return null;
  let best: { role: ColumnRole; weight: number } | null = null;
  for (const entry of ROLE_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (!pattern.test(cleaned)) continue;
      if (!best || entry.weight > best.weight) best = { role: entry.role, weight: entry.weight };
    }
  }
  return best;
}

/** How header-like a row looks: mostly non-empty text, few parseable amounts. */
function headerScore(cells: readonly string[]): number {
  let matched = 0;
  let numeric = 0;
  for (const cell of cells) {
    if (!cell?.trim()) continue;
    if (scoreHeader(cell)) matched += 1;
    if (parseAmountInput(cell) !== null) numeric += 1;
  }
  return matched * 2 - numeric;
}

export interface DetectionResult {
  headerRowIndex: number;
  columns: ColumnMap;
  /** 0–1. Low confidence routes the whole import to manual column mapping. */
  confidence: number;
  warnings: string[];
}

/**
 * Find the header row and map columns.
 * Statements routinely carry several preamble rows (account holder, address, period),
 * so we scan the first 25 rows rather than assuming row 0.
 */
export function detectColumns(rows: readonly (readonly string[])[]): DetectionResult {
  const warnings: string[] = [];
  let headerRowIndex = -1;
  let bestScore = 0;

  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    const score = headerScore(rows[i] ?? []);
    if (score > bestScore) {
      bestScore = score;
      headerRowIndex = i;
    }
  }

  const columns: ColumnMap = {};

  if (headerRowIndex >= 0) {
    const header = rows[headerRowIndex] ?? [];
    const claimed = new Map<ColumnRole, { index: number; weight: number }>();
    header.forEach((cell, index) => {
      const match = scoreHeader(cell ?? '');
      if (!match) return;
      const existing = claimed.get(match.role);
      if (!existing || match.weight > existing.weight) {
        claimed.set(match.role, { index, weight: match.weight });
      }
    });
    for (const [role, value] of claimed) columns[role] = value.index;
  }

  // Fall back to inferring from the data when headers were absent or unhelpful.
  if (columns.date === undefined || (columns.debit === undefined && columns.credit === undefined && columns.amount === undefined)) {
    const inferred = inferFromData(rows, headerRowIndex);
    if (columns.date === undefined && inferred.date !== undefined) {
      columns.date = inferred.date;
      warnings.push('Date column was inferred from the data rather than a header.');
    }
    if (columns.amount === undefined && columns.debit === undefined && columns.credit === undefined && inferred.amount !== undefined) {
      columns.amount = inferred.amount;
      warnings.push('Amount column was inferred from the data rather than a header.');
    }
    if (columns.description === undefined && inferred.description !== undefined) {
      columns.description = inferred.description;
    }
    if (headerRowIndex < 0) headerRowIndex = -1;
  }

  // A balance column mistaken for an amount would make every row wrong, so when a
  // single amount column sits beside a balance column, prefer the labelled one.
  if (columns.amount !== undefined && columns.amount === columns.balance) {
    delete columns.amount;
    warnings.push('Could not tell the amount column apart from the balance column.');
  }

  const hasDate = columns.date !== undefined;
  const hasAmount = columns.debit !== undefined || columns.credit !== undefined || columns.amount !== undefined;
  const hasDescription = columns.description !== undefined;

  let confidence = 0;
  if (hasDate) confidence += 0.4;
  if (hasAmount) confidence += 0.4;
  if (hasDescription) confidence += 0.2;
  if (headerRowIndex < 0) confidence *= 0.7;

  if (!hasDate) warnings.push('No date column found.');
  if (!hasAmount) warnings.push('No amount column found.');
  if (!hasDescription) warnings.push('No description column found — merchants cannot be identified.');

  return { headerRowIndex, columns, confidence, warnings };
}

/** Column inference by looking at what the cells actually contain. */
function inferFromData(rows: readonly (readonly string[])[], headerRowIndex: number): ColumnMap {
  const start = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
  const sample = rows.slice(start, start + 40).filter((row) => row.some((cell) => cell?.trim()));
  if (sample.length === 0) return {};

  const width = Math.max(...sample.map((row) => row.length));
  const dateHits = new Array<number>(width).fill(0);
  const amountHits = new Array<number>(width).fill(0);
  const textLength = new Array<number>(width).fill(0);

  for (const row of sample) {
    for (let c = 0; c < width; c++) {
      const cell = (row[c] ?? '').trim();
      if (!cell) continue;
      if (parseLooseDate(cell)) dateHits[c] = (dateHits[c] ?? 0) + 1;
      if (parseAmountInput(cell) !== null) amountHits[c] = (amountHits[c] ?? 0) + 1;
      else textLength[c] = (textLength[c] ?? 0) + cell.length;
    }
  }

  const argmax = (list: number[]) => {
    let bestIndex = -1;
    let best = 0;
    list.forEach((value, index) => {
      if (value > best) {
        best = value;
        bestIndex = index;
      }
    });
    return bestIndex >= 0 ? bestIndex : undefined;
  };

  const result: ColumnMap = {};
  const dateColumn = argmax(dateHits);
  if (dateColumn !== undefined) result.date = dateColumn;
  const descriptionColumn = argmax(textLength);
  if (descriptionColumn !== undefined) result.description = descriptionColumn;
  const amountColumn = argmax(amountHits);
  if (amountColumn !== undefined) result.amount = amountColumn;
  return result;
}
