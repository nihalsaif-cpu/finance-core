import { fromMajor, type Minor } from '../../src/money';
import type { AnalyzableTransaction, PaymentMethod, TransactionKind, TransactionStatus } from '../../src/types';

let counter = 0;

export interface TxnOverrides {
  id?: string;
  date?: string;
  amount?: Minor | string;
  kind?: TransactionKind;
  status?: TransactionStatus;
  categoryId?: string | null;
  merchantKey?: string | null;
  merchantName?: string | null;
  description?: string;
  paymentMethod?: PaymentMethod;
  accountId?: string | null;
  isEssential?: boolean | null;
  isRecurring?: boolean;
  recurringExpenseId?: string | null;
  excludeFromAnalytics?: boolean;
}

/** Build an AnalyzableTransaction with sensible defaults. `amount` accepts "1234.50". */
export function txn(overrides: TxnOverrides = {}): AnalyzableTransaction {
  counter += 1;
  const rawAmount = overrides.amount ?? '100';
  return {
    id: overrides.id ?? `t${counter}`,
    date: overrides.date ?? '2026-08-14',
    amount: typeof rawAmount === 'string' ? fromMajor(rawAmount) : rawAmount,
    kind: overrides.kind ?? 'expense',
    status: overrides.status ?? 'posted',
    categoryId: overrides.categoryId ?? null,
    merchantKey: overrides.merchantKey ?? null,
    merchantName: overrides.merchantName ?? null,
    description: overrides.description ?? 'Test transaction',
    paymentMethod: overrides.paymentMethod ?? 'upi',
    recurringExpenseId: overrides.recurringExpenseId ?? null,
    accountId: overrides.accountId ?? 'acct-bank',
    isEssential: overrides.isEssential ?? null,
    isRecurring: overrides.isRecurring ?? false,
    excludeFromAnalytics: overrides.excludeFromAnalytics ?? false,
  };
}

export function txns(list: TxnOverrides[]): AnalyzableTransaction[] {
  return list.map(txn);
}

export const rs = (v: string | number) => fromMajor(String(v));
