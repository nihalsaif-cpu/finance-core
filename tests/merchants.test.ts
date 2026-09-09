import { describe, it, expect } from 'vitest';
import * as M from '../src/merchants';

describe('normalizeMerchantName', () => {
  it('strips UPI rail noise down to the merchant', () => {
    expect(M.normalizeMerchantName('UPI/DR/425831947261/SWIGGY/YESB/swiggyupi@ybl/Pay')).toBe('Swiggy');
    expect(M.normalizeMerchantName('UPI-ZOMATO LTD-zomato@paytm-987654321')).toBe('Zomato');
  });

  it('strips POS and card noise', () => {
    expect(M.normalizeMerchantName('POS 4412XXXXXX9021 SWIGGY INSTAMART BANGALORE IN')).toBe('Swiggy Instamart');
    expect(M.normalizeMerchantName('NEFT DR-HDFC0001234-AMAZON SELLER SERVICES PVT LTD')).toContain('Amazon');
  });

  it('title-cases and keeps known acronyms', () => {
    expect(M.normalizeMerchantName('HDFC BANK CHARGES')).toContain('HDFC');
    expect(M.normalizeMerchantName('irctc web booking')).toBe('IRCTC Web Booking');
  });

  it('never returns empty for a non-empty input', () => {
    expect(M.normalizeMerchantName('12345678901')).not.toBe('');
    expect(M.normalizeMerchantName('')).toBe('');
  });
});

describe('merchantKey', () => {
  it('collapses variations of the same merchant to one key', () => {
    const variants = [
      'UPI/DR/425831947261/SWIGGY/YESB/swiggyupi@ybl/Pay',
      'SWIGGY BANGALORE',
      'swiggy',
      'POS SWIGGY IN',
    ];
    const keys = new Set(variants.map(M.merchantKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('swiggy');
  });

  it('keeps genuinely different merchants apart', () => {
    expect(M.merchantKey('SWIGGY')).not.toBe(M.merchantKey('SWIGGY INSTAMART'));
    expect(M.merchantKey('AMAZON')).not.toBe(M.merchantKey('AMAZON PAY'));
  });

  it('falls back to a stable key for unparseable input', () => {
    expect(M.merchantKey('')).toBe('unknown');
  });
});

describe('suggestCategory', () => {
  const slugToId = (slug: string) => `cat-${slug}`;

  it('categorises the merchants named in the brief', () => {
    const cases: Array<[string, string]> = [
      ['SWIGGY', 'food_delivery'],
      ['ZOMATO ORDER', 'food_delivery'],
      ['UBER TRIP', 'taxi'],
      ['OLA CABS', 'taxi'],
      ['AMAZON', 'online_shopping'],
      ['NETFLIX.COM', 'streaming'],
      ['SPOTIFY INDIA', 'streaming'],
    ];
    for (const [description, slug] of cases) {
      const s = M.suggestCategory(description, { categoryIdForSlug: slugToId });
      expect(s.categorySlug, description).toBe(slug);
      expect(s.categoryId).toBe(`cat-${slug}`);
      expect(s.source).toBe('built_in_rule');
    }
  });

  it('prefers the more specific rule', () => {
    expect(M.suggestCategory('SWIGGY INSTAMART').categorySlug).toBe('groceries');
    expect(M.suggestCategory('SWIGGY').categorySlug).toBe('food_delivery');
  });

  it('flags subscription-like merchants as likely recurring', () => {
    expect(M.suggestCategory('NETFLIX').likelyRecurring).toBe(true);
    expect(M.suggestCategory('SWIGGY').likelyRecurring).toBe(false);
  });

  it('returns a low-confidence miss for unknown merchants', () => {
    const s = M.suggestCategory('QWERTY TRADERS 8891');
    expect(s.source).toBe('none');
    expect(s.categoryId).toBeNull();
    expect(M.needsReview(s.confidence)).toBe(true);
  });

  it('marks rule matches as confident enough to auto-accept', () => {
    expect(M.needsReview(M.suggestCategory('SWIGGY').confidence)).toBe(false);
  });
});

describe('learning from corrections', () => {
  it('remembers a user moving Amazon to Electronics', () => {
    const key = M.merchantKey('AMAZON');
    let mappings = M.learnMapping([], { merchantKey: key, categoryId: 'cat-electronics', displayName: 'Amazon' });

    const suggestion = M.suggestCategory('AMAZON ORDER 402-1234', {
      userMappings: mappings,
      categoryIdForSlug: (s) => `cat-${s}`,
    });
    expect(suggestion.categoryId).toBe('cat-electronics');
    expect(suggestion.source).toBe('user_mapping');
    expect(suggestion.confidence).toBeGreaterThan(M.REVIEW_THRESHOLD);
  });

  it('grows confidence as the user reconfirms', () => {
    const key = 'amazon';
    let mappings = M.learnMapping([], { merchantKey: key, categoryId: 'cat-electronics' });
    const first = M.suggestCategory('AMAZON', { userMappings: mappings }).confidence;
    mappings = M.learnMapping(mappings, { merchantKey: key, categoryId: 'cat-electronics' });
    mappings = M.learnMapping(mappings, { merchantKey: key, categoryId: 'cat-electronics' });
    expect(mappings[0]!.confirmations).toBe(3);
    expect(M.suggestCategory('AMAZON', { userMappings: mappings }).confidence).toBeGreaterThan(first);
  });

  it('resets confidence when the user changes their mind', () => {
    let mappings = M.learnMapping([], { merchantKey: 'amazon', categoryId: 'cat-electronics' });
    mappings = M.learnMapping(mappings, { merchantKey: 'amazon', categoryId: 'cat-electronics' });
    mappings = M.learnMapping(mappings, { merchantKey: 'amazon', categoryId: 'cat-groceries' });
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ categoryId: 'cat-groceries', confirmations: 1 });
  });

  it('keeps mappings for other merchants untouched', () => {
    let mappings = M.learnMapping([], { merchantKey: 'swiggy', categoryId: 'cat-food' });
    mappings = M.learnMapping(mappings, { merchantKey: 'amazon', categoryId: 'cat-electronics' });
    expect(mappings).toHaveLength(2);
    expect(mappings.find((m) => m.merchantKey === 'swiggy')?.categoryId).toBe('cat-food');
  });
});

