/**
 * The import pipeline.
 *
 * Parsed rows → reviewable candidates. Runs classification, merchant normalisation,
 * categorisation and duplicate detection in one pass so the review screen receives
 * everything it needs to explain each row.
 *
 * The governing rule from §7: nothing uncertain is ever committed automatically.
 * This module decides what "uncertain" means and attaches the evidence; the user
 * decides what happens next.
 */

import { classifyKind } from '../creditcard';
import { detectDuplicates, type DuplicateCandidate, type DuplicateMatch } from '../dedupe';
import type { ISODate } from '../date';
import { REVIEW_THRESHOLD, merchantKey, normalizeMerchantName, suggestCategory, type UserMapping } from '../merchants';
import type { Minor } from '../money';
import type { Account, PaymentMethod, TransactionKind, UUID } from '../types';
import type { ParsedRow } from './statement';
import { WARNING_LABELS } from './statement';

/** Warning codes rendered as something a person can act on. */
const WARNING_TEXT: Record<string, string> = {
  ...WARNING_LABELS,
  date_ambiguous: 'Date could be read two ways — check it',
  direction_unknown: 'Assumed money out — check the direction',
  amount_uncertain: 'Amount was unclear — check it',
};

export interface CandidateTransaction {
  /** Stable within this import; the database assigns a real id on insert. */
  id: string;
  rowIndex: number;
  rawText: string;
  date: ISODate | null;
  /** Positive magnitude; direction lives in `kind`. */
  amount: Minor | null;
  description: string;
  merchantRaw: string | null;
  merchantKey: string | null;
  merchantName: string | null;
  kind: TransactionKind;
  categoryId: UUID | null;
  categorySlug: string | null;
  paymentMethod: PaymentMethod | null;
  accountId: UUID | null;
  referenceNo: string | null;
  /** The user's own words about this upload, carried through to the transaction. */
  notes: string | null;
  confidence: number;
  warnings: string[];
  /** Why this row was classified as it was, shown in the review screen. */
  explanation: string;
  needsReview: boolean;
  /**
   * Why the row needs a human, in plain language. Empty when it does not.
   *
   * Only reasons that CANNOT be re-derived from the row are stored — parse ambiguities
   * and duplicate evidence. Conditions like "no date" or "no category" are derived at
   * render time by `deriveReviewReasons`, so that fixing one clears the warning instead
   * of leaving a stale complaint next to a row the user has already corrected.
   */
  reviewReasons: string[];
  duplicateOf: DuplicateMatch | null;
}

export interface PipelineOptions {
  /** The account this file belongs to, when the user picked one. */
  account?: Pick<Account, 'id' | 'type'> | null;
  userMappings?: readonly UserMapping[];
  categoryIdForSlug?: (slug: string) => UUID | null;
  /** Already-saved transactions to check against for duplicates. */
  existing?: readonly DuplicateCandidate[];
  /** Import source, used to default the payment method. */
  defaultPaymentMethod?: PaymentMethod;
  /**
   * What the user said this upload was, captured at upload time. Applied to every row
   * in the batch — a screenshot is normally one payment, and for a multi-row statement
   * a single shared note is still better than none.
   */
  remark?: string;
  /**
   * A category the user chose at upload time.
   *
   * Outranks everything else — merchant rules, learned mappings and remark keywords
   * are all inference, and a person looking at their own receipt is not guessing. The
   * keyword vocabulary cannot know that "Sharma Kirana Store" sells groceries, so
   * without this the only route to a correct category was to fix every row afterwards.
   */
  categoryId?: UUID | null;
}

export interface PipelineResult {
  candidates: CandidateTransaction[];
  detected: number;
  needsReview: number;
  duplicates: number;
  /** Rows dropped because they had neither an amount nor a date. */
  unusable: number;
}

/**
 * Display names for kinds where the "merchant" is not a payee.
 *
 * Stripping rail noise from "NEFT DR-HDFC0001234-CREDIT CARD PAYMENT" leaves "Card",
 * which tells the user nothing. For these kinds the classification already knows what
 * the row is, so it names it.
 */
