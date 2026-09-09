import { describe, expect, it } from 'vitest';
import {
  advanceAfterPayment, outstandingTotal, projectBalance, settleCommitments, settledTotal,
  undatedOutstanding, undatedOutstandingTotal,
} from '../src/settlement';
import { fromMajor, ZERO } from '../src/money';
import type { RecurringExpense } from '../src/types';
import { txn } from './helpers/factory';

const CYCLE = { cycleStart: '2026-09-01', cycleEnd: '2026-09-30', today: '2026-09-03' };

const commitment = (over: Partial<RecurringExpense> = {}): RecurringExpense => ({
  id: 'c1', userId: 'u1', name: 'Rent', merchantKey: null, categoryId: null,
  amount: fromMajor('8500'), interval: 'monthly', dayOfPeriod: null, nextDueDate: null,
  lastSeenDate: null, accountId: null, paymentMethod: null, isEssential: true,
  isActive: true, autoDetected: false, confidence: 1, reminderEnabled: false,
  remindDaysBefore: 1, ...over,
} as RecurringExpense);

describe('settleCommitments', () => {
  it('does not let one keyless payment settle every keyless commitment', () => {
    // The bug this module exists to fix. Three hand-added commitments all have a null
    // merchant key; matching on `merchantKey ?? ''` gave them all the same identity, so
    // a single manual entry marked the lot as paid and the forecast reported nothing due.
    const commitments = [
      commitment({ id: 'rent', name: 'Rent', amount: fromMajor('8500') }),
      commitment({ id: 'emi', name: 'Bike Emi', amount: fromMajor('6661') }),
      commitment({ id: 'loan', name: 'Education Loan', amount: fromMajor('12000') }),
    ];
    const statuses = settleCommitments({
      ...CYCLE,
      commitments,
      // One manual recurring payment, no merchant key, not linked to anything.
      transactions: [txn({ date: '2026-09-03', amount: fromMajor('8500'), isRecurring: true })],
    });
    expect(statuses.filter((s) => s.outstanding)).toHaveLength(3);
    expect(outstandingTotal(statuses)).toBe(fromMajor('27161'));
  });

  it('settles the one commitment a payment is actually linked to', () => {
    const commitments = [
      commitment({ id: 'rent', amount: fromMajor('8500') }),
      commitment({ id: 'emi', amount: fromMajor('6661') }),
    ];
    const statuses = settleCommitments({
      ...CYCLE,
      commitments,
      transactions: [
        txn({ date: '2026-09-03', amount: fromMajor('8500'), recurringExpenseId: 'rent' }),
      ],
    });
    expect(statuses.find((s) => s.commitment.id === 'rent')!.outstanding).toBe(false);
    expect(statuses.find((s) => s.commitment.id === 'emi')!.outstanding).toBe(true);
    expect(outstandingTotal(statuses)).toBe(fromMajor('6661'));
    expect(settledTotal(statuses)).toBe(fromMajor('8500'));
  });

  it('still matches an imported row by a real merchant key', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ id: 'netflix', merchantKey: 'netflix' })],
      transactions: [txn({ date: '2026-09-02', merchantKey: 'netflix', isRecurring: true })],
    });
    expect(statuses[0]!.outstanding).toBe(false);
    expect(statuses[0]!.paidOn).toBe('2026-09-02');
  });

  it('treats a monthly commitment with no due date as still due this cycle', () => {
    // Reporting "nothing committed" because nobody typed a date is how the forecast
    // came to show ₹0 against three real bills.
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ nextDueDate: null, interval: 'monthly' })],
      transactions: [],
    });
    expect(statuses[0]!.outstanding).toBe(true);
  });

  it('does not assume a yearly commitment falls in this cycle', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ nextDueDate: null, interval: 'yearly' })],
      transactions: [],
    });
    expect(statuses[0]!.outstanding).toBe(false);
  });

  it('excludes a commitment due in a later cycle', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ nextDueDate: '2026-11-05' })],
      transactions: [],
    });
    expect(statuses[0]!.outstanding).toBe(false);
  });

  it('flags an unpaid commitment whose date has passed', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ nextDueDate: '2026-09-01' })],
      transactions: [],
    });
    expect(statuses[0]!.overdue).toBe(true);
  });

  it('is not overdue when it has been paid', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ id: 'rent', nextDueDate: '2026-09-01' })],
      transactions: [txn({ date: '2026-09-01', recurringExpenseId: 'rent' })],
    });
    expect(statuses[0]!.overdue).toBe(false);
  });

  it('ignores payments outside the cycle', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ id: 'rent' })],
      transactions: [txn({ date: '2026-08-30', recurringExpenseId: 'rent' })],
    });
    expect(statuses[0]!.outstanding).toBe(true);
  });

  it('ignores an excluded transaction', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ id: 'rent' })],
      transactions: [
        txn({ date: '2026-09-02', recurringExpenseId: 'rent', excludeFromAnalytics: true }),
      ],
    });
    expect(statuses[0]!.outstanding).toBe(true);
  });

  it('drops commitments that are no longer tracked', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ isActive: false })],
      transactions: [],
    });
    expect(statuses).toHaveLength(0);
  });
});

