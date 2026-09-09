/**
 * Domain types.
 *
 * Two conventions hold everywhere and are worth stating up front:
 *
 * 1. `amount` is always a POSITIVE magnitude. Direction and financial meaning come
 *    from `kind`, never from a sign. Sign-based ledgers make "is this spending?" a
 *    guess; an explicit kind makes it a lookup.
 *
 * 2. `kind` — not the amount, not the category — decides whether something counts as
 *    spending. This is what stops a credit-card bill payment from being counted on
 *    top of the card purchases it settles, and stops a self-transfer from looking
 *    like income.
 */

import type { ISODate } from './date';
import type { Minor } from './money';

export type UUID = string;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type TransactionKind =
  /** Money spent on goods/services from a bank, cash or debit source. */
  | 'expense'
  /** A purchase made on a credit card. Real spending; settled later by `cc_payment`. */
  | 'cc_charge'
  /** Salary, interest, gifts, cashback. Increases available money. */
  | 'income'
  /** Money returned for a previous purchase. Reduces spending. */
  | 'refund'
  /** Movement between the user's own accounts. Neither income nor spending. */
  | 'transfer'
  /** Bank → credit card. Settles an existing liability; NOT new spending. */
  | 'cc_payment'
  /** Bank → cash in hand. Whether this counts as spending is a user setting. */
  | 'cash_withdrawal'
  /** Cash in hand → bank. */
  | 'cash_deposit'
  /** Money moved into investments/savings. An outflow, but not consumption. */
  | 'investment';

export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'expense',
  'cc_charge',
  'income',
  'refund',
  'transfer',
  'cc_payment',
  'cash_withdrawal',
  'cash_deposit',
  'investment',
];

export type TransactionStatus =
  | 'posted'
  /** Authorised but not settled — visible, but excluded from spend totals. */
  | 'pending'
  /** Declined/failed. Never counted. */
  | 'failed'
  /** Fully reversed. Never counted. */
  | 'reversed';

export type PaymentMethod =
  | 'cash'
  | 'upi'
  | 'debit_card'
  | 'credit_card'
  | 'bank_transfer'
  | 'netbanking'
  | 'wallet'
  | 'other';

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'upi',
  'credit_card',
  'debit_card',
  'cash',
  'bank_transfer',
  'netbanking',
  'wallet',
  'other',
];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  debit_card: 'Debit Card',
  credit_card: 'Credit Card',
  bank_transfer: 'Bank Transfer',
  netbanking: 'Net Banking',
  wallet: 'Wallet',
  other: 'Other',
};

export type TransactionSource =
  | 'manual'
  | 'import_image'
  | 'import_pdf'
  | 'import_csv'
  | 'import_xlsx'
  | 'recurring';

