/**
 * File decoding — every supported format down to a rectangle of strings.
 *
 * Keeping decoding separate from interpretation means `parseStatementRows` never has
 * to know whether a row came from a CSV, a spreadsheet or a PDF text layer, and each
 * decoder can be tested on its own.
 */

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export type Grid = string[][];

/** CSV/TSV. Delimiter is sniffed, since Indian exports use both. */
export function parseDelimitedText(text: string): Grid {
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    // Statement headers repeat and are not reliable object keys, so we stay positional.
    header: false,
    // Papa's own delimiter detection handles , ; \t and |.
    delimiter: '',
  });
  return (result.data ?? []).map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []));
}

/**
 * XLSX/XLS. Reads the first sheet with any content.
 *
 * `raw: false` gives formatted strings rather than Excel serial numbers, which
 * matters for dates: a raw date cell arrives as 45883 and would be unparseable.
 */
export function parseSpreadsheet(data: ArrayBuffer | Uint8Array | string, encoding: 'base64' | 'binary' | 'buffer' = 'buffer'): Grid {
  const workbook =
    encoding === 'base64'
      ? XLSX.read(data as string, { type: 'base64', cellDates: false, raw: false })
      : encoding === 'binary'
        ? XLSX.read(data as string, { type: 'binary', cellDates: false, raw: false })
        : XLSX.read(data, { type: 'array', cellDates: false, raw: false });

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    }) as unknown as Grid;
    if (grid.some((row) => row.some((cell) => String(cell ?? '').trim()))) {
      return grid.map((row) => row.map((cell) => String(cell ?? '')));
    }
  }
  return [];
}

/**
 * Text extracted from a PDF or OCR, turned into a grid.
 *
 * PDF statements lose their table structure when the text layer is extracted: each
 * line arrives as one string with columns separated by runs of whitespace. Splitting
 * on two-or-more spaces recovers the columns in the large majority of bank PDFs,
 * because banks pad columns rather than using single spaces.
 */
export function parseFixedWidthText(text: string): Grid {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // Tab-separated wins when present; it is unambiguous.
      if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim());
      const parts = line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
      return parts.length > 1 ? parts : [line.trim()];
    });
}

export type DecodableKind = 'csv' | 'xlsx' | 'pdf_text' | 'ocr_text';

export function decode(kind: DecodableKind, payload: string | ArrayBuffer | Uint8Array): Grid {
  switch (kind) {
    case 'csv':
      return parseDelimitedText(String(payload));
    case 'xlsx':
      return typeof payload === 'string'
        ? parseSpreadsheet(payload, 'base64')
        : parseSpreadsheet(payload, 'buffer');
    case 'pdf_text':
    case 'ocr_text':
      return parseFixedWidthText(String(payload));
  }
}