describe('merchant key stability across real description shapes', () => {
  it('groups the same merchant despite order ids and store numbers', () => {
    const keys = ['AMAZON', 'AMAZON ORDER 402-1234', 'AMAZON IN'].map((d) => M.candidateKeys(d));
    // Every variant offers "amazon" as a candidate key.
    for (const list of keys) expect(list).toContain('amazon');
  });

  it('prefers the most specific stored mapping', () => {
    const mappings = [
      { merchantKey: 'swiggy', categoryId: 'cat-food_delivery', confirmations: 5 },
      { merchantKey: 'swiggyinstamart', categoryId: 'cat-groceries', confirmations: 1 },
    ];
    expect(M.suggestCategory('SWIGGY INSTAMART', { userMappings: mappings }).categoryId).toBe('cat-groceries');
    expect(M.suggestCategory('SWIGGY ORDER 8891', { userMappings: mappings }).categoryId).toBe('cat-food_delivery');
  });

  it('keeps Amazon Pay distinct from Amazon', () => {
    expect(M.merchantKey('AMAZON PAY')).toBe('amazonpay');
    expect(M.merchantKey('AMAZON')).toBe('amazon');
  });

  it('handles a realistic mixed batch without collapsing everything to one key', () => {
    const descriptions = [
      'UPI/DR/425831947261/SWIGGY/YESB/swiggyupi@ybl/Pay',
      'UPI/DR/512398471023/ZOMATO/HDFC/zomato@paytm/Pay',
      'POS 4412XXXXXX9021 UBER INDIA SYSTEMS BANGALORE IN',
      'NEFT DR-HDFC0001234-AMAZON SELLER SERVICES PVT LTD',
      'ACH DR NETFLIX ENTERTAINMENT SERVICES',
    ];
    const keys = descriptions.map(M.merchantKey);
    expect(new Set(keys).size).toBe(5);
    expect(keys[0]).toBe('swiggy');
    expect(keys[1]).toBe('zomato');
    expect(keys[2]).toContain('uber');
    expect(keys[4]).toContain('netflix');
  });
});

