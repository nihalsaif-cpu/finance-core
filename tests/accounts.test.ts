import { describe, expect, it } from 'vitest';
import {
  billingDayIn, cardCycle, matchAccountByLast4, nextBillingDate, parseDay,
  sortAccounts, summariseAccounts, totalCardSpend, validateAccount,
  type AccountDraft,
} from '../src/accounts';
import { fromMajor, ZERO, type Minor } from '../src/money';
import type { Account, AccountType, AnalyzableTransaction } from '../src/types';

const account = (over: Partial<Account> = {}): Account => ({
  id: 'a1', userId: 'u1', name: 'HDFC', type: 'bank', last4: null, institution: null,
  currency: 'INR', statementDay: null, dueDay: null, creditLimit: null,
  openingBalance: ZERO, isActive: true, color: '#4C6FFF', ...over,
});

const txn = (over: Partial<AnalyzableTransaction> = {}): AnalyzableTransaction => ({
  id: 't1', date: '2026-09-03', amount: fromMajor('1000'), kind: 'expense', status: 'posted',
  categoryId: null, merchantKey: null, merchantName: null, description: '',
  paymentMethod: 'credit_card', accountId: 'a1', isEssential: null, isRecurring: false,
  recurringExpenseId: null, excludeFromAnalytics: false, ...over,
});

const draft = (over: Partial<AccountDraft> = {}): AccountDraft => ({
  name: 'HDFC', type: 'bank', last4: '', institution: '',
  statementDay: '', dueDay: '', creditLimit: null, ...over,
});

describe('validateAccount', () => {
  it('accepts a plain named account', () => {
    expect(validateAccount(draft())).toEqual({});
  });

  it('requires a name that is not just whitespace', () => {
    expect(validateAccount(draft({ name: '   ' })).name).toBeDefined();
  });

  it('accepts a blank last4 but rejects a partial one', () => {
    expect(validateAccount(draft({ last4: '' })).last4).toBeUndefined();
    expect(validateAccount(draft({ last4: '1234' })).last4).toBeUndefined();
    expect(validateAccount(draft({ last4: '123' })).last4).toBeDefined();
    expect(validateAccount(draft({ last4: '12a4' })).last4).toBeDefined();
  });

  it('rejects a billing day outside the month', () => {
    const d = draft({ type: 'credit_card', statementDay: '32' });
    expect(validateAccount(d).statementDay).toBeDefined();
    expect(validateAccount(draft({ type: 'credit_card', statementDay: '0' })).statementDay).toBeDefined();
    expect(validateAccount(draft({ type: 'credit_card', statementDay: '31' })).statementDay).toBeUndefined();
  });

  it('ignores card fields on an account that is not a card', () => {
    // The DB rejects the row outright if these are set on a bank account, so the UI
    // must not collect them — but a stale draft value must not block saving either.
    const d = draft({ type: 'bank', statementDay: '99', creditLimit: fromMajor('-5') as Minor });
    expect(validateAccount(d)).toEqual({});
  });

  it('rejects a negative credit limit', () => {
    const d = draft({ type: 'credit_card', creditLimit: -100 as Minor });
    expect(validateAccount(d).creditLimit).toBeDefined();
  });
});

describe('parseDay', () => {
  it('reads blank as "not set", not as an error', () => {
    expect(parseDay('')).toBeNull();
    expect(parseDay('  ')).toBeNull();
  });

  it('reads a valid day', () => {
    expect(parseDay('5')).toBe(5);
    expect(parseDay('31')).toBe(31);
  });

  it('rejects anything outside 1-31', () => {
    expect(parseDay('0')).toBe('invalid');
    expect(parseDay('32')).toBe('invalid');
    expect(parseDay('abc')).toBe('invalid');
  });
});

describe('billing dates', () => {
  it('clamps a 31st billing day to the last day of a short month', () => {
    expect(billingDayIn(2026, 2, 31)).toBe('2026-02-28');
    expect(billingDayIn(2028, 2, 31)).toBe('2028-02-29');
    expect(billingDayIn(2026, 4, 31)).toBe('2026-04-30');
  });

  it('treats the billing day itself as due today, not next month', () => {
    expect(nextBillingDate('2026-09-05', 5)).toBe('2026-09-05');
  });

  it('rolls into next month once the day has passed', () => {
    expect(nextBillingDate('2026-09-06', 5)).toBe('2026-10-05');
  });

  it('rolls across a year boundary', () => {
    expect(nextBillingDate('2026-12-20', 5)).toBe('2027-01-05');
  });

  it('reports the imminent payment, not the one paired to the next statement', () => {
    // A card has two bills alive at once. On 3 Sep, last month's statement is due on
    // the 5th and this month's closes on the 20th. Pairing due-to-statement would
    // report 5 Oct and hide the payment that is two days away.
    const cycle = cardCycle('2026-09-03', 20, 5);
    expect(cycle.statementDate).toBe('2026-09-20');
    expect(cycle.dueDate).toBe('2026-09-05');
    expect(cycle.daysToDue).toBe(2);
  });

  it('returns nulls rather than guessing when the days are unknown', () => {
    expect(cardCycle('2026-09-03', null, null)).toEqual({
      statementDate: null, dueDate: null, daysToDue: null,
    });
  });
});

