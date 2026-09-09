import { describe, it, expect } from 'vitest';
import { parseDelimitedText, parseFixedWidthText } from '../src/import/files';
import { detectColumns } from '../src/import/columns';
import { parseStatementRows, WARNINGS } from '../src/import/statement';
import { parseScreenshotText } from '../src/import/screenshot';
import { buildCandidates, deriveReviewReasons } from '../src/import/pipeline';
import { fromMajor } from '../src/money';

const today = '2026-08-26';

// A realistic HDFC-style export: preamble rows, then separate debit/credit columns.
const HDFC_CSV = `Account Statement
Account Number: XXXXXXXX1234
Period: 01/08/2026 to 31/08/2026

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/08/2026,SALARY CREDIT NEFT PAYROLL AUG,NEFT00012345,01/08/2026,,75000.00,125340.00
02/08/2026,UPI-RENT PAYMENT-nobroker@ybl-4258319,4258319,02/08/2026,25000.00,,100340.00
04/08/2026,UPI/DR/425831947261/SWIGGY/YESB/swiggyupi@ybl/Pay,425831947261,04/08/2026,847.00,,99493.00
09/08/2026,NEFT DR-HDFC0001234-CREDIT CARD PAYMENT,NEFT00099887,09/08/2026,25000.00,,74493.00
12/08/2026,ATM CASH WDL NFS 4412,ATM7781,12/08/2026,5000.00,,69493.00
15/08/2026,AMAZON REFUND ORDER 402,REF9911,15/08/2026,,2499.00,71992.00
,Total,,,55847.00,77499.00,
`;

describe('CSV decoding', () => {
  it('reads rows positionally, keeping the preamble for header detection', () => {
    const grid = parseDelimitedText(HDFC_CSV);
    expect(grid.length).toBeGreaterThan(7);
    expect(grid[3]?.[1]).toBe('Narration');
  });
});

describe('column detection', () => {
  it('finds the header row past the preamble', () => {
    const detection = detectColumns(parseDelimitedText(HDFC_CSV));
    expect(detection.headerRowIndex).toBe(3);
    expect(detection.columns.date).toBe(0);
    expect(detection.columns.description).toBe(1);
    expect(detection.columns.reference).toBe(2);
    expect(detection.columns.debit).toBe(4);
    expect(detection.columns.credit).toBe(5);
    expect(detection.columns.balance).toBe(6);
    expect(detection.confidence).toBeGreaterThan(0.9);
  });

  it('handles a single signed amount column with a Dr/Cr indicator', () => {
    const csv = `Txn Date,Particulars,Amount,DR/CR,Balance
14/08/2026,SWIGGY,847.00,DR,12000.00
15/08/2026,SALARY,75000.00,CR,87000.00`;
    const detection = detectColumns(parseDelimitedText(csv));
    expect(detection.columns.amount).toBe(2);
    expect(detection.columns.direction).toBe(3);
    expect(detection.columns.debit).toBeUndefined();
  });

  it('does not confuse the balance column with the amount column', () => {
    const detection = detectColumns(
      parseDelimitedText(`Date,Description,Amount,Closing Balance\n14/08/2026,X,100.00,5000.00`),
    );
    expect(detection.columns.amount).toBe(2);
    expect(detection.columns.balance).toBe(3);
  });

  it('infers columns from the data when there are no usable headers', () => {
    const detection = detectColumns(
      parseDelimitedText(`14/08/2026,SWIGGY BANGALORE,847.00\n15/08/2026,UBER TRIP,320.00`),
    );
    expect(detection.columns.date).toBe(0);
    expect(detection.columns.description).toBe(1);
    expect(detection.warnings.join(' ')).toMatch(/inferred/i);
  });

  it('reports low confidence when nothing is recognisable', () => {
    const detection = detectColumns(parseDelimitedText(`foo,bar,baz\nlorem,ipsum,dolor`));
    expect(detection.confidence).toBeLessThan(0.5);
  });
});

