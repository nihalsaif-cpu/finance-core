/**
 * Turning a spoken sentence into a draft transaction.
 *
 * "Spent four fifty on groceries at Sharma Kirana" has to become an amount, a merchant
 * and a category. Speech recognition gives words, not numbers — "450" often arrives as
 * "four fifty" or "four hundred and fifty", and a parser that only reads digits fails
 * on most of what people actually say.
 *
 * Nothing here commits anything. The output prefills the Add form and the user
 * confirms — the same rule the import pipeline follows, and for the same reason: a
 * misheard amount must never become a transaction on its own.
 */

import { fromMajor, type Minor } from './money';
import { addDays, type ISODate } from './date';
import type { TransactionKind } from './types';

export interface SpokenExpense {
  amount: Minor | null;
  merchant: string | null;
  /** A phrase to run through the existing category matcher. */
  note: string;
  date: ISODate;
  kind: TransactionKind;
  /** 0–1. Low means the form should open with the field focused, not saved. */
  confidence: number;
  /** What could not be worked out, in the user's terms. */
  missing: string[];
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

/** Indian scale words. `crore` included because rent deposits and cars get spoken. */
const SCALES: Record<string, number> = {
  hundred: 100, thousand: 1000, k: 1000, lakh: 100000, lakhs: 100000,
  lac: 100000, crore: 10000000, crores: 10000000,
};

const CREDIT_WORDS = /\b(?:got|received|receive|earned|credited|refund(?:ed)?|income|salary)\b/i;
const MERCHANT_LEAD = /\b(?:at|from|to|in)\s+([a-z0-9'&.\- ]{2,40})$/i;

const FILLER =
  /\b(?:spent|spend|paid|pay|add|added|expense|rupees?|rs\.?|inr|for|on|of|the|a|an|please|record|note|today|just|about|around)\b/gi;

/**
 * Parse a run of number words into a value.
 *
 * Handles the way people actually speak amounts: "four fifty" is 450 in Indian
 * English, not 4 then 50, so a bare tens word following a units word multiplies rather
 * than adds. "Four hundred and fifty" still means the same thing by the ordinary rule.
 */
export function parseSpokenNumber(text: string): number | null {
  const words = text
    .toLowerCase()
    .replace(/[,]/g, '')
    .split(/[\s-]+/)
    .filter((w) => w && w !== 'and');

  let total = 0;
  let current = 0;
  let seen = false;
  let lastWasUnit = false;

  for (const word of words) {
    const digits = /^\d+(?:\.\d+)?$/.test(word) ? Number(word) : null;

    if (digits !== null) {
      current = current === 0 ? digits : current + digits;
      seen = true;
      lastWasUnit = digits < 10;
      continue;
    }

    if (word in UNITS) {
      current += UNITS[word]!;
      seen = true;
      lastWasUnit = true;
      continue;
    }

    if (word in TENS) {
      // "four fifty" → 450. A tens word straight after a single digit is shorthand
      // for hundreds, which is how amounts are spoken across India.
      if (lastWasUnit && current > 0 && current < 10) {
        current = current * 100 + TENS[word]!;
      } else {
        current += TENS[word]!;
      }
      seen = true;
      lastWasUnit = false;
      continue;
    }

    if (word in SCALES) {
      const scale = SCALES[word]!;
      // "two thousand five hundred": the hundred multiplies only what precedes it.
      if (scale === 100) {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
      seen = true;
      lastWasUnit = false;
      continue;
    }

    lastWasUnit = false;
  }

  if (!seen) return null;
  const value = total + current;
  return value > 0 ? value : null;
}

/** "yesterday" and "day before yesterday" are the only ones worth guessing. */
function dateFrom(text: string, today: ISODate): ISODate {
  if (/\bday before yesterday\b/i.test(text)) return addDays(today, -2);
  if (/\byesterday\b/i.test(text)) return addDays(today, -1);
  return today;
}

/**
 * Parse a spoken sentence into a draft.
 *
 * Deliberately forgiving about order — "450 for groceries", "groceries 450" and "spent
 * 450 on groceries" all occur, and insisting on a grammar would make the feature feel
 * broken rather than the sentence feel wrong.
 */
export function parseSpokenExpense(transcript: string, today: ISODate): SpokenExpense {
  const text = String(transcript ?? '').trim();
  const missing: string[] = [];

  const kind: TransactionKind = CREDIT_WORDS.test(text) ? 'income' : 'expense';
  const date = dateFrom(text, today);

  /*
   * The amount is read from the digits or number words, whichever appears.
   *
   * A written figure wins where both exist: recognisers hand back "1200" for a clearly
   * spoken number and only fall back to words when they are unsure.
   */
  const digitMatch = text.match(/(?:₹|\brs\.?|\binr\b)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakh|lakhs|lac|crore|crores)?/i);
  let amount: Minor | null = null;

  if (digitMatch) {
    const base = Number(digitMatch[1]!.replace(/,/g, ''));
    const scale = digitMatch[2] ? SCALES[digitMatch[2].toLowerCase()] ?? 1 : 1;
    if (Number.isFinite(base) && base > 0) amount = fromMajor(String(base * scale));
  }

  if (amount === null) {
    const spoken = parseSpokenNumber(text);
    if (spoken !== null) amount = fromMajor(String(spoken));
  }

  if (amount === null) missing.push('amount');

  /*
   * The merchant is whatever follows "at" / "from" — and only at the END of the
   * sentence. "Paid at the shop for groceries" would otherwise take "the shop for
   * groceries" wholesale.
   */
  const merchantMatch = text.match(MERCHANT_LEAD);
  const merchant = merchantMatch ? tidy(merchantMatch[1]!) : null;

  /*
   * The note is the sentence with the mechanical words stripped: amounts, currency,
   * and the verbs that carry no meaning for categorising. What is left is what the
   * money was actually for, which is exactly what `suggestCategory` expects.
   */
  const note = tidy(
    text
      .replace(MERCHANT_LEAD, ' ')
      .replace(/(?:₹|\brs\.?|\binr\b)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:k|thousand|lakhs?|lac|crores?)?/gi, ' ')
      .replace(new RegExp(`\\b(?:${Object.keys({ ...UNITS, ...TENS, ...SCALES }).join('|')})\\b`, 'gi'), ' ')
      .replace(FILLER, ' '),
  );

  if (!note && !merchant) missing.push('what it was for');

  // Confidence drops for each thing left unanswered, so a half-heard sentence opens
  // the form for correction rather than looking ready to save.
  const confidence = Math.max(0.2, 1 - missing.length * 0.4);

  return { amount, merchant, note, date, kind, confidence, missing };
}

function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^[\s,.]+|[\s,.]+$/g, '').trim();
}