describe('undatedOutstandingTotal', () => {
  it('reports money that the scheduler cannot place on any day', () => {
    // These are the bills that produced "Nothing scheduled before payday" while ₹27,161
    // a month was genuinely owed: no last payment, no due date, so no occurrences.
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [
        commitment({ id: 'rent', amount: fromMajor('8500') }),
        commitment({ id: 'emi', amount: fromMajor('6661') }),
        commitment({ id: 'loan', amount: fromMajor('12000') }),
      ],
      transactions: [],
    });
    expect(undatedOutstandingTotal(statuses)).toBe(fromMajor('27161'));
    expect(undatedOutstanding(statuses)).toHaveLength(3);
  });

  it('excludes anything the scheduler can already place', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ nextDueDate: '2026-09-10', amount: fromMajor('8500') })],
      transactions: [],
    });
    // Counting a dated commitment here as well would double it in the forecast.
    expect(undatedOutstandingTotal(statuses)).toBe(ZERO);
  });

  it('excludes an undated commitment that has been paid', () => {
    const statuses = settleCommitments({
      ...CYCLE,
      commitments: [commitment({ id: 'rent' })],
      transactions: [txn({ date: '2026-09-02', recurringExpenseId: 'rent' })],
    });
    expect(undatedOutstandingTotal(statuses)).toBe(ZERO);
  });
});

describe('advanceAfterPayment', () => {
  it('advances from the due date so a late payment does not drift', () => {
    // Due the 5th, paid the 8th. Next month is still the 5th, not the 8th.
    expect(advanceAfterPayment({ nextDueDate: '2026-09-05', interval: 'monthly' }, '2026-09-08'))
      .toBe('2026-10-05');
  });

  it('advances past a payment made on the due date itself', () => {
    expect(advanceAfterPayment({ nextDueDate: '2026-09-05', interval: 'monthly' }, '2026-09-05'))
      .toBe('2026-10-05');
  });

  it('anchors to the payment date when nothing else is known', () => {
    expect(advanceAfterPayment({ nextDueDate: null, interval: 'monthly' }, '2026-09-03'))
      .toBe('2026-10-03');
  });

  it('handles a non-monthly interval', () => {
    expect(advanceAfterPayment({ nextDueDate: '2026-09-05', interval: 'quarterly' }, '2026-09-05'))
      .toBe('2026-12-05');
  });
});

describe('projectBalance', () => {
  it('separates what is committed from what is still a choice', () => {
    const b = projectBalance({
      income: fromMajor('56000'),
      spent: fromMajor('25544'),
      committed: fromMajor('27161'),
      everyday: fromMajor('4000'),
    });
    expect(b.afterCommitments).toBe(fromMajor('3295'));
    expect(b.leftover).toBe(fromMajor('-705'));
  });

  it('reports a negative leftover rather than clamping it', () => {
    // A shortfall the user cannot see is a shortfall they cannot act on.
    const b = projectBalance({
      income: fromMajor('10000'), spent: fromMajor('9000'),
      committed: fromMajor('5000'), everyday: ZERO,
    });
    expect(b.afterCommitments).toBe(fromMajor('-4000'));
    expect((b.leftover as number) < 0).toBe(true);
  });

  it('is all income when nothing has happened yet', () => {
    const b = projectBalance({
      income: fromMajor('50000'), spent: ZERO, committed: ZERO, everyday: ZERO,
    });
    expect(b.leftover).toBe(fromMajor('50000'));
  });
});
