import { describe, it, expect } from 'vitest';
import { parseSpokenExpense, parseSpokenNumber } from '../src/voice';
import { fromMajor } from '../src/money';

const TODAY = '2026-09-02';
const say = (text: string) => parseSpokenExpense(text, TODAY);

describe('parseSpokenNumber', () => {
  it('reads plain number words', () => {
    expect(parseSpokenNumber('four hundred and fifty')).toBe(450);
  });

  it('reads "four fifty" as 450, the way it is actually spoken', () => {
    // The single most common Indian English shorthand for an amount.
    expect(parseSpokenNumber('four fifty')).toBe(450);
  });

  it('does not turn "twenty five" into 2005', () => {
    expect(parseSpokenNumber('twenty five')).toBe(25);
  });

  it('handles thousands', () => {
    expect(parseSpokenNumber('two thousand five hundred')).toBe(2500);
  });

  it('handles lakh', () => {
    expect(parseSpokenNumber('one lakh twenty thousand')).toBe(120000);
  });

  it('handles a bare scale word', () => {
    expect(parseSpokenNumber('thousand')).toBe(1000);
  });

  it('returns null when there is no number', () => {
    expect(parseSpokenNumber('groceries at the shop')).toBeNull();
  });
});

describe('parseSpokenExpense', () => {
  it('pulls amount, merchant and note out of a full sentence', () => {
    const r = say('spent 450 on groceries at Sharma Kirana');
    expect(r.amount).toBe(fromMajor('450'));
    expect(r.merchant).toBe('Sharma Kirana');
    expect(r.note.toLowerCase()).toContain('groceries');
    expect(r.kind).toBe('expense');
  });

  it('reads a spoken number when no digits were recognised', () => {
    expect(say('spent four fifty on groceries').amount).toBe(fromMajor('450'));
  });

  it('applies a scale word to digits', () => {
    expect(say('paid 1.2k for shopping').amount).toBe(fromMajor('1200'));
  });

  it('understands lakh with digits', () => {
    expect(say('paid 2 lakh for the deposit').amount).toBe(fromMajor('200000'));
  });

  it('strips a rupee marker', () => {
    expect(say('₹1,250 for medicines').amount).toBe(fromMajor('1250'));
  });

  it('treats "got" as income, not spending', () => {
    const r = say('got 5000 from Ramesh');
    expect(r.kind).toBe('income');
    expect(r.merchant).toBe('Ramesh');
  });

  it('treats a refund as money in', () => {
    expect(say('refunded 300 from Swiggy').kind).toBe('income');
  });

  it('understands yesterday', () => {
    expect(say('spent 200 on tea yesterday').date).toBe('2026-09-01');
  });

  it('understands the day before yesterday', () => {
    expect(say('paid 900 for fuel day before yesterday').date).toBe('2026-08-31');
  });

  it('defaults to today', () => {
    expect(say('spent 100 on tea').date).toBe(TODAY);
  });

  it('does not swallow the whole sentence into the merchant', () => {
    // "at" mid-sentence must not take everything after it.
    const r = say('paid at the counter for groceries');
    expect(r.merchant === null || r.merchant.length < 30).toBe(true);
  });

  it('says what it could not work out', () => {
    const r = say('spent some money somewhere');
    expect(r.amount).toBeNull();
    expect(r.missing).toContain('amount');
    expect(r.confidence).toBeLessThan(0.7);
  });

  it('is confident about a complete sentence', () => {
    expect(say('spent 450 on groceries at Sharma Kirana').confidence).toBe(1);
  });

  it('leaves a note the category matcher can use', () => {
    // Filler and figures gone; the meaning kept.
    const r = say('paid 1200 for electricity bill');
    expect(r.note.toLowerCase()).toContain('electricity');
    expect(r.note).not.toMatch(/1200|paid|for/i);
  });

  it('copes with the amount spoken last', () => {
    const r = say('groceries 450');
    expect(r.amount).toBe(fromMajor('450'));
    expect(r.note.toLowerCase()).toContain('groceries');
  });

  it('never returns a negative or zero amount', () => {
    expect(say('spent 0 on nothing').amount).toBeNull();
  });
});