const KIND_DISPLAY_NAMES: Partial<Record<TransactionKind, string>> = {
  cc_payment: 'Credit card payment',
  transfer: 'Transfer between your accounts',
  cash_withdrawal: 'Cash withdrawal',
  cash_deposit: 'Cash deposit',
};

/** Which seeded income category each detected income type belongs in. */
const INCOME_CATEGORY_SLUGS: Record<string, string | null> = {
  salary: 'salary',
  interest: 'interest_income',
  other: 'other_income',
  // Deliberately uncategorised: an unidentified credit must not be quietly filed as
  // "Other Income", which would make it look decided.
  unknown: null,
};

function paymentMethodFor(kind: TransactionKind, options: PipelineOptions): PaymentMethod | null {
  if (options.account?.type === 'credit_card') return 'credit_card';
  if (kind === 'cash_withdrawal' || kind === 'cash_deposit') return 'cash';
  if (kind === 'transfer' || kind === 'cc_payment') return 'bank_transfer';
  return options.defaultPaymentMethod ?? null;
}

export function buildCandidates(rows: readonly ParsedRow[], options: PipelineOptions = {}): PipelineResult {
  const candidates: CandidateTransaction[] = [];
  let unusable = 0;

  rows.forEach((row, index) => {
    // A row with neither an amount nor a date carries no recoverable information.
    if (row.signedAmount === null && row.date === null) {
      unusable += 1;
      return;
    }

    const signed = row.signedAmount ?? (0 as Minor);
    const classification = classifyKind({
      description: row.description,
      signedAmount: signed,
      account: options.account ?? null,
    });

    const chosenCategory = options.categoryId ?? null;

    const suggestion = suggestCategory(row.description, {
      ...(options.userMappings ? { userMappings: options.userMappings } : {}),
      ...(options.categoryIdForSlug ? { categoryIdForSlug: options.categoryIdForSlug } : {}),
      ...(options.remark ? { remark: options.remark } : {}),
    });

    /**
     * Confidence is the WEAKEST of the three independent judgements — how cleanly the
     * row parsed, how sure we are what kind of transaction it is, and how sure we are
     * of the category.
     *
     * Multiplying them instead compounds pessimism: a perfectly ordinary bank debit
     * with a matched merchant scores ~0.66 and gets flagged, which trains the user to
     * ignore the flag. The weakest link is both more interpretable and better
     * calibrated.
     */
    const confidence = Math.min(row.confidence, classification.confidence, suggestion.confidence);

    const amount = row.signedAmount === null ? null : (Math.abs(row.signedAmount) as Minor);

    /*
     * Income gets an income CATEGORY, not whatever the merchant matcher guessed.
     *
     * Without this every credit landed in one undifferentiated bucket, so a year's
     * breakdown could not separate salary from bank interest — which was half of what
     * made "all credits are income" hard to spot in the first place.
     */
    const incomeCategorySlug =
      classification.kind === 'income' ? INCOME_CATEGORY_SLUGS[classification.incomeType ?? 'unknown'] : null;
    const incomeCategoryId =
      incomeCategorySlug && options.categoryIdForSlug
        ? options.categoryIdForSlug(incomeCategorySlug)
        : null;

    // Only durable reasons are recorded. Everything derivable from the row's own
    // fields is computed at render time so a fix clears it.
    const reviewReasons: string[] = [];
    /*
     * An unidentified CREDIT gets its own wording, not the generic kind warning.
     *
     * "Not sure what kind of transaction this is" gives the user nothing to decide
     * with. Money arriving is either earnings, their own money moving, or a refund —
     * naming those three is what makes the row answerable at a glance, and getting it
     * wrong silently inflates income and every figure derived from it.
     */
    if (classification.incomeType === 'unknown') {
      reviewReasons.push('Money came in — is this income, a transfer between your accounts, or a refund?');
    } else if (classification.confidence < 0.6) {
      reviewReasons.push('Not sure what kind of transaction this is');
    }
    if (!chosenCategory && suggestion.source === 'remark') {
      reviewReasons.push(`Categorised from your note — ${suggestion.reason.toLowerCase()}`);
    }
    for (const warning of row.warnings) reviewReasons.push(WARNING_TEXT[warning] ?? warning);

    candidates.push({
      id: `row-${row.rowIndex}-${index}`,
      rowIndex: row.rowIndex,
      rawText: row.rawText,
      date: row.date,
      amount,
      description: row.description,
      merchantRaw: row.description || null,
      merchantKey: row.description ? merchantKey(row.description) : null,
      merchantName:
        KIND_DISPLAY_NAMES[classification.kind] ??
        (row.description ? normalizeMerchantName(row.description) || null : null),
      kind: classification.kind,
      categoryId: chosenCategory ?? incomeCategoryId ?? suggestion.categoryId,
      categorySlug: chosenCategory ? null : (incomeCategorySlug ?? suggestion.categorySlug),
      paymentMethod: paymentMethodFor(classification.kind, options),
      accountId: options.account?.id ?? null,
      referenceNo: row.referenceNo,
      notes: options.remark?.trim() || null,
      confidence,
      warnings: row.warnings,
      explanation: classification.reason,
      needsReview:
        reviewReasons.length > 0 ||
        deriveReviewReasons({
          date: row.date,
          amount,
          categoryId: chosenCategory ?? suggestion.categoryId,
        }).length > 0,
      reviewReasons,
      duplicateOf: null,
    });
  });

  // --- Duplicate detection ---------------------------------------------------
  const dedupeInput: DuplicateCandidate[] = candidates
    .filter((c) => c.amount !== null && c.date !== null)
    .map((c) => ({
      id: c.id,
      date: c.date!,
      amount: c.amount!,
      merchantKey: c.merchantKey,
      description: c.description,
      referenceNo: c.referenceNo,
      kind: c.kind,
      accountId: c.accountId,
    }));

  const duplicates = detectDuplicates(dedupeInput, options.existing ?? []);
  const matchById = new Map<string, DuplicateMatch>();
  for (const match of [...duplicates.againstExisting, ...duplicates.withinImport]) {
    matchById.set(match.candidateId, match);
  }

  for (const candidate of candidates) {
    const match = matchById.get(candidate.id);
    if (match) {
      candidate.duplicateOf = match;
      // A flagged duplicate always needs a human decision — never auto-dropped.
      candidate.needsReview = true;
      candidate.reviewReasons = [
        ...candidate.reviewReasons,
        match.source === 'existing'
          ? `Already recorded — ${match.reasons.join(', ').toLowerCase()}`
          : `Listed twice in this file — ${match.reasons.join(', ').toLowerCase()}`,
      ];
    }
  }

  return {
    candidates,
    detected: candidates.length,
    needsReview: candidates.filter((c) => c.needsReview).length,
    duplicates: matchById.size,
    unusable,
  };
}

/**
 * Reasons derivable from a row's current values.
 *
 * Called both when building candidates and by the review screen after every edit, so
 * correcting a missing date or category removes the warning immediately rather than
 * leaving a stale one attached from staging time.
 */
export function deriveReviewReasons(row: {
  date: ISODate | null;
  amount: Minor | null;
  categoryId: UUID | null;
}): string[] {
  const reasons: string[] = [];
  if (row.date === null) reasons.push('No date — add one before importing');
  if (row.amount === null) reasons.push('No amount — add one before importing');
  if (row.categoryId === null) reasons.push('No category yet — pick one');
  return reasons;
}

/** Rows safe to accept without individual review. */
export function autoAcceptable(result: PipelineResult): CandidateTransaction[] {
  return result.candidates.filter((c) => !c.needsReview);
}

export { REVIEW_THRESHOLD };
