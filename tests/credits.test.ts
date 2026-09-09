import { describe, it, expect } from 'vitest';
import { classifyKind } from '../src/creditcard';
import { fromMajor } from '../src/money';

const credit = (description: string) =>
  classifyKind({ description, signedAmount: fromMajor('5000') });

const debit = (description: string) =>
  classifyKind({ description, signedAmount: -fromMajor('5000') as never });

/**
 * The bug these guard against: every unexplained credit used to become income at 0.5
 * confidence, which inflated income, the savings rate and every projection built on
 * them. A credit is only income when something says so.
 */
describe('credits are not automatically income', () => {
  it('does not call an unexplained credit income with any confidence', () => {
    const result = credit('UPI/CR/402913847/PAYTM');
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.incomeType).toBe('unknown');
    expect(result.reason).toMatch(/transfer|refund/i);
  });

  it('recognises a salary credit', () => {
    const result = credit('NEFT SALARY JULY ACME PVT LTD');
    expect(result.kind).toBe('income');
    expect(result.incomeType).toBe('salary');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('recognises bank interest as income, separately from salary', () => {
    const result = credit('INT.COLL 01/07/2026 TO 30/09/2026');
    expect(result.kind).toBe('income');
    expect(result.incomeType).toBe('interest');
  });

  it('recognises a savings interest credit', () => {
    expect(credit('SAVINGS INTEREST CREDIT').incomeType).toBe('interest');
  });

  it('recognises a dividend as interest-and-dividend income', () => {
    const result = credit('DIVIDEND WARRANT INFOSYS LTD');
    expect(result.kind).toBe('income');
    expect(result.incomeType).toBe('interest');
  });

  it('treats cashback as a refund, not earnings', () => {
    // Cashback reduces what a purchase cost; counting it as income overstates earnings.
    expect(credit('CASHBACK CREDIT AMAZON PAY').kind).toBe('refund');
  });

  it('treats a matured deposit as own money, not new income', () => {
    expect(credit('FD MATURITY PROCEEDS A/C 8891').kind).toBe('transfer');
  });

  it('treats an auto-sweep credit as a transfer', () => {
    expect(credit('AUTO SWEEP TRF FROM MOD').kind).toBe('transfer');
  });

  it('treats a reversed bank charge as a refund', () => {
    expect(credit('AMB CHARGES REV 062026').kind).toBe('refund');
  });

  it('still recognises an explicit self transfer', () => {
    expect(credit('SELF TRANSFER FROM HDFC').kind).toBe('transfer');
  });

  it('still recognises a refund', () => {
    expect(credit('REFUND SWIGGY ORDER 88213').kind).toBe('refund');
  });

  it('leaves debits alone', () => {
    expect(debit('SWIGGY BANGALORE').kind).toBe('expense');
  });

  it('does not mistake a salary-shaped debit for income', () => {
    // A payroll payment OUT of a business account is not the user's income.
    expect(debit('SALARY PAYOUT STAFF').kind).not.toBe('income');
  });

  it('flags every unidentified credit below the review threshold', () => {
    const samples = [
      'UPI/CR/1234/JOHN DOE',
      'IMPS IN 402913847',
      'NEFT CR SOME COMPANY',
      'RTGS INWARD 8829',
    ];
    for (const text of samples) {
      const result = credit(text);
      // 0.6 is the pipeline's review threshold.
      expect(result.confidence, text).toBeLessThan(0.6);
    }
  });
});