export interface Transaction {
  id: UUID;
  userId: UUID;
  /** The date the money moved, as a calendar date. */
  date: ISODate;
  /** Bank's value date when it differs from the transaction date. */
  valueDate: ISODate | null;
  /** Positive magnitude. Direction comes from `kind`. */
  amount: Minor;
  currency: string;
  kind: TransactionKind;
  status: TransactionStatus;
  description: string;
  /** Merchant exactly as it appeared in the source, kept for auditability. */
  merchantRaw: string | null;
  /** Canonical merchant key used for grouping and rules ("swiggy"). */
  merchantKey: string | null;
  /** Display name ("Swiggy"). */
  merchantName: string | null;
  categoryId: UUID | null;
  paymentMethod: PaymentMethod;
  accountId: UUID | null;
  /** Destination account for transfers, cc payments, withdrawals and deposits. */
  counterpartyAccountId: UUID | null;
  /** null means "inherit the category's classification". */
  isEssential: boolean | null;
  isRecurring: boolean;
  recurringExpenseId: UUID | null;
  notes: string | null;
  source: TransactionSource;
  referenceNo: string | null;
  importId: UUID | null;
  /** Refund → the original purchase; cc_payment → the statement it settles. */
  linkedTransactionId: UUID | null;
  /** Manual escape hatch: keep the record, drop it from every calculation. */
  excludeFromAnalytics: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The subset of a transaction the analytics layer needs. Keeps calculations testable. */
export interface AnalyzableTransaction {
  id: UUID;
  date: ISODate;
  amount: Minor;
  kind: TransactionKind;
  status: TransactionStatus;
  categoryId: UUID | null;
  merchantKey: string | null;
  merchantName: string | null;
  description: string;
  paymentMethod: PaymentMethod;
  accountId: UUID | null;
  isEssential: boolean | null;
  isRecurring: boolean;
  /** The commitment this payment settles, when it was recorded against one. */
  recurringExpenseId: UUID | null;
  excludeFromAnalytics: boolean;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryClassification = 'essential' | 'discretionary' | 'mixed';

export type CategoryKind = 'expense' | 'income' | 'transfer' | 'savings';

export interface Category {
  id: UUID;
  userId: UUID | null;
  parentId: UUID | null;
  name: string;
  slug: string;
  kind: CategoryKind;
  classification: CategoryClassification;
  icon: string;
  color: string;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
}

/** A category plus its resolved parent, as the UI consumes it. */
export interface CategoryNode extends Category {
  children: CategoryNode[];
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountType = 'bank' | 'credit_card' | 'cash' | 'wallet' | 'investment';

export interface Account {
  id: UUID;
  userId: UUID;
  name: string;
  type: AccountType;
  /** Last 4 digits, used to match imported rows to an account. */
  last4: string | null;
  institution: string | null;
  currency: string;
  /** Credit cards only: statement generation day and payment due day. */
  statementDay: number | null;
  dueDay: number | null;
  creditLimit: Minor | null;
  openingBalance: Minor;
  isActive: boolean;
  color: string;
}

// ---------------------------------------------------------------------------
// Income & profile
// ---------------------------------------------------------------------------

export type IncomeKind = 'salary' | 'bonus' | 'freelance' | 'interest' | 'refund' | 'gift' | 'other';

export interface IncomeRecord {
  id: UUID;
  userId: UUID;
  date: ISODate;
  amount: Minor;
  kind: IncomeKind;
  source: string;
  accountId: UUID | null;
  notes: string | null;
  isRecurring: boolean;
}

export interface UserProfile {
  id: UUID;
  displayName: string | null;
  currency: string;
  timeZone: string;
  /** Day of month salary lands, 1–31. */
  cycleStartDay: number;
  cycleFrequency: 'monthly' | 'semimonthly' | 'biweekly' | 'weekly';
  cycleAnchorDate: ISODate | null;
  /** What the user expects to earn per cycle. Used before actual income is recorded. */
  expectedMonthlyIncome: Minor;
  /** Target amount to keep unspent each cycle. */
  savingsTarget: Minor;
  emergencyFundTarget: Minor;
  /** ATM withdrawals count as spending unless the user tracks cash separately. */
  cashWithdrawalCountsAsSpend: boolean;
  onboardedAt: string | null;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export type BudgetPeriod = 'cycle' | 'monthly';

export interface Budget {
  id: UUID;
  userId: UUID;
  /** null = the overall spending budget for the cycle. */
  categoryId: UUID | null;
  amount: Minor;
  period: BudgetPeriod;
  /** Budgets can be revised; the effective window keeps history honest. */
  effectiveFrom: ISODate;
  effectiveTo: ISODate | null;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Recurring expenses
// ---------------------------------------------------------------------------

export type RecurrenceInterval = 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';

export interface RecurringExpense {
  id: UUID;
  userId: UUID;
  name: string;
  merchantKey: string | null;
  categoryId: UUID | null;
  amount: Minor;
  interval: RecurrenceInterval;
  /** Day of month (monthly+) or day of week (weekly). */
  dayOfPeriod: number | null;
  nextDueDate: ISODate | null;
  lastSeenDate: ISODate | null;
  accountId: UUID | null;
  paymentMethod: PaymentMethod | null;
  isEssential: boolean;
  isActive: boolean;
  /** true when the app inferred it rather than the user declaring it. */
  autoDetected: boolean;
  /** 0–1 confidence from the detector. */
  confidence: number;
  /** Whether a notification is scheduled ahead of each due date. */
  reminderEnabled: boolean;
  /** Days of warning before the due date. 0 means the morning it is due. */
  remindDaysBefore: number;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export type GoalKind = 'emergency_fund' | 'vacation' | 'purchase' | 'vehicle' | 'investment' | 'other';

export interface FinancialGoal {
  id: UUID;
  userId: UUID;
  name: string;
  kind: GoalKind;
  targetAmount: Minor;
  currentAmount: Minor;
  targetDate: ISODate | null;
  monthlyContribution: Minor;
  isActive: boolean;
  color: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Merchant rules
// ---------------------------------------------------------------------------

export type MappingOrigin = 'system' | 'user' | 'learned';

export interface MerchantMapping {
  id: UUID;
  userId: UUID | null;
  /** Canonical merchant key this rule matches. */
  merchantKey: string;
  displayName: string;
  categoryId: UUID;
  origin: MappingOrigin;
  /** Number of times the user has confirmed this mapping. Breaks ties. */
  confirmations: number;
  isEssential: boolean | null;
  defaultPaymentMethod: PaymentMethod | null;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export type ImportKind = 'image' | 'pdf' | 'csv' | 'xlsx';

export type ImportStatus = 'uploading' | 'extracting' | 'review' | 'committed' | 'failed' | 'rolled_back';

export interface ImportBatch {
  id: UUID;
  userId: UUID;
  kind: ImportKind;
  fileName: string;
  /** Private Storage object path. Never a public URL. */
  storagePath: string | null;
  status: ImportStatus;
  detectedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  needsReviewCount: number;
  duplicateCount: number;
  /** Parser/statement profile that handled the file, for debugging. */
  parserId: string | null;
  errorMessage: string | null;
  /** What the user said this upload was. */
  note: string | null;
  accountId: UUID | null;
  createdAt: string;
  committedAt: string | null;
}

export type StagedStatus = 'pending' | 'accepted' | 'rejected' | 'duplicate' | 'merged';

/** A candidate transaction awaiting review. Never touches analytics until committed. */
export interface StagedTransaction {
  id: UUID;
  importId: UUID;
  userId: UUID;
  rowIndex: number;
  /** Verbatim source text/row, kept so a mis-parse can be diagnosed. */
  rawText: string | null;
  date: ISODate | null;
  amount: Minor | null;
  description: string;
  merchantRaw: string | null;
  merchantKey: string | null;
  merchantName: string | null;
  kind: TransactionKind;
  categoryId: UUID | null;
  paymentMethod: PaymentMethod | null;
  accountId: UUID | null;
  referenceNo: string | null;
  notes: string | null;
  /** 0–1. Below `REVIEW_THRESHOLD` the row is flagged for the user. */
  confidence: number;
  /** Field-level problems: 'date_ambiguous', 'amount_uncertain', … */
  warnings: string[];
  status: StagedStatus;
  duplicateOfTransactionId: UUID | null;
  duplicateOfStagedId: UUID | null;
  committedTransactionId: UUID | null;
}

// ---------------------------------------------------------------------------
// Insights & notifications
// ---------------------------------------------------------------------------

export type InsightSeverity = 'positive' | 'neutral' | 'warning' | 'critical';

export type InsightKind =
  | 'pace'
  | 'category_overspend'
  | 'budget_risk'
  | 'category_trend'
  | 'discretionary_trend'
  | 'subscription_load'
  | 'subscription_growth'
  | 'large_transaction'
  | 'frequency_spike'
  | 'savings_risk'
  | 'goal_progress'
  | 'positive_trend'
  | 'fixed_burden';

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  /** The evidence, in plain language, with the actual numbers in it. */
  detail: string;
  /** What to do about it. Omitted when there is no honest action to suggest. */
  action?: string;
  /** Sort weight, higher first. Derived from severity and magnitude. */
  priority: number;
  categoryId?: UUID;
  /** Deep link target, e.g. { screen: 'transactions', categoryId } */
  focus?: { categoryId?: UUID; merchantKey?: string };
}

export interface NotificationPreferences {
  userId: UUID;
  enabled: boolean;
  budgetWarning: boolean;
  budgetExceeded: boolean;
  paceWarning: boolean;
  largeTransaction: boolean;
  largeTransactionThreshold: Minor;
  unusualTransaction: boolean;
  savingsRisk: boolean;
  recurringDetected: boolean;
  salaryReceived: boolean;
  cycleSummary: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  /** On-device end-of-day reminder to record the day's spending. */
  dailyReminder: boolean;
  /** Wall-clock time in the user's own timezone, not a stored instant. */
  dailyReminderHour: number;
  dailyReminderMinute: number;
}
