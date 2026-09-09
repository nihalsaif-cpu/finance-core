/**
 * finance-core — the domain layer of a personal spending tracker.
 *
 * Everything here is pure TypeScript: no React, no database client, no platform
 * bindings, no I/O. That is what makes it portable, and it is a constraint worth
 * defending — the moment a module in here reaches for a network call or a React hook,
 * it stops being testable in milliseconds and stops being reusable at all.
 *
 * ── Three invariants hold everywhere in this package ────────────────────────────
 *
 * 1. MONEY IS AN INTEGER IN MINOR UNITS.
 *    `Minor` is a branded integer of paise/cents. Never a float — `0.1 + 0.2` is not
 *    `0.3`, and a rounding error in a ledger is a bug you find months later in a total
 *    that will not reconcile. Build with `fromMajor('1250.50')`, never `1250.50 * 100`.
 *
 * 2. `TransactionKind` DECIDES SPENDING SEMANTICS — NOT THE SIGN OF THE AMOUNT.
 *    A refund, a transfer between your own accounts, and a credit-card settlement are
 *    all "money moving" but none of them is spending. Reading the sign instead of the
 *    kind double-counts a card payment: once as the purchase, once as clearing it.
 *
 * 3. DATES ARE CIVIL DATES (`ISODate`, 'YYYY-MM-DD') — NEVER `Date`.
 *    A cycle that starts on the 1st starts on the 1st in the user's timezone, not at
 *    some UTC instant that is the 31st in Kolkata. `Date` drags a timezone into
 *    arithmetic that has no business with one.
 *
 * File parsing (CSV/XLSX) is deliberately NOT exported here — it is the only part of
 * the package with third-party dependencies. Import it from `finance-core/import` so
 * an app that never reads a statement does not pay for a spreadsheet parser.
 */

// ── Foundations ───────────────────────────────────────────────────────────────
export * from './types';
export * from './money';
export * from './date';

// ── The ledger: what counts as spending, and what is merely movement ──────────
export * from './ledger';
export * from './categories';
export * from './merchants';
export * from './creditcard';

// ── Cycles and periods: the calendar a salary actually runs on ────────────────
export * from './cycle';
export * from './period';

// ── Analysis ──────────────────────────────────────────────────────────────────
export * from './analytics';
export * from './velocity';
export * from './insights';
export * from './exhibits';
export * from './breakdown';
export * from './health';
export * from './report';
export * from './afford';
export * from './goals';
export * from './loans';

// ── Commitments, forecasting and reminders ────────────────────────────────────
export * from './recurring';
export * from './settlement';
export * from './schedule';
export * from './reminderPlan';
export * from './alerts';

// ── Accounts ──────────────────────────────────────────────────────────────────
export * from './accounts';

// ── Ingest (parsing and de-duplication; no file I/O) ──────────────────────────
export * from './dedupe';
export * from './import/pipeline';
export * from './import/statement';
export * from './import/columns';
export * from './import/screenshot';

// ── Input surfaces ────────────────────────────────────────────────────────────
export * from './voice';
export * from './widget';

/**
 * `compare` exists in both `date` and `analytics` and means two unrelated things:
 * ordering two civil dates, versus measuring a figure against a baseline. Two star
 * exports offering the same name make it ambiguous and unusable, so it is pinned
 * explicitly here — the bare name is date ordering, matching every other language's
 * `compare(a, b) -> -1 | 0 | 1`, and the analytics one is renamed to say what it does.
 */
export { compare } from './date';
export { compare as compareAmounts } from './analytics';
