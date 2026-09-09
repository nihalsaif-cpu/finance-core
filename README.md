# finance-core

The domain layer of a personal spending tracker, extracted as a standalone package.

No React, no database client, no platform bindings, no I/O. Pure TypeScript and
**626 tests** that run in under a second. Drop it into a web app, a server, another
React Native app, or an Electron build — the maths does not change.

```bash
npm install finance-core
```

```ts
import { fromMajor, format, classifyKind, buildHealthScore } from 'finance-core';

const amount = fromMajor('1250.50');        // ₹1,250.50 as 125050 paise
format(amount, { currency: 'INR' });        // "₹1,250.50"
```

---

## Three invariants

Break any of these and the numbers stop reconciling. They are enforced by the types
where possible and by tests everywhere else.

### 1. Money is an integer in minor units

`Minor` is a branded integer of paise (or cents). Never a float.

```ts
fromMajor('0.1') + fromMajor('0.2') === fromMajor('0.3')   // true
0.1 + 0.2 === 0.3                                          // false
```

Build with `fromMajor('1250.50')` or `parseAmountInput(userText)`. Never
`Math.round(x * 100)` at a call site — the branding exists so the compiler stops you.

### 2. `TransactionKind` decides spending semantics — not the sign of the amount

```ts
SPEND_KINDS    // ['expense', 'cc_charge']              counted as spending
NEUTRAL_KINDS  // ['transfer', 'cc_payment', 'cash_deposit']   never counted
```

A credit-card purchase is spending. Paying the card bill is **not** — that money was
already counted when the purchase happened. Reading the sign instead of the kind
double-counts every card bill, which is a class of bug that hides for months because
both halves look individually correct.

```ts
classifyKind({ description: 'PAYMENT TO HDFC CREDIT CARD',
               signedAmount: fromMajor('-9000'),
               account: { id: 'b', type: 'bank' } }).kind   // 'cc_payment' (neutral)
```

### 3. Dates are civil dates, never `Date`

`ISODate` is a `'YYYY-MM-DD'` string. A cycle starting on the 1st starts on the 1st in
the user's timezone, not at a UTC instant that is the 31st in Kolkata. `Date` drags a
timezone into arithmetic that has no business with one.

---

## What is in here

| Area | Modules | What it does |
|---|---|---|
| **Foundations** | `money`, `date`, `types` | Exact money arithmetic, civil-date maths, the domain vocabulary |
| **Ledger** | `ledger`, `categories`, `merchants`, `creditcard` | What counts as spending; category tree; merchant normalisation; credit/refund/settlement classification |
| **Cycles** | `cycle`, `period` | Salary cycles (monthly, semimonthly, biweekly, weekly), month/year periods |
| **Analysis** | `analytics`, `velocity`, `insights`, `exhibits`, `breakdown`, `health`, `report`, `afford` | Cycle snapshots, budgets, spend pace, generated insights, chart data, category drill-down, a 0–100 health score, monthly report, affordability |
| **Commitments** | `recurring`, `settlement`, `schedule`, `reminderPlan`, `alerts` | Recurring detection, marking bills paid, dated forecasting, reminder scheduling, budget alerts |
| **Accounts** | `accounts` | Bank/card/cash accounts, card billing dates, utilisation, last-4 matching |
| **Ingest** | `dedupe`, `import/*` | Statement column detection, row parsing, screenshot/OCR amount extraction, duplicate detection |
| **Input** | `voice`, `widget` | Spoken-expense parsing, home-screen widget figures |

### File parsing is a separate entry point

```ts
import { decode } from 'finance-core/import';   // pulls papaparse + xlsx
```

This is the only part of the package with third-party dependencies. It is split out so
an app that never reads a spreadsheet does not ship a spreadsheet parser. Everything
that happens *after* decoding — column detection, row parsing, de-duplication — is pure
and lives in the main entry point.

---

## The database schema

`schema/` holds the five Postgres migrations the domain model was designed against:
tables, row-level security, and the category seed. They are Supabase-flavoured but are
ordinary Postgres.

You do not have to use them — the package never talks to a database. But if you do,
`tests/schema-sync.test.ts` verifies the TypeScript category tree and the SQL seed
cannot drift apart, which is a genuinely easy way to corrupt a ledger.

---

## Worked example

```ts
import {
  fromMajor, cycleContaining, buildCycleSnapshot, evaluateBudgets,
  buildHealthScore, forecastCycle,
} from 'finance-core';

const cycle    = cycleContaining('2026-09-15', { startDay: 1, frequency: 'monthly' });
const snapshot = buildCycleSnapshot({ transactions, cycle, expectedIncome: fromMajor('68500') });
const budgets  = evaluateBudgets({ transactions, budgets: myBudgets, cycle });

const health = buildHealthScore({
  savingsRate:       snapshot.savingsRate,
  fixedExpenseRatio: snapshot.fixedExpenseRatio,
  history,   // prior cycles
  budgets,
});

health.score       // 68
health.grade       // 'steady'
health.headline    // 'Steady, with room to improve. The main drag is how much is already committed.'
health.components  // each with its own score, weight and a plain-English detail line
```

`buildHealthScore` redistributes weight rather than scoring a missing component zero —
no budgets set is not the same as budgets blown — and reports its own confidence rather
than pretending one cycle of data is a verdict.

---

## Working on this package

```bash
npm run typecheck    # tsc, strict, noUncheckedIndexedAccess
npm test             # 626 tests
npm run build        # dist/ with .d.ts, plus ESM extension fixup
```

`src/` is pure. If a module in here ever needs a network call, a React hook or a
filesystem read, it belongs in the application layer instead — that boundary is the
only reason this package is portable and its tests run in a second.

`scripts/fix-esm-extensions.mjs` runs after `tsc` because TypeScript does not rewrite
module specifiers: bundlers resolve `./types` fine, Node's ESM resolver does not.