describe('categoryFromRemark', () => {
  it('reads the common things people write about a payment', () => {
    const cases: Array<[string, string]> = [
      ['team lunch', 'restaurants'],
      ['auto to office', 'taxi'],
      ['petrol', 'fuel'],
      ['monthly groceries', 'groceries'],
      ['medicines for mom', 'medicine'],
      ['electricity bill', 'electricity'],
      ['mobile recharge', 'mobile'],
      ['movie tickets', 'entertainment'],
      ['house rent', 'rent'],
      ['gym membership', 'gym'],
      ['maid salary', 'household_help'],
      ['snacks', 'coffee_snacks'],
      ['vegetables', 'groceries'],
      ['bought books', 'courses'],
    ];
    for (const [remark, slug] of cases) {
      expect(M.categoryFromRemark(remark)?.categorySlug, remark).toBe(slug);
    }
  });

  it('says nothing when the note says nothing useful', () => {
    expect(M.categoryFromRemark('paid')).toBeNull();
    expect(M.categoryFromRemark('')).toBeNull();
    expect(M.categoryFromRemark('   ')).toBeNull();
  });

  it('reports the words it matched, so the app can explain itself', () => {
    expect(M.categoryFromRemark('had dinner with friends')?.matched).toBe('dinner');
  });

  it('does not match a word buried inside another word', () => {
    // "auto" must not fire on "automatic"; that would file a subscription as a taxi.
    expect(M.categoryFromRemark('automatic payment')?.categorySlug).not.toBe('taxi');
  });
});

describe('remarks in categorisation', () => {
  const slugToId = (slug: string) => `cat-${slug}`;

  it('rescues a UPI payment that has no readable merchant', () => {
    // Exactly the case screenshots produce: a virtual address and nothing else.
    const withoutRemark = M.suggestCategory('q4839201@ybl', { categoryIdForSlug: slugToId });
    expect(withoutRemark.categoryId).toBeNull();

    const withRemark = M.suggestCategory('q4839201@ybl', {
      categoryIdForSlug: slugToId,
      remark: 'auto to office',
    });
    expect(withRemark.categoryId).toBe('cat-taxi');
    expect(withRemark.source).toBe('remark');
    expect(withRemark.reason).toMatch(/your note/i);
  });

  it('does not let a note override a confident merchant match', () => {
    // Typing "swiggy order" as a note must not recategorise Swiggy itself.
    const s = M.suggestCategory('SWIGGY', { categoryIdForSlug: slugToId, remark: 'dinner' });
    expect(s.categorySlug).toBe('food_delivery');
    expect(s.source).toBe('built_in_rule');
  });

  it('does not let a note override the user’s own learned mapping', () => {
    const s = M.suggestCategory('AMAZON', {
      categoryIdForSlug: slugToId,
      userMappings: [{ merchantKey: 'amazon', categoryId: 'cat-electronics', confirmations: 3 }],
      remark: 'groceries',
    });
    expect(s.categoryId).toBe('cat-electronics');
    expect(s.source).toBe('user_mapping');
  });

  it('trusts a remark less than a matched merchant', () => {
    const fromRemark = M.suggestCategory('q4839201@ybl', { remark: 'lunch' });
    const fromMerchant = M.suggestCategory('SWIGGY');
    expect(fromRemark.confidence).toBeLessThan(fromMerchant.confidence);
    // …but still confident enough not to demand review.
    expect(M.needsReview(fromRemark.confidence)).toBe(false);
  });
});