describe('matchAccountByLast4', () => {
  const card = account({ id: 'card', type: 'credit_card', last4: '1234' });

  it('matches the masked forms statements actually use', () => {
    for (const text of ['XXXX1234', '****1234', 'A/c ...1234', 'ending 1234', 'card 1234']) {
      expect(matchAccountByLast4([card], text)?.id).toBe('card');
    }
  });

  it('does not match digits that continue into a longer number', () => {
    // 1234 sits inside 912345, but this row belongs to some other account.
    expect(matchAccountByLast4([card], 'REF 912345')).toBeNull();
  });

  it('ignores inactive accounts', () => {
    expect(matchAccountByLast4([{ ...card, isActive: false }], 'XXXX1234')).toBeNull();
  });

  it('refuses to choose between two accounts ending the same', () => {
    // Unassigned is recoverable. Filed against the wrong card is not, because nobody
    // goes looking for a transaction that already looks filed.
    const other = account({ id: 'other', type: 'bank', last4: '1234' });
    expect(matchAccountByLast4([card, other], 'XXXX1234')).toBeNull();
  });
});

describe('summariseAccounts', () => {
  it('counts only what left the account', () => {
    const card = account({ id: 'card', type: 'credit_card', creditLimit: fromMajor('100000') });
    const summaries = summariseAccounts(
      [card],
      [
        txn({ id: '1', accountId: 'card', amount: fromMajor('20000'), kind: 'expense' }),
        // Paying the card off moves money between the user's own accounts. Counting it
        // as card spend would show the same rupees twice.
        txn({ id: '2', accountId: 'card', amount: fromMajor('20000'), kind: 'transfer' }),
      ],
      '2026-09-03',
    );
    expect(summaries[0]!.spent).toBe(fromMajor('20000'));
    expect(summaries[0]!.transactionCount).toBe(2);
    expect(summaries[0]!.utilisation).toBeCloseTo(0.2, 5);
  });

  it('reports no utilisation when no limit is known', () => {
    const card = account({ id: 'card', type: 'credit_card', creditLimit: null });
    expect(summariseAccounts([card], [], '2026-09-03')[0]!.utilisation).toBeNull();
  });

  it('gives a bank account no card cycle', () => {
    expect(summariseAccounts([account()], [], '2026-09-03')[0]!.cycle).toBeNull();
  });

  it('ignores transactions with no account', () => {
    const summaries = summariseAccounts([account()], [txn({ accountId: null })], '2026-09-03');
    expect(summaries[0]!.transactionCount).toBe(0);
  });
});

describe('sortAccounts', () => {
  it('sinks closed accounts below open ones', () => {
    const open = account({ id: 'open', name: 'Zebra', type: 'investment' });
    const closed = account({ id: 'closed', name: 'Apple', type: 'bank', isActive: false });
    expect(sortAccounts([closed, open]).map((a) => a.id)).toEqual(['open', 'closed']);
  });

  it('orders by type then name among open accounts', () => {
    const ids = sortAccounts([
      account({ id: 'cash', type: 'cash' }),
      account({ id: 'b2', type: 'bank', name: 'SBI' }),
      account({ id: 'b1', type: 'bank', name: 'Axis' }),
      account({ id: 'card', type: 'credit_card' }),
    ]).map((a) => a.id);
    expect(ids).toEqual(['b1', 'b2', 'card', 'cash']);
  });
});

describe('totalCardSpend', () => {
  it('is zero when there are no cards at all', () => {
    expect(totalCardSpend(summariseAccounts([account()], [txn()], '2026-09-03'))).toBe(ZERO);
  });

  it('adds up every card and no bank account', () => {
    const summaries = summariseAccounts(
      [
        account({ id: 'c1', type: 'credit_card' }),
        account({ id: 'c2', type: 'credit_card' }),
        account({ id: 'b1', type: 'bank' }),
      ],
      [
        txn({ id: '1', accountId: 'c1', amount: fromMajor('500') }),
        txn({ id: '2', accountId: 'c2', amount: fromMajor('700') }),
        txn({ id: '3', accountId: 'b1', amount: fromMajor('900') }),
      ],
      '2026-09-03',
    );
    expect(totalCardSpend(summaries)).toBe(fromMajor('1200'));
  });
});

describe('account types', () => {
  it('marks only credit cards as carrying billing fields', () => {
    const types: AccountType[] = ['bank', 'cash', 'wallet', 'investment'];
    for (const type of types) {
      expect(validateAccount(draft({ type, statementDay: '99' })).statementDay).toBeUndefined();
    }
  });
});
