import { describe, it, expect } from 'vitest';
import * as CC from '../src/creditcard';
import { fromMajor } from '../src/money';
import { txns, rs } from './helpers/factory';

const debit = (v: string) => fromMajor(`-${v}`);
const credit = (v: string) => fromMajor(v);

describe('classifyKind', () => {
  it('recognises credit card bill payments from both sides', () => {
    const bankSide = CC.classifyKind({
      description: 'NEFT DR-HDFC CREDIT CARD PAYMENT-XXXX1234',
      signedAmount: debit('25000'),
    });
    expect(bankSide.kind).toBe('cc_payment');
    expect(bankSide.confidence).toBeGreaterThan(0.9);

    const cardSide = CC.classifyKind({
      description: 'PAYMENT RECEIVED, THANK YOU',
      signedAmount: credit('25000'),
      account: { id: 'card-1', type: 'credit_card' },
    });
    expect(cardSide.kind).toBe('cc_payment');
  });

  it('classifies card purchases as spending', () => {
    const r = CC.classifyKind({
      description: 'SWIGGY INSTAMART BANGALORE',
      signedAmount: debit('847'),
      account: { id: 'card-1', type: 'credit_card' },
    });
    expect(r.kind).toBe('cc_charge');
  });

  it('recognises self-transfers, withdrawals, deposits and investments', () => {
    expect(CC.classifyKind({ description: 'IMPS SELF TRANSFER', signedAmount: debit('20000') }).kind).toBe('transfer');
    expect(CC.classifyKind({ description: 'ATM CASH WDL NFS', signedAmount: debit('5000') }).kind).toBe('cash_withdrawal');
    expect(CC.classifyKind({ description: 'CASH DEPOSIT CDM', signedAmount: credit('3000') }).kind).toBe('cash_deposit');
    expect(CC.classifyKind({ description: 'SIP ZERODHA COIN', signedAmount: debit('10000') }).kind).toBe('investment');
  });

  it('recognises salary credits and refunds', () => {
    expect(CC.classifyKind({ description: 'NEFT CR SALARY AUG', signedAmount: credit('75000') }).kind).toBe('income');
    expect(CC.classifyKind({ description: 'AMAZON REFUND', signedAmount: credit('2499') }).kind).toBe('refund');
  });

  it('falls back to a low-confidence guess so the row reaches human review', () => {
    const r = CC.classifyKind({ description: 'POS 4412XXXXXX9021', signedAmount: debit('1200') });
    expect(r.kind).toBe('expense');
    expect(r.confidence).toBeLessThan(0.75);
  });

  it('does not mistake a merchant named "card" for a settlement', () => {
    const r = CC.classifyKind({ description: 'CARDEKHO PVT LTD', signedAmount: debit('1500') });
    expect(r.kind).toBe('expense');
  });
});

describe('matchSettlements', () => {
  const bank = [
    { id: 'b1', date: '2026-08-20', amount: rs(25000), kind: 'cc_payment' as const, accountId: 'acct-bank', description: 'CC PAYMENT' },
    { id: 'b2', date: '2026-08-05', amount: rs(1200), kind: 'expense' as const, accountId: 'acct-bank', description: 'SWIGGY' },
  ];
  const card = [
    { id: 'c1', date: '2026-08-21', amount: rs(25000), kind: 'cc_payment' as const, accountId: 'card-1', description: 'PAYMENT RECEIVED' },
  ];

  it('pairs the bank debit with the card credit', () => {
    const matches = CC.matchSettlements(bank, card);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ paymentId: 'b1', cardSideId: 'c1', daysApart: 1 });
  });

  it('does not match across a different amount or a distant date', () => {
    expect(CC.matchSettlements(bank, [{ ...card[0]!, amount: rs(24999) }])).toHaveLength(0);
    expect(CC.matchSettlements(bank, [{ ...card[0]!, date: '2026-09-15' }])).toHaveLength(0);
  });

  it('never pairs two rows from the same account', () => {
    expect(CC.matchSettlements(bank, [{ ...card[0]!, accountId: 'acct-bank' }])).toHaveLength(0);
  });

  it('uses each card-side row at most once when payments repeat', () => {
    const twoPayments = [
      bank[0]!,
      { id: 'b3', date: '2026-08-20', amount: rs(25000), kind: 'cc_payment' as const, accountId: 'acct-bank', description: 'CC PAYMENT' },
    ];
    const matches = CC.matchSettlements(twoPayments, card);
    expect(matches).toHaveLength(1);
  });
});

describe('cardOutstanding', () => {
  it('nets charges, refunds and payments', () => {
    const balance = CC.cardOutstanding(
      txns([
        { kind: 'cc_charge', amount: '15000' },
        { kind: 'cc_charge', amount: '10000' },
        { kind: 'refund', amount: '2000' },
        { kind: 'cc_payment', amount: '20000' },
      ]),
      fromMajor('0'),
    );
    expect(balance).toBe(rs(3000));
  });

  it('ignores failed charges', () => {
    const balance = CC.cardOutstanding(
      txns([
        { kind: 'cc_charge', amount: '5000' },
        { kind: 'cc_charge', amount: '9999', status: 'failed' },
      ]),
      fromMajor('0'),
    );
    expect(balance).toBe(rs(5000));
  });
});

describe('card settlements with the issuer named before "card"', () => {
  const fromBank = (description: string) =>
    CC.classifyKind({
      description,
      signedAmount: fromMajor('-9000'),
      account: { id: 'bank', type: 'bank' },
    });

  /**
   * These narrations were classified as ordinary expenses, which double-counted every
   * card bill: once as the settlement leaving the bank, and again as the `cc_charge`
   * rows it settles. Both are spend kinds, so the error compounded silently.
   */
  it.each([
    'PAYMENT TO HDFC CREDIT CARD',
    'PAYMENT TOWARDS ICICI CREDIT CARD',
    'PAYMENT TO AXIS CC',
    'IMPS TO KOTAK CREDIT CARD',
    'RTGS PAYMENT TO AMEX CARD',
    'NEFT TO SBI CREDIT CARD',
    'UPI-HDFC CREDIT CARD PAYMENT',
  ])('reads %s as settling a card, not as spending', (description) => {
    expect(fromBank(description).kind).toBe('cc_payment');
  });

  /**
   * The bounded gap must not swallow unrelated rows. A fee or a purchase that merely
   * mentions a card is still real spending, and a narration that pairs a payment with
   * a distant, comma-separated mention of a card is two different things.
   */
  it.each([
    'CREDIT CARD ANNUAL FEE',
    'CREDIT CARD LATE PAYMENT FEE',
    'PAYMENT TO CARDIOLOGY CLINIC',
    'PAYMENT TO LANDLORD, HDFC CREDIT CARD ENDING 1234',
  ])('does not read %s as settling a card', (description) => {
    expect(fromBank(description).kind).not.toBe('cc_payment');
  });
});
