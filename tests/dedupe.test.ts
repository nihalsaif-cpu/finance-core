import { describe, it, expect } from 'vitest';
import * as D from '../src/dedupe';
import { fromMajor } from '../src/money';
import type { DuplicateCandidate } from '../src/dedupe';

const row = (o: Partial<DuplicateCandidate> & { id: string }): DuplicateCandidate => ({
  date: '2026-08-15',
  amount: fromMajor('1250'),
  merchantKey: 'amazon',
  description: 'AMAZON ORDER',
  referenceNo: null,
  kind: 'expense',
  accountId: 'acct-bank',
  ...o,
});

describe('the brief’s duplicate example', () => {
  it('flags two identical ₹1,250 Amazon rows on 15 Aug as a possible duplicate', () => {
    const matches = D.findDuplicatesWithin([row({ id: 'a' }), row({ id: 'b' })]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.candidateId).toBe('b');
    expect(matches[0]!.matchId).toBe('a');
    expect(matches[0]!.reasons).toEqual(expect.arrayContaining(['Same amount', 'Same date', 'Same merchant']));
  });

  it('does not claim certainty without a reference number, because repeats are real', () => {
    const matches = D.findDuplicatesWithin([row({ id: 'a' }), row({ id: 'b' })]);
    expect(matches[0]!.confidence).not.toBe('certain');
    expect(D.describeMatch(matches[0]!)).toMatch(/duplicate/i);
  });
});

describe('reference numbers', () => {
  it('treats a shared reference number as conclusive', () => {
    const matches = D.findDuplicatesWithin([
      row({ id: 'a', referenceNo: 'UTR123456789', date: '2026-08-15' }),
      row({ id: 'b', referenceNo: 'utr-123456789', date: '2026-08-17', amount: fromMajor('999') }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe('certain');
    expect(matches[0]!.score).toBe(1);
  });

  it('treats differing reference numbers as proof they are different events', () => {
    const matches = D.findDuplicatesWithin([
      row({ id: 'a', referenceNo: 'UTR111111111' }),
      row({ id: 'b', referenceNo: 'UTR222222222' }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('ignores references too short to be unique', () => {
    const matches = D.findDuplicatesWithin([
      row({ id: 'a', referenceNo: '001' }),
      row({ id: 'b', referenceNo: '002' }),
    ]);
    // Falls back to amount/date/merchant scoring rather than trusting the stub refs.
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).not.toBe('certain');
  });
});

describe('false positives', () => {
  it('does not flag different amounts', () => {
    expect(D.findDuplicatesWithin([row({ id: 'a' }), row({ id: 'b', amount: fromMajor('1251') })])).toHaveLength(0);
  });

  it('does not flag the same amount at demonstrably different merchants', () => {
    const matches = D.findDuplicatesWithin([
      row({ id: 'a', merchantKey: 'swiggy', description: 'SWIGGY' }),
      row({ id: 'b', merchantKey: 'zomato', description: 'ZOMATO' }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('does not flag rows outside the date window', () => {
    expect(
      D.findDuplicatesWithin([row({ id: 'a', date: '2026-08-01' }), row({ id: 'b', date: '2026-08-20' })]),
    ).toHaveLength(0);
  });

  it('never treats a refund as a duplicate of the purchase it reverses', () => {
    const matches = D.findDuplicatesWithin([
      row({ id: 'a', kind: 'expense' }),
      row({ id: 'b', kind: 'refund' }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('does not flag a monthly subscription across cycles', () => {
    const matches = D.findDuplicatesWithin([
      row({ id: 'a', merchantKey: 'netflix', description: 'NETFLIX', date: '2026-07-15', amount: fromMajor('649') }),
      row({ id: 'b', merchantKey: 'netflix', description: 'NETFLIX', date: '2026-08-15', amount: fromMajor('649') }),
    ]);
    expect(matches).toHaveLength(0);
  });
});

describe('matching against saved transactions', () => {
  const existing = [row({ id: 'saved-1' }), row({ id: 'saved-2', amount: fromMajor('500'), merchantKey: 'swiggy', description: 'SWIGGY' })];

  it('flags a re-imported statement row against the saved copy', () => {
    const matches = D.findDuplicatesAgainstExisting([row({ id: 'new-1' })], existing);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchId).toBe('saved-1');
  });

  it('matches each saved transaction at most once, so a genuine repeat survives', () => {
    // Two real ₹1,250 Amazon purchases on the same day; only one was already saved.
    const matches = D.findDuplicatesAgainstExisting([row({ id: 'new-1' }), row({ id: 'new-2' })], existing);
    expect(matches).toHaveLength(1);
  });

  it('runs both passes and reports every flagged row', () => {
    const result = D.detectDuplicates([row({ id: 'new-1' }), row({ id: 'new-2' }), row({ id: 'new-3' })], existing);
    expect(result.againstExisting).toHaveLength(1);
    expect(result.withinImport).toHaveLength(1);
    expect(result.flaggedIds.size).toBe(2);
    // One of the three is genuinely new and stays unflagged.
    expect(result.flaggedIds.has('new-1')).toBe(true);
  });
});

describe('descriptionSimilarity', () => {
  it('scores overlapping descriptions', () => {
    expect(D.descriptionSimilarity('SWIGGY ORDER BANGALORE', 'SWIGGY ORDER BANGALORE')).toBe(1);
    expect(D.descriptionSimilarity('SWIGGY ORDER', 'ZOMATO PAYMENT')).toBe(0);
    expect(D.descriptionSimilarity('AMAZON SELLER SERVICES', 'AMAZON SELLER')).toBeGreaterThan(0.5);
  });

  it('returns 0 rather than NaN for empty input', () => {
    expect(D.descriptionSimilarity('', '')).toBe(0);
  });
});