describe('row parsing', () => {
  const result = parseStatementRows(parseDelimitedText(HDFC_CSV), { today });

  it('parses every transaction row and skips totals and preamble', () => {
    expect(result.rows).toHaveLength(6);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('signs debits negative and credits positive', () => {
    const salary = result.rows[0]!;
    expect(salary.date).toBe('2026-08-01');
    expect(salary.signedAmount).toBe(fromMajor('75000'));

    const swiggy = result.rows[2]!;
    expect(swiggy.date).toBe('2026-08-04');
    expect(swiggy.signedAmount).toBe(fromMajor('-847'));
  });

  it('captures reference numbers', () => {
    expect(result.rows[2]!.referenceNo).toBe('425831947261');
  });

  it('detects the date layout for the whole file at once', () => {
    // 15/08 proves day-first, which settles 01/08 and 02/08 too.
    expect(result.datePreference).toBe('day-first');
    expect(result.rows.every((row) => !row.warnings.includes(WARNINGS.dateAmbiguous))).toBe(true);
  });

  it('reads a Dr/Cr indicator column', () => {
    const parsed = parseStatementRows(
      parseDelimitedText(`Txn Date,Particulars,Amount,DR/CR\n14/08/2026,SWIGGY,847.00,DR\n15/08/2026,SALARY,75000.00,CR`),
      { today },
    );
    expect(parsed.rows[0]!.signedAmount).toBe(fromMajor('-847'));
    expect(parsed.rows[1]!.signedAmount).toBe(fromMajor('75000'));
  });

  it('flags a row whose direction had to be assumed', () => {
    const parsed = parseStatementRows(
      parseDelimitedText(`Date,Description,Amount\n14/08/2026,SWIGGY,847.00`),
      { today },
    );
    expect(parsed.rows[0]!.warnings).toContain(WARNINGS.directionUnknown);
    expect(parsed.rows[0]!.confidence).toBeLessThan(1);
  });

  it('keeps a row with a missing date rather than dropping it silently', () => {
    const parsed = parseStatementRows(
      parseDelimitedText(`Date,Description,Withdrawal Amt.\n,MYSTERY MERCHANT,500.00`),
      { today },
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.warnings).toContain(WARNINGS.dateMissing);
  });
});

describe('PDF / fixed-width text', () => {
  it('recovers columns from whitespace-padded statement lines', () => {
    const text = [
      'Date        Narration                     Withdrawal   Deposit    Balance',
      '01/08/2026  SALARY CREDIT                              75000.00   125340.00',
      '04/08/2026  SWIGGY BANGALORE              847.00                  124493.00',
    ].join('\n');
    const grid = parseFixedWidthText(text);
    expect(grid[1]?.[0]).toBe('01/08/2026');
    expect(grid[2]?.[1]).toBe('SWIGGY BANGALORE');

    const parsed = parseStatementRows(grid, { today });
    expect(parsed.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('screenshot extraction', () => {
  it('handles the example from the brief', () => {
    const rows = parseScreenshotText('SWIGGY INSTAMART 14/08/2026 ₹847', { today });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe('2026-08-14');
    expect(rows[0]!.signedAmount).toBe(fromMajor('-847'));
    expect(rows[0]!.description).toMatch(/SWIGGY INSTAMART/i);
  });

  it('reads a typical UPI receipt screen', () => {
    const text = [
      '12:41 PM',
      '₹1,250',
      'Paid to',
      'AMAZON SELLER SERVICES',
      'Completed',
      '15 Aug 2026',
      'UPI transaction ID 425831947261',
      'Share',
    ].join('\n');
    const rows = parseScreenshotText(text, { today });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-1250'));
    expect(rows[0]!.date).toBe('2026-08-15');
    expect(rows[0]!.referenceNo).toBe('425831947261');
  });

  it('reads money received as a credit', () => {
    const rows = parseScreenshotText('Received from RAVI KUMAR\n₹2,000\n14 Aug 2026', { today });
    expect(rows[0]!.signedAmount).toBe(fromMajor('2000'));
  });

  it('splits a transaction list screen into several rows', () => {
    const text = [
      'Swiggy  14 Aug  ₹847',
      'Uber  15 Aug  ₹320',
      'Amazon  16 Aug  ₹2,499',
    ].join('\n');
    const rows = parseScreenshotText(text, { today });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.signedAmount)).toEqual([
      fromMajor('-847'),
      fromMajor('-320'),
      fromMajor('-2499'),
    ]);
  });

  it('returns nothing rather than inventing a transaction', () => {
    expect(parseScreenshotText('Settings\nProfile\nHelp & Support', { today })).toEqual([]);
    expect(parseScreenshotText('', { today })).toEqual([]);
  });

  it('always flags OCR rows as less certain than parsed files', () => {
    const rows = parseScreenshotText('SWIGGY 14/08/2026 ₹847', { today });
    expect(rows[0]!.confidence).toBeLessThan(0.8);
  });
});

describe('pipeline', () => {
  const parsed = parseStatementRows(parseDelimitedText(HDFC_CSV), { today });
  const result = buildCandidates(parsed.rows, {
    categoryIdForSlug: (slug) => `cat-${slug}`,
    defaultPaymentMethod: 'bank_transfer',
  });

  it('classifies each row by what it actually is', () => {
    const kinds = result.candidates.map((c) => c.kind);
    expect(kinds[0]).toBe('income');          // salary credit
    expect(kinds[1]).toBe('expense');         // rent
    expect(kinds[2]).toBe('expense');         // swiggy
    expect(kinds[3]).toBe('cc_payment');      // credit card bill — not new spending
    expect(kinds[4]).toBe('cash_withdrawal');
    expect(kinds[5]).toBe('refund');
  });

  it('stores amounts as positive magnitudes', () => {
    expect(result.candidates.every((c) => c.amount === null || c.amount >= 0)).toBe(true);
    expect(result.candidates[2]!.amount).toBe(fromMajor('847'));
  });

  it('normalises merchants and suggests categories', () => {
    const swiggy = result.candidates[2]!;
    expect(swiggy.merchantKey).toBe('swiggy');
    expect(swiggy.merchantName).toBe('Swiggy');
    expect(swiggy.categoryId).toBe('cat-food_delivery');
  });

  it('explains its classification in plain language', () => {
    expect(result.candidates[3]!.explanation).toMatch(/credit card bill/i);
  });

  it('flags low-confidence rows for review instead of committing them', () => {
    expect(result.needsReview).toBeGreaterThanOrEqual(0);
    for (const candidate of result.candidates) {
      if (candidate.date === null || candidate.amount === null) {
        expect(candidate.needsReview).toBe(true);
      }
    }
  });

  it('flags a row already present in the saved ledger', () => {
    const withExisting = buildCandidates(parsed.rows, {
      categoryIdForSlug: (slug) => `cat-${slug}`,
      existing: [
        {
          id: 'saved-1',
          date: '2026-08-04',
          amount: fromMajor('847'),
          merchantKey: 'swiggy',
          description: 'SWIGGY',
          referenceNo: null,
          kind: 'expense',
          accountId: 'acct-bank',
        },
      ],
    });
    const swiggy = withExisting.candidates.find((c) => c.merchantKey === 'swiggy')!;
    expect(swiggy.duplicateOf).not.toBeNull();
    expect(swiggy.needsReview).toBe(true);
    expect(withExisting.duplicates).toBe(1);
  });

  it('drops only rows with neither amount nor date', () => {
    const empty = buildCandidates(
      [{ rowIndex: 0, rawText: 'junk', date: null, signedAmount: null, description: 'junk', referenceNo: null, balance: null, confidence: 0.1, warnings: [] }],
      {},
    );
    expect(empty.detected).toBe(0);
    expect(empty.unusable).toBe(1);
  });

  it('produces a ledger where the card payment does not inflate spending', () => {
    // The imported batch contains a 25,000 card payment; it must not count as spend.
    const spendable = result.candidates.filter((c) => c.kind === 'expense' || c.kind === 'cc_charge');
    const total = spendable.reduce((acc, c) => acc + (c.amount ?? 0), 0);
    expect(total).toBe(fromMajor('25847')); // rent 25,000 + swiggy 847
  });
});

describe('review reasons', () => {
  const parsed = parseStatementRows(parseDelimitedText(HDFC_CSV), { today });

  /** What the review screen actually shows: stored reasons plus derived ones. */
  const allReasons = (c: { date: string | null; amount: number | null; categoryId: string | null; reviewReasons: string[] }) => [
    ...deriveReviewReasons({ date: c.date, amount: c.amount as never, categoryId: c.categoryId }),
    ...c.reviewReasons,
  ];
  const result = buildCandidates(parsed.rows, {
    categoryIdForSlug: (slug) => `cat-${slug}`,
    defaultPaymentMethod: 'bank_transfer',
  });

  it('never flags a row without saying why', () => {
    for (const candidate of result.candidates) {
      const reasons = allReasons(candidate);
      if (candidate.needsReview) {
        expect(reasons.length, candidate.description).toBeGreaterThan(0);
      } else {
        expect(reasons, candidate.description).toEqual([]);
      }
    }
  });

  it('does not flag an ordinary categorised bank debit', () => {
    // A plain rent payment with a date, an amount and a matched category is exactly
    // the case a miscalibrated score would flag, training the user to ignore flags.
    const rent = result.candidates.find((c) => c.merchantKey === 'rent');
    expect(rent?.needsReview, rent?.reviewReasons.join('; ')).toBe(false);
  });

  it('flags a row with no category and says so', () => {
    const unknown = buildCandidates(
      parseStatementRows(
        parseDelimitedText('Date,Description,Withdrawal Amt.\n20/08/2026,QWERTY TRADERS 8891,1450.00'),
        { today },
      ).rows,
      { categoryIdForSlug: () => null },
    ).candidates[0]!;
    expect(unknown.needsReview).toBe(true);
    expect(allReasons(unknown).join(' ')).toMatch(/no category/i);
  });

  it('flags a missing date and a missing amount separately', () => {
    const rows = parseStatementRows(
      parseDelimitedText('Date,Description,Withdrawal Amt.\n,MYSTERY MERCHANT,500.00'),
      { today },
    ).rows;
    const candidate = buildCandidates(rows, { categoryIdForSlug: (s) => `cat-${s}` }).candidates[0]!;
    expect(allReasons(candidate).join(' ')).toMatch(/no date/i);
  });

  it('explains a duplicate with its evidence', () => {
    const withExisting = buildCandidates(parsed.rows, {
      categoryIdForSlug: (slug) => `cat-${slug}`,
      existing: [
        {
          id: 'saved-1', date: '2026-08-04', amount: fromMajor('847'), merchantKey: 'swiggy',
          description: 'SWIGGY', referenceNo: null, kind: 'expense', accountId: 'acct-bank',
        },
      ],
    });
    const swiggy = withExisting.candidates.find((c) => c.merchantKey === 'swiggy')!;
    // The wording distinguishes "you already have this" from "this file repeats it",
    // because they call for different decisions from the user.
    expect(swiggy.reviewReasons.join(' ')).toMatch(/already recorded/i);
    expect(swiggy.reviewReasons.join(' ')).toMatch(/same amount/i);
    expect(swiggy.duplicateOf?.source).toBe('existing');
    expect(swiggy.duplicateOf?.matchId).toBe('saved-1');
  });

  it('points a duplicate at the saved transaction it clashes with', () => {
    const withExisting = buildCandidates(parsed.rows, {
      categoryIdForSlug: (slug) => `cat-${slug}`,
      existing: [
        {
          id: 'saved-1', date: '2026-08-04', amount: fromMajor('847'), merchantKey: 'swiggy',
          description: 'SWIGGY', referenceNo: null, kind: 'expense', accountId: 'acct-bank',
        },
      ],
    });
    const swiggy = withExisting.candidates.find((c) => c.merchantKey === 'swiggy')!;
    // Without the id there is nothing to show the user but the word "duplicate".
    expect(swiggy.duplicateOf).not.toBeNull();
    expect(swiggy.needsReview).toBe(true);
  });

  it('names non-merchant kinds usefully instead of leaving rail noise', () => {
    const payment = result.candidates.find((c) => c.kind === 'cc_payment')!;
    expect(payment.merchantName).toBe('Credit card payment');
    const withdrawal = result.candidates.find((c) => c.kind === 'cash_withdrawal')!;
    expect(withdrawal.merchantName).toBe('Cash withdrawal');
  });

  it('scores confidence as the weakest judgement, not the product', () => {
    // A cleanly parsed row with a matched merchant rule should stay well above the
    // review threshold rather than being dragged down by compounding.
    const swiggy = result.candidates.find((c) => c.merchantKey === 'swiggy')!;
    expect(swiggy.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe('derived review reasons', () => {
  it('reports what is missing from a row', () => {
    expect(deriveReviewReasons({ date: null, amount: fromMajor('100'), categoryId: 'cat-1' }))
      .toEqual(['No date — add one before importing']);
    expect(deriveReviewReasons({ date: '2026-08-14', amount: null, categoryId: 'cat-1' }))
      .toEqual(['No amount — add one before importing']);
    expect(deriveReviewReasons({ date: '2026-08-14', amount: fromMajor('100'), categoryId: null }))
      .toEqual(['No category yet — pick one']);
  });

  it('returns nothing once the row is complete — so a fix clears the warning', () => {
    expect(deriveReviewReasons({ date: '2026-08-14', amount: fromMajor('100'), categoryId: 'cat-1' }))
      .toEqual([]);
  });

  it('does not store derivable reasons, so they cannot go stale', () => {
    const uncategorised = buildCandidates(
      parseStatementRows(
        parseDelimitedText('Date,Description,Withdrawal Amt.\n20/08/2026,QWERTY TRADERS 8891,1450.00'),
        { today },
      ).rows,
      { categoryIdForSlug: () => null },
    ).candidates[0]!;

    // Flagged for review…
    expect(uncategorised.needsReview).toBe(true);
    // …but "no category" is not baked into the stored reasons.
    expect(uncategorised.reviewReasons.join(' ')).not.toMatch(/no category/i);
    // It is produced live instead, from the row's own values.
    expect(deriveReviewReasons({
      date: uncategorised.date,
      amount: uncategorised.amount,
      categoryId: uncategorised.categoryId,
    }).join(' ')).toMatch(/no category/i);
  });

  it('still stores reasons that cannot be re-derived', () => {
    const ambiguous = buildCandidates(
      parseStatementRows(
        parseDelimitedText('Date,Description,Amount\n14/08/2026,SWIGGY,847.00'),
        { today },
      ).rows,
      { categoryIdForSlug: (s) => `cat-${s}` },
    ).candidates[0]!;
    expect(ambiguous.reviewReasons.join(' ')).toMatch(/assumed money out/i);
  });
});

describe('remarks on an upload', () => {
  /** A UPI screenshot as OCR actually returns it: an address, an amount, no merchant. */
  const upiRows = parseScreenshotText('Paid to\nq4839201@ybl\n₹180\n26 Aug 2026', { today });

  it('categorises an otherwise unreadable payment from the note', () => {
    const without = buildCandidates(upiRows, { categoryIdForSlug: (s) => `cat-${s}` }).candidates[0]!;
    expect(without.categoryId).toBeNull();

    const withRemark = buildCandidates(upiRows, {
      categoryIdForSlug: (s) => `cat-${s}`,
      remark: 'auto to office',
    }).candidates[0]!;
    expect(withRemark.categoryId).toBe('cat-taxi');
  });

  it('keeps the note on the transaction', () => {
    const candidate = buildCandidates(upiRows, { remark: '  team lunch  ' }).candidates[0]!;
    expect(candidate.notes).toBe('team lunch');
  });

  it('stores no note when none was given', () => {
    expect(buildCandidates(upiRows, {}).candidates[0]!.notes).toBeNull();
    expect(buildCandidates(upiRows, { remark: '   ' }).candidates[0]!.notes).toBeNull();
  });

  it('says when the category came from the note rather than the merchant', () => {
    const candidate = buildCandidates(upiRows, {
      categoryIdForSlug: (s) => `cat-${s}`,
      remark: 'medicines',
    }).candidates[0]!;
    expect(candidate.reviewReasons.join(' ')).toMatch(/from your note/i);
  });

  it('applies the note to every row of a multi-row upload', () => {
    const rows = parseStatementRows(parseDelimitedText(HDFC_CSV), { today }).rows;
    const result = buildCandidates(rows, { remark: 'August statement' });
    expect(result.candidates.every((c) => c.notes === 'August statement')).toBe(true);
  });
});

describe('on-device OCR output', () => {
  /**
   * ML Kit returns an array of recognised lines in reading order, which the import
   * service joins with newlines before parsing. These are the shapes it actually
   * produces for Indian payment screenshots — unordered, with app chrome mixed in.
   */
  const fromMlKit = (lines: string[]) => parseScreenshotText(lines.join('\n'), { today });

  it('reads a Google Pay receipt', () => {
    const rows = fromMlKit([
      '₹1,250',
      'Paid to',
      'AMAZON SELLER SERVICES',
      'Completed',
      '15 Aug 2026',
      'UPI transaction ID 425831947261',
      'Share receipt',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-1250'));
    expect(rows[0]!.date).toBe('2026-08-15');
    expect(rows[0]!.referenceNo).toBe('425831947261');
  });

  it('reads a PhonePe-style receipt where the amount leads', () => {
    const rows = fromMlKit(['₹340', 'Paid to Rapido', '12:41 PM', '26 Aug 2026', 'Success']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-340'));
    expect(rows[0]!.description).toMatch(/rapido/i);
  });

  it('reads money received as a credit', () => {
    const rows = fromMlKit(['₹2,000', 'Received from', 'RAVI KUMAR', '24 Aug 2026']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('2000'));
  });

  it('keeps OCR rows below full confidence so they reach review', () => {
    const rows = fromMlKit(['₹847', 'Paid to SWIGGY', '14 Aug 2026']);
    expect(rows[0]!.confidence).toBeLessThan(0.85);
  });

  it('returns nothing for a screenshot that is not a payment', () => {
    expect(fromMlKit(['Settings', 'Notifications', 'Privacy', 'Help & Support'])).toEqual([]);
  });

  it('survives the noise ML Kit adds — battery, time, status bar', () => {
    const rows = fromMlKit([
      '11:46', '70%', 'Paid to', 'BESCOM', '₹1,842', '26 Aug 2026', 'Completed',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-1842'));
  });
});

describe('direction survives chrome filtering', () => {
  /**
   * Regression: "Paid to" / "Received from" are stripped as labels, but on-device OCR
   * returns them on their own lines and they carry the direction. Reading direction
   * from the filtered text turned a credit into a debit — the worst possible OCR bug,
   * because it silently doubles the apparent damage of an incoming refund.
   */
  it('reads a credit when "Received from" is on its own line', () => {
    const rows = parseScreenshotText(['₹2,000', 'Received from', 'RAVI KUMAR', '24 Aug 2026'].join('\n'), { today });
    expect(rows[0]!.signedAmount).toBe(fromMajor('2000'));
  });

  it('reads a debit when "Paid to" is on its own line', () => {
    const rows = parseScreenshotText(['₹340', 'Paid to', 'RAPIDO', '24 Aug 2026'].join('\n'), { today });
    expect(rows[0]!.signedAmount).toBe(fromMajor('-340'));
  });

  it('still strips the label from the merchant name', () => {
    const rows = parseScreenshotText(['₹340', 'Paid to', 'RAPIDO', '24 Aug 2026'].join('\n'), { today });
    expect(rows[0]!.description).not.toMatch(/paid to/i);
    expect(rows[0]!.description).toMatch(/rapido/i);
  });
});

describe('OCR that lost the rupee symbol', () => {
  /**
   * Reported from a real Google Pay screenshot on a Pixel 7: on-device OCR read the
   * screen but the import found nothing. ML Kit routinely drops the ₹ glyph — it is
   * non-Latin and rendered in app-specific fonts — so a legible "₹250" arrives as a
   * bare "250", which matched none of the amount patterns.
   */
  const gpay = (lines: string[]) => parseScreenshotText(lines.join('\n'), { today });

  it('reads a GPay receipt whose rupee symbol did not survive OCR', () => {
    const rows = gpay(['250', 'Paid to', 'Rahul Kumar', 'Completed', '27 Aug 2026']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-250'));
  });

  it('does not mistake the UPI reference for the amount', () => {
    const rows = gpay(['340', 'Paid to UBER INDIA', '27 Aug 2026', 'UPI transaction ID 425831947261']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-340'));
  });

  it('does not mistake a masked card number for the amount', () => {
    const rows = gpay(['499', 'Paid to SWIGGY', 'From HDFC Bank XXXX1234', '27 Aug 2026']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-499'));
  });

  it('does not mistake the year for the amount', () => {
    const rows = gpay(['180', 'Paid to', 'AUTO', '27 Aug 2026']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-180'));
  });

  it('does not mistake a battery percentage for the amount', () => {
    const rows = gpay(['12:03', '22%', '640', 'Paid to ZOMATO', '27 Aug 2026']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-640'));
  });

  it('prefers a marked amount over bare digits when both are present', () => {
    // The account suffix is bare; the amount carries a symbol. The symbol must win.
    const rows = gpay(['₹847', 'Paid to SWIGGY', 'From account 5521', '27 Aug 2026']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-847'));
  });

  it('still reads a credit when the symbol is missing', () => {
    const rows = gpay(['2000', 'Received from', 'RAVI KUMAR', '27 Aug 2026']);
    expect(rows[0]!.signedAmount).toBe(fromMajor('2000'));
  });

  it('finds nothing in a screen with no numbers at all', () => {
    expect(gpay(['Settings', 'Privacy', 'Help'])).toEqual([]);
  });
});

describe('payee extraction on real receipt layouts', () => {
  const receipt = (lines: string[]) => parseScreenshotText(lines.join('\n'), { today });

  it('takes the name directly beneath "Paid to"', () => {
    const rows = receipt([
      '250', 'Paid to', 'Rahul Kumar', 'Completed', '27 Aug 2026, 12:04 pm',
      'UPI transaction ID 425831947261', 'From HDFC Bank XXXX1234',
    ]);
    expect(rows[0]!.description).toBe('Rahul Kumar');
  });

  it('does not sweep the reference and bank lines into the merchant', () => {
    const rows = receipt([
      '250', 'Paid to', 'Rahul Kumar', 'UPI transaction ID 425831947261', 'From HDFC Bank XXXX1234',
    ]);
    expect(rows[0]!.description).not.toMatch(/UPI|HDFC|XXXX|4258/);
  });

  it('takes the name beneath "Received from" too', () => {
    const rows = receipt(['2000', 'Received from', 'PRIYA S', '27 Aug 2026']);
    expect(rows[0]!.description).toBe('PRIYA S');
    expect(rows[0]!.signedAmount).toBe(fromMajor('2000'));
  });

  it('skips a status word sitting between the label and the name', () => {
    const rows = receipt(['499', 'Paid to', 'Completed', 'SWIGGY', '27 Aug 2026']);
    expect(rows[0]!.description).toBe('SWIGGY');
  });

  it('falls back to the wordiest non-reference line when there is no label', () => {
    const rows = receipt(['₹640', 'ZOMATO ONLINE ORDER', 'Txn 998877665544', '27 Aug 2026']);
    expect(rows[0]!.description).toMatch(/ZOMATO/);
  });

  it('produces a merchant key that groups with the same merchant elsewhere', () => {
    const rows = receipt(['847', 'Paid to', 'SWIGGY', '27 Aug 2026']);
    const candidate = buildCandidates(rows, { categoryIdForSlug: (s) => `cat-${s}` }).candidates[0]!;
    expect(candidate.merchantKey).toBe('swiggy');
    expect(candidate.categoryId).toBe('cat-food_delivery');
  });
});

describe('a real Google Pay receipt', () => {
  /**
   * A GPay receipt in ML Kit's reading order. The identities, account digits and
   * reference numbers are INVENTED — never paste a real receipt in here, it ends up
   * in a public history. The SHAPE is what the parser is being tested against.
   * Reported twice as failing, and it exercises three separate traps at once:
   * the payee label is inline ("To Priya Menon"), a masked phone number sits directly
   * under it, and the funding account carries a four-digit suffix.
   */
  const LINES = [
    'J',
    'To Priya Menon',
    '+91 ••••• •7315',
    '₹120',
    'Pay again',
    'Completed',
    '27 Aug 2026, 10:50 am',
    'Example Bank 4021',
    'UPI transaction ID',
    '100000000001',
    'To: PRIYA MENON R',
    'Google Pay • priyam7315@okaxis',
    'From: SAMPLE USER (Example Bank)',
    'Google Pay • sampleuser@okaxis',
    'Google transaction ID',
    'CICAgExampleId01',
    'POWERED BY UPI',
    'G Pay',
  ];

  const withRupee = () => parseScreenshotText(LINES.join('\n'), { today });
  const rupeeLost = () =>
    parseScreenshotText(LINES.map((l) => (l === '₹120' ? '120' : l)).join('\n'), { today });

  it('reads exactly one payment when the rupee symbol survives', () => {
    const rows = withRupee();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-120'));
    expect(rows[0]!.date).toBe('2026-08-27');
    expect(rows[0]!.description).toBe('Priya Menon');
  });

  it('reads the same payment when OCR loses the rupee symbol', () => {
    const rows = rupeeLost();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedAmount).toBe(fromMajor('-120'));
    expect(rows[0]!.description).toBe('Priya Menon');
  });

  it('never invents a payment from the phone number', () => {
    for (const rows of [withRupee(), rupeeLost()]) {
      expect(rows.map((r) => r.signedAmount)).not.toContain(fromMajor('-7315'));
    }
  });

  it('never invents a payment from the funding account number', () => {
    for (const rows of [withRupee(), rupeeLost()]) {
      expect(rows.map((r) => r.signedAmount)).not.toContain(fromMajor('-4021'));
    }
  });

  it('never treats one receipt as several transactions', () => {
    expect(withRupee()).toHaveLength(1);
    expect(rupeeLost()).toHaveLength(1);
  });

  it('does not put the reference or the VPA in the merchant name', () => {
    const desc = withRupee()[0]!.description;
    expect(desc).not.toMatch(/okaxis|100000|Example|UPI|transaction/i);
  });
});

describe('a category chosen at upload time', () => {
  // A real shop name with no category word anywhere in it — the common case for a
  // neighbourhood store. ("Kirana" and "supermarket" ARE in the vocabulary; an
  // arbitrary trading name is not, and never can be.)
  const rows = parseScreenshotText(
    ['180', 'Paid to', 'SADIK TRADERS', '27 Aug 2026'].join('\n'),
    { today },
  );

  it('cannot be guessed from an arbitrary shop name', () => {
    const guessed = buildCandidates(rows, {
      categoryIdForSlug: (s) => `cat-${s}`,
      remark: 'Sadik Traders',
    }).candidates[0]!;
    expect(guessed.categoryId).toBeNull();
    expect(guessed.needsReview).toBe(true);
  });

  it('is used when the user picks one', () => {
    const chosen = buildCandidates(rows, {
      categoryIdForSlug: (s) => `cat-${s}`,
      remark: 'Sadik Traders',
      categoryId: 'cat-groceries',
    }).candidates[0]!;
    expect(chosen.categoryId).toBe('cat-groceries');
    expect(chosen.needsReview).toBe(false);
  });

  it('outranks a merchant rule, because the user is not guessing', () => {
    const swiggy = parseScreenshotText(['847', 'Paid to', 'SWIGGY', '27 Aug 2026'].join('\n'), { today });
    const chosen = buildCandidates(swiggy, {
      categoryIdForSlug: (s) => `cat-${s}`,
      categoryId: 'cat-groceries',
    }).candidates[0]!;
    expect(chosen.categoryId).toBe('cat-groceries');
  });

  it('outranks a keyword match in the note', () => {
    const chosen = buildCandidates(rows, {
      categoryIdForSlug: (s) => `cat-${s}`,
      remark: 'lunch',
      categoryId: 'cat-groceries',
    }).candidates[0]!;
    expect(chosen.categoryId).toBe('cat-groceries');
    // …and does not claim the note decided it.
    expect(chosen.reviewReasons.join(' ')).not.toMatch(/from your note/i);
  });

  it('still applies the note as the transaction note', () => {
    const chosen = buildCandidates(rows, {
      remark: 'Sadik Traders',
      categoryId: 'cat-groceries',
    }).candidates[0]!;
    expect(chosen.notes).toBe('Sadik Traders');
  });

  it('leaves the row uncategorised when nothing is chosen or matched', () => {
    const none = buildCandidates(rows, { categoryIdForSlug: () => null }).candidates[0]!;
    expect(none.categoryId).toBeNull();
    expect(
      deriveReviewReasons({ date: none.date, amount: none.amount, categoryId: none.categoryId })
        .join(' '),
    ).toMatch(/no category/i);
  });
});

describe('merchant names that look like currency', () => {
  /**
   * Regression: `Rs` had no word boundary, so "TRADE**RS** 27" parsed as ₹27. That
   * convinced the parser it had found a currency-marked amount, which disabled the
   * bare-number fallback and made the whole receipt read as empty. Every merchant
   * ending in "rs" hit it.
   */
  const receipt = (payee: string) =>
    parseScreenshotText(['180', 'Paid to', payee, '27 Aug 2026'].join('\n'), { today });

  it.each(['SADIK TRADERS', 'ARORA MOTORS', 'CITY STORES', 'RELIANCE MOBILES'])(
    'reads the payment at %s',
    (payee) => {
      const rows = receipt(payee);
      expect(rows, payee).toHaveLength(1);
      expect(rows[0]!.signedAmount).toBe(fromMajor('-180'));
      expect(rows[0]!.description).toBe(payee);
    },
  );

  it('still reads a genuine Rs-prefixed amount', () => {
    const rows = parseScreenshotText(['Rs 450', 'Paid to', 'SADIK TRADERS', '27 Aug 2026'].join('\n'), { today });
    expect(rows[0]!.signedAmount).toBe(fromMajor('-450'));
  });

  it('still reads a genuine INR-prefixed amount', () => {
    const rows = parseScreenshotText(['INR 1200', 'Paid to', 'CITY STORES', '27 Aug 2026'].join('\n'), { today });
    expect(rows[0]!.signedAmount).toBe(fromMajor('-1200'));
  });
});
