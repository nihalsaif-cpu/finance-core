/**
 * Duplicate detection.
 *
 * Duplicates arise constantly: the same statement imported twice, a UPI screenshot
 * saved and then the bank statement imported, or overlapping date ranges.
 *
 * The hard part is that genuine repeats look identical. Two ₹120 coffees at the same
 * shop on the same day are not a duplicate, and neither are two ₹500 fuel top-ups.
 * So this module never asserts certainty from amount + date + merchant alone — only a
 * shared bank reference number is treated as conclusive. Everything else is scored and
 * surfaced for the user to decide, and nothing is ever deleted automatically.
 */

import { daysBetween, type ISODate } from './date';
import type { Minor } from './money';
import type { TransactionKind, UUID } from './types';

export interface DuplicateCandidate {
  id: UUID;
  date: ISODate;
  amount: Minor;
  merchantKey: string | null;
  description: string;
  referenceNo: string | null;
  kind: TransactionKind;
  accountId?: UUID | null;
}

export type DuplicateConfidence = 'certain' | 'likely' | 'possible';

export interface DuplicateMatch {
  candidateId: UUID;
  matchId: UUID;
  /**
   * Whether `matchId` points at a transaction already saved, or at another row in
   * the same upload.
   *
   * The two need different words in front of the user — "you already recorded this
   * on 12 Aug" is a different claim from "this file lists it twice" — and only the
   * first has a real transaction id worth storing against the staged row.
   */
  source: 'existing' | 'import';
  score: number;
  confidence: DuplicateConfidence;
  /** Plain-language evidence shown next to the flagged row. */
  reasons: string[];
  daysApart: number;
}

export interface DedupeOptions {
  /** How far apart two rows can be and still be considered the same event. */
  windowDays: number;
  /** Minimum score to surface at all. */
  minScore: number;
  likelyThreshold: number;
}

export const DEFAULT_DEDUPE_OPTIONS: DedupeOptions = {
  windowDays: 3,
  minScore: 0.6,
  likelyThreshold: 0.85,
};

/** Normalised reference number — banks pad and prefix these inconsistently. */
function normalizeReference(ref: string | null): string | null {
  if (!ref) return null;
  const cleaned = ref.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  // Very short references are not unique enough to prove identity.
  return cleaned.length >= 6 ? cleaned : null;
}

