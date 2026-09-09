import { describe, it, expect } from 'vitest';
import { parseScreenshotText, pickAmount, scoreAmount } from '../src/import/screenshot';
import { fromMajor } from '../src/money';

const rs = (v: string) => fromMajor(v);
const only = (text: string) => {
  const rows = parseScreenshotText(text, { today: '2026-08-28' });
  return rows.length === 1 ? rows[0]! : null;
};

/**
 * These are the screens people actually photograph: a payment receipt with the
 * account balance underneath, a grocery bill with tax lines, a card app showing a
 * credit limit. Every one of them used to hand back the biggest number on screen.
 */
describe('picking the transaction value out of a cluttered screen', () => {
  it('ignores the account balance', () => {
    const row = only(`
      Paid to Priya Menon
      ₹120
      Completed
      Available balance ₹52,812
      UPI transaction ID 402913847221
    `);
    expect(row?.signedAmount).toBe(-rs('120'));
  });

  it('prefers a labelled total over a larger line item', () => {
    const row = only(`
      BIG BAZAAR RETAIL
      Rice 5kg        ₹520
      Cooking oil     ₹890
      Detergent       ₹410
      Total           ₹1,820
    `);
    expect(row?.signedAmount).toBe(-rs('1820'));
  });

  it('prefers Grand Total over Subtotal and tax', () => {
    const row = only(`
      INVOICE
      Subtotal      ₹1,000
      CGST 9%       ₹90
      SGST 9%       ₹90
      Grand Total   ₹1,180
    `);
    expect(row?.signedAmount).toBe(-rs('1180'));
  });

  it('ignores a cashback offer sitting beside the amount', () => {
    const row = only(`
      Paid to Swiggy
      ₹347
      You saved ₹1,200 with this offer
      Completed
    `);
    expect(row?.signedAmount).toBe(-rs('347'));
  });

  it('ignores a credit limit on a card screen', () => {
    const row = only(`
      Payment successful
      Amount paid ₹2,450
      Available limit ₹1,50,000
    `);
    expect(row?.signedAmount).toBe(-rs('2450'));
  });

  it('ignores an MRP struck through beside the price paid', () => {
    const row = only(`
      Order confirmed
      MRP ₹1,999
      Amount payable ₹1,249
    `);
    expect(row?.signedAmount).toBe(-rs('1249'));
  });

  it('does not read a reference number as money', () => {
    const row = only(`
      Paid to Local Kirana
      ₹85
      UPI Ref No 402913847221
      Order ID 88213394
    `);
    expect(row?.signedAmount).toBe(-rs('85'));
  });

  it('still reads a plain receipt with one amount', () => {
    const row = only(`
      Paid to Priya Menon
      ₹1,842
      Completed
    `);
    expect(row?.signedAmount).toBe(-rs('1842'));
  });

  it('keeps a credit positive', () => {
    const row = only(`
      Received from Anita Sharma
      ₹5,000
      Available balance ₹61,204
    `);
    expect(row?.signedAmount).toBe(rs('5000'));
  });
});

describe('scoreAmount', () => {
  it('rates a labelled total above a bare currency amount', () => {
    const total = scoreAmount({ value: rs('100'), line: 'Total ₹100', marked: true });
    const bare = scoreAmount({ value: rs('900'), line: '₹900', marked: true });
    expect(total).toBeGreaterThan(bare);
  });

  it('pushes a balance below zero however it is written', () => {
    for (const line of ['Available balance ₹52,812', 'Avl Bal 52812', 'Closing balance ₹9,000', 'Wallet balance ₹300']) {
      expect(scoreAmount({ value: rs('52812'), line, marked: true }), line).toBeLessThan(0);
    }
  });

  it('rates a subtotal below a grand total', () => {
    const sub = scoreAmount({ value: rs('1000'), line: 'Subtotal ₹1,000', marked: true });
    const grand = scoreAmount({ value: rs('1180'), line: 'Grand Total ₹1,180', marked: true });
    expect(grand).toBeGreaterThan(sub);
  });
});

describe('pickAmount', () => {
  it('breaks a score tie by size', () => {
    const picked = pickAmount([
      { value: rs('100'), line: '₹100', marked: true },
      { value: rs('250'), line: '₹250', marked: true },
    ]);
    expect(picked).toBe(rs('250'));
  });

  it('returns nothing rather than inventing a figure when every number is excluded', () => {
    // A balance and a reference only. Guessing here would write a number the user
    // never spent into their accounts.
    const picked = pickAmount([
      { value: rs('52812'), line: 'Available balance ₹52,812', marked: true },
      { value: rs('402913'), line: 'UPI Ref No 402913', marked: false },
    ]);
    expect(picked).toBeNull();
  });

  it('returns null for no candidates', () => {
    expect(pickAmount([])).toBeNull();
  });
});

describe('bank statement and passbook screenshots', () => {
  it('does not use a branch name as the merchant', () => {
    // A statement screenshot is mostly field labels. Each looks like a payee: a
    // capitalised phrase with no amount on it.
    const rows = parseScreenshotText(
      `STATE BANK OF INDIA
       Branch Name Panampilly Nagar
       IFSC SBIN0001234
       Account Number 4400
       Paid to Sree Traders
       ₹31,800`,
      { today: '2026-08-28' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).not.toMatch(/branch name/i);
    expect(rows[0]!.description).toMatch(/sree traders/i);
    expect(rows[0]!.signedAmount).toBe(-rs('31800'));
  });

  it('ignores opening and closing balance lines on a passbook', () => {
    const rows = parseScreenshotText(
      `Statement of Account
       Opening balance ₹52,000
       Paid to Local Kirana ₹450
       Closing balance ₹51,550`,
      { today: '2026-08-28' },
    );
    expect(rows.map((r) => r.signedAmount)).toEqual([-rs('450')]);
  });
});

describe('GST invoices', () => {
  // A real jeweller's invoice, flattened the way OCR delivers it.
  const INVOICE = `Bill To · State · Gode · Mobile
    MISS, MEERA JOY · Villa No, 60
    Bank Details · Kerala · Pin 560077
    Item Description · DIAMOND NOSEPIN · 32 · 18K
    Accout name: GLITZ GLAZE JEWELS PVT LTD
    Total Taxable Amount · HSN: 7113 · SGST -1.50%
    Total Invoice Value  ₹31,800.25`;

  it('uses the seller, not the form field labels, as the merchant', () => {
    const rows = parseScreenshotText(INVOICE, { today: '2026-08-28' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toMatch(/glitz glaze/i);
    expect(rows[0]!.description).not.toMatch(/bill to|state|gode|mobile/i);
  });

  it('takes the invoice total, not a tax line or an item weight', () => {
    const rows = parseScreenshotText(INVOICE, { today: '2026-08-28' });
    expect(rows[0]!.signedAmount).toBe(-fromMajor('31800.25'));
  });

  it('does not treat an itemised invoice as many transactions', () => {
    expect(parseScreenshotText(INVOICE, { today: '2026-08-28' })).toHaveLength(1);
  });
});
