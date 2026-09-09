import { describe, it, expect } from 'vitest';
import * as L from '../src/ledger';
import { fromMajor } from '../src/money';
import { txn, txns, rs } from './helpers/factory';

describe('effectOf', () => {
  it('counts ordinary expenses and card charges as spending', () => {
    expect(L.effectOf(txn({ kind: 'expense', amount: '847' })).spend).toBe(rs(847));
    expect(L.effectOf(txn({ kind: 'cc_charge', amount: '2499' })).spend).toBe(rs(2499));
  });

  it('treats a refund as negative spending, not as income', () => {
    const e = L.effectOf(txn({ kind: 'refund', amount: '2000' }));
    expect(e.spend).toBe(rs(-2000));
    expect(e.income).toBe(0);
  });

  it('gives credit card bill payments no spend effect', () => {
    const e = L.effectOf(txn({ kind: 'cc_payment', amount: '25000' }));
    expect(e.spend).toBe(0);
    expect(e.income).toBe(0);
    expect(e.reason).toBe('credit_card_settlement');
    expect(L.exclusionLabel(e)).toBe('Credit card bill payment');
  });

  it('gives self-transfers no effect in either direction', () => {
    const e = L.effectOf(txn({ kind: 'transfer', amount: '50000' }));
    expect(e.spend).toBe(0);
    expect(e.income).toBe(0);
    expect(e.reason).toBe('transfer_between_own_accounts');
  });

  it('separates investments from consumption', () => {
    const e = L.effectOf(txn({ kind: 'investment', amount: '10000' }));
    expect(e.spend).toBe(0);
    expect(e.investment).toBe(rs(10000));
  });

  it('honours the cash-withdrawal setting', () => {
    const t = txn({ kind: 'cash_withdrawal', amount: '5000' });
    expect(L.effectOf(t, { cashWithdrawalCountsAsSpend: true, includePending: false }).spend).toBe(rs(5000));
    const off = L.effectOf(t, { cashWithdrawalCountsAsSpend: false, includePending: false });
    expect(off.spend).toBe(0);
    expect(off.reason).toBe('cash_tracked_separately');
  });

  it('never counts failed or reversed transactions', () => {
    for (const status of ['failed', 'reversed'] as const) {
      const e = L.effectOf(txn({ kind: 'expense', amount: '999', status }));
      expect(e.spend, status).toBe(0);
      expect(e.reason).toBe('not_posted');
    }
  });

  it('excludes pending transactions by default and includes them on request', () => {
    const t = txn({ kind: 'expense', amount: '500', status: 'pending' });
    expect(L.effectOf(t).spend).toBe(0);
    expect(L.effectOf(t, { cashWithdrawalCountsAsSpend: true, includePending: true }).spend).toBe(rs(500));
  });

  it('honours a user exclusion above everything else', () => {
    const e = L.effectOf(txn({ kind: 'expense', amount: '500', excludeFromAnalytics: true }));
    expect(e.spend).toBe(0);
    expect(e.reason).toBe('user_excluded');
  });
});

describe('the ₹25,000 double-counting scenario from the brief', () => {
  it('reports ₹25,000 of spending, not ₹50,000', () => {
    const ledger = txns([
      // Card purchases totalling 25,000
      { kind: 'cc_charge', amount: '15000', accountId: 'card-1', date: '2026-08-04' },
      { kind: 'cc_charge', amount: '10000', accountId: 'card-1', date: '2026-08-09' },
      // Bank pays the card bill
      { kind: 'cc_payment', amount: '25000', accountId: 'acct-bank', date: '2026-08-20' },
      // The same settlement as it appears on the card statement
      { kind: 'cc_payment', amount: '25000', accountId: 'card-1', date: '2026-08-21' },
    ]);

    const totals = L.totalsOf(ledger);
    expect(totals.totalSpend).toBe(fromMajor('25000'));
    expect(totals.spendCount).toBe(2);
  });

  it('nets a partial refund out of the same cycle', () => {
    const totals = L.totalsOf(
      txns([
        { kind: 'cc_charge', amount: '2499' },
        { kind: 'refund', amount: '999' },
      ]),
    );
    expect(totals.grossSpend).toBe(rs(2499));
    expect(totals.refunds).toBe(rs(999));
    expect(totals.totalSpend).toBe(rs(1500));
  });

  it('does not let a salary-sized self-transfer inflate income', () => {
    const totals = L.totalsOf(
      txns([
        { kind: 'income', amount: '75000' },
        { kind: 'transfer', amount: '40000' },
        { kind: 'expense', amount: '5000' },
      ]),
    );
    expect(totals.totalIncome).toBe(rs(75000));
    expect(totals.totalSpend).toBe(rs(5000));
    expect(totals.netCashFlow).toBe(rs(70000));
  });

  it('treats an ATM withdrawal followed by tracked cash spend as one expense', () => {
    const ledger = txns([
      { kind: 'cash_withdrawal', amount: '5000', accountId: 'acct-bank' },
      { kind: 'expense', amount: '1200', accountId: 'acct-cash', paymentMethod: 'cash' },
    ]);
    // Cash tracked separately: only the recorded cash purchase counts.
    const tracked = L.totalsOf(ledger, { cashWithdrawalCountsAsSpend: false, includePending: false });
    expect(tracked.totalSpend).toBe(rs(1200));
    // Cash not tracked: the withdrawal stands in for the spending.
    const untracked = L.totalsOf(ledger, { cashWithdrawalCountsAsSpend: true, includePending: false });
    expect(untracked.totalSpend).toBe(rs(6200));
  });
});

describe('totalsOf', () => {
  it('returns zeroed totals for an empty ledger rather than NaN', () => {
    const totals = L.totalsOf([]);
    expect(totals).toMatchObject({ totalSpend: 0, totalIncome: 0, netCashFlow: 0, spendCount: 0 });
  });

  it('computes net cash flow after investments', () => {
    const totals = L.totalsOf(
      txns([
        { kind: 'income', amount: '75000' },
        { kind: 'expense', amount: '43250' },
        { kind: 'investment', amount: '10000' },
      ]),
    );
    expect(totals.netCashFlow).toBe(rs(21750));
  });
});

describe('essentialSplit', () => {
  const essentialCats = new Set(['cat-rent', 'cat-groceries']);
  const lookup = (id: string | null) => (id === null ? null : essentialCats.has(id));

  it('splits by category classification', () => {
    const split = L.essentialSplit(
      txns([
        { amount: '25000', categoryId: 'cat-rent' },
        { amount: '7000', categoryId: 'cat-groceries' },
        { amount: '8000', categoryId: 'cat-shopping' },
      ]),
      lookup,
    );
    expect(split.essential).toBe(rs(32000));
    expect(split.discretionary).toBe(rs(8000));
    expect(split.essentialShare).toBeCloseTo(80);
  });

  it('lets a per-transaction override win over the category', () => {
    const split = L.essentialSplit(
      txns([{ amount: '5000', categoryId: 'cat-rent', isEssential: false }]),
      lookup,
    );
    expect(split.discretionary).toBe(rs(5000));
  });

  it('treats uncategorised spending as discretionary rather than flattering the user', () => {
    const split = L.essentialSplit(txns([{ amount: '3000', categoryId: null }]), lookup);
    expect(split.discretionary).toBe(rs(3000));
  });

  it('returns null shares for an empty split instead of NaN', () => {
    const split = L.essentialSplit([], lookup);
    expect(split.essentialShare).toBeNull();
  });
});