function descriptionTokens(description: string): Set<string> {
  return new Set(
    description
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity of description tokens, 0–1. */
export function descriptionSimilarity(a: string, b: string): number {
  const ta = descriptionTokens(a);
  const tb = descriptionTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score how likely two rows are the same real-world transaction.
 * Returns null when they cannot be (different amounts, or too far apart in time).
 */
export function scorePair(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  options: DedupeOptions = DEFAULT_DEDUPE_OPTIONS,
): { score: number; reasons: string[]; daysApart: number } | null {
  if (a.id === b.id) return null;

  // A refund and the purchase it reverses share amount, merchant and date. They are
  // opposites, not duplicates.
  if (a.kind !== b.kind) return null;

  const daysApart = Math.abs(daysBetween(a.date, b.date));
  const reasons: string[] = [];

  const refA = normalizeReference(a.referenceNo);
  const refB = normalizeReference(b.referenceNo);
  if (refA && refB) {
    if (refA === refB) {
      return { score: 1, reasons: ['Same bank reference number'], daysApart };
    }
    // Two rows with different reference numbers are, by definition, different events.
    return null;
  }

  if (a.amount !== b.amount) return null;
  if (daysApart > options.windowDays) return null;

  let score = 0.4;
  reasons.push('Same amount');

  if (daysApart === 0) {
    score += 0.3;
    reasons.push('Same date');
  } else if (daysApart === 1) {
    score += 0.22;
    reasons.push('One day apart');
  } else {
    score += 0.12;
    reasons.push(`${daysApart} days apart`);
  }

  if (a.merchantKey && b.merchantKey && a.merchantKey === b.merchantKey) {
    score += 0.28;
    reasons.push('Same merchant');
  } else {
    const similarity = descriptionSimilarity(a.description, b.description);
    if (similarity >= 0.6) {
      score += 0.2;
      reasons.push('Very similar description');
    } else if (similarity >= 0.35) {
      score += 0.1;
      reasons.push('Similar description');
    } else if (a.merchantKey && b.merchantKey) {
      // Same amount and date but demonstrably different merchants — not a duplicate.
      return null;
    }
  }

  // The same amount on the same day from two different accounts is more likely to be
  // one event captured twice (bank statement + card statement) than two purchases.
  if (a.accountId && b.accountId && a.accountId !== b.accountId) {
    score += 0.05;
    reasons.push('Recorded against two different accounts');
  }

  return { score: Math.min(score, 0.99), reasons, daysApart };
}

function confidenceOf(score: number, options: DedupeOptions): DuplicateConfidence {
  if (score >= 1) return 'certain';
  return score >= options.likelyThreshold ? 'likely' : 'possible';
}

/**
 * Match freshly imported rows against already-saved transactions.
 * Each candidate is matched at most once, to its best-scoring partner.
 */
export function findDuplicatesAgainstExisting(
  candidates: readonly DuplicateCandidate[],
  existing: readonly DuplicateCandidate[],
  options: DedupeOptions = DEFAULT_DEDUPE_OPTIONS,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const usedExisting = new Set<UUID>();

  for (const candidate of candidates) {
    let best: DuplicateMatch | null = null;
    for (const other of existing) {
      if (usedExisting.has(other.id)) continue;
      const scored = scorePair(candidate, other, options);
      if (!scored || scored.score < options.minScore) continue;
      if (!best || scored.score > best.score) {
        best = {
          candidateId: candidate.id,
          matchId: other.id,
          source: 'existing',
          score: scored.score,
          confidence: confidenceOf(scored.score, options),
          reasons: scored.reasons,
          daysApart: scored.daysApart,
        };
      }
    }
    if (best) {
      usedExisting.add(best.matchId);
      matches.push(best);
    }
  }

  return matches;
}

/**
 * Find duplicates *within* one import — the same row appearing twice in a file, or a
 * statement that overlaps itself. The earlier row is treated as the original.
 */
export function findDuplicatesWithin(
  candidates: readonly DuplicateCandidate[],
  options: DedupeOptions = DEFAULT_DEDUPE_OPTIONS,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const alreadyFlagged = new Set<UUID>();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    if (alreadyFlagged.has(candidate.id)) continue;

    for (let j = 0; j < i; j++) {
      const other = candidates[j]!;
      if (alreadyFlagged.has(other.id)) continue;
      const scored = scorePair(candidate, other, options);
      if (!scored || scored.score < options.minScore) continue;

      matches.push({
        candidateId: candidate.id,
        matchId: other.id,
        source: 'import',
        score: scored.score,
        confidence: confidenceOf(scored.score, options),
        reasons: scored.reasons,
        daysApart: scored.daysApart,
      });
      alreadyFlagged.add(candidate.id);
      break;
    }
  }

  return matches;
}

/** Both passes at once — what the import pipeline actually calls. */
export function detectDuplicates(
  candidates: readonly DuplicateCandidate[],
  existing: readonly DuplicateCandidate[],
  options: DedupeOptions = DEFAULT_DEDUPE_OPTIONS,
): { againstExisting: DuplicateMatch[]; withinImport: DuplicateMatch[]; flaggedIds: Set<UUID> } {
  const againstExisting = findDuplicatesAgainstExisting(candidates, existing, options);
  const flaggedByExisting = new Set(againstExisting.map((m) => m.candidateId));
  const remaining = candidates.filter((c) => !flaggedByExisting.has(c.id));
  const withinImport = findDuplicatesWithin(remaining, options);

  return {
    againstExisting,
    withinImport,
    flaggedIds: new Set([...flaggedByExisting, ...withinImport.map((m) => m.candidateId)]),
  };
}

export function describeMatch(match: DuplicateMatch): string {
  const prefix =
    match.confidence === 'certain'
      ? 'Duplicate'
      : match.confidence === 'likely'
        ? 'Likely duplicate'
        : 'Possible duplicate';
  return `${prefix} — ${match.reasons.join(', ').toLowerCase()}`;
}
