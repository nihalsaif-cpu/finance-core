/**
 * Merchant normalisation and rule-based categorisation.
 *
 * Bank descriptions are hostile: "UPI/DR/425831947261/SWIGGY/YESB/swiggyupi@ybl/Pay"
 * and "POS 4412XXXXXX9021 SWIGGY INSTAMART BANGALORE IN" are the same merchant. We
 * strip the transport noise, extract a canonical key, and match against rules.
 *
 * Deterministic rules run first and are sufficient for the overwhelming majority of
 * real transactions. AI categorisation is deliberately NOT the default path: it costs
 * money per transaction, is non-reproducible, and would be doing worse than a regex
 * for "SWIGGY". `suggestCategory` returns a confidence score, so an AI layer can later
 * be attached to exactly the residue the rules cannot resolve.
 */

import type { PaymentMethod, UUID } from './types';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Structured noise removed before tokenising: UPI virtual addresses, IFSC codes,
 * masked card numbers, long reference numbers.
 */
const STRUCTURED_NOISE: RegExp[] = [
  /[a-z0-9._-]+@[a-z]{2,}/gi, // UPI VPA: swiggyupi@ybl
  /\b[a-z]{4}0[a-z0-9]{6}\b/gi, // IFSC: HDFC0001234
  /\b(?:x{2,}|\*{2,})\d{2,}\b/gi, // XXXX1234
  /\b\d{2,}(?:x{2,}|\*{2,})\d{2,}\b/gi, // 4412XXXXXX9021
  /\b\d{8,}\b/g, // long reference numbers
];

/**
 * Payment-rail vocabulary. These words describe how money moved, never who was paid,
 * so they are dropped at word level wherever they appear.
 */
const RAIL_WORDS = new Set([
  'UPI', 'IMPS', 'NEFT', 'RTGS', 'POS', 'ATM', 'ACH', 'ECS', 'NACH', 'MMT', 'INB',
  'TPT', 'VPS', 'MPS', 'BIL', 'DR', 'CR', 'PAYMENT', 'PAYMENTS', 'PAID',
  'PURCHASE', 'TXN', 'TRXN', 'TRANSACTION', 'REF', 'RRN', 'UTR', 'AUTH', 'APPR',
  'APPROVAL', 'TRACE', 'SEQ', 'TO', 'FROM', 'VIA', 'BY', 'ON', 'AT', 'OF', 'THE',
  'NO', 'NA', 'DEBIT', 'CREDIT', 'TRANSFER', 'TRF', 'WDL', 'INF', 'MB', 'IB',
]);

/**
 * Words that are rail noise only when they stand alone as a whole segment. "Pay" at
 * the end of a UPI string is a rail marker; "Amazon Pay" is a different merchant from
 * "Amazon", so the word cannot be stripped unconditionally.
 */
const SEGMENT_ONLY_RAIL_WORDS = new Set(['PAY', 'PAYTM', 'GPAY', 'PHONEPE', 'BHIM']);

/** Corporate suffixes that add length but no identity. */
const CORP_WORDS = new Set([
  'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'INC', 'CORP', 'CORPORATION', 'CO',
  'COMPANY', 'TECHNOLOGIES', 'TECHNOLOGY', 'TECH', 'SOLUTIONS', 'SERVICES',
  'SERVICE', 'ENTERPRISES', 'ENTERPRISE', 'INDUSTRIES', 'VENTURES', 'GROUP',
]);

/** Place names that trail POS descriptors. */
const PLACE_WORDS = new Set([
  'IN', 'IND', 'INDIA', 'BLR', 'BANGALORE', 'BENGALURU', 'MUMBAI', 'DELHI',
  'NEWDELHI', 'CHENNAI', 'HYDERABAD', 'PUNE', 'KOLKATA', 'NOIDA', 'GURGAON',
  'GURUGRAM', 'JAIPUR', 'KOCHI', 'ERNAKULAM', 'TRIVANDRUM', 'AHMEDABAD',
  'CHANDIGARH', 'LUCKNOW', 'INDORE', 'NAGPUR', 'COIMBATORE',
]);

/**
 * Bank/PSP handle codes. Dropped ONLY when a whole segment is nothing but the code
 * (as in ".../SWIGGY/YESB/..."), never when it is part of a longer phrase — otherwise
 * "HDFC BANK CHARGES" would lose the only word that identifies it.
 */
const BANK_CODES = new Set([
  'YESB', 'YBL', 'OKAXIS', 'OKHDFCBANK', 'OKSBI', 'OKICICI', 'IBL', 'APL', 'PYTM',
  'UTIB', 'KKBK', 'ICIC', 'ICICI', 'SBIN', 'HDFC', 'AXIS', 'AXL', 'IDFB', 'PUNB',
  'CNRB', 'BARB', 'INDB', 'KARB', 'FDRL', 'RATN', 'DBSS', 'SCBL', 'CITI', 'HSBC',
  'AIRP', 'FBL', 'JUPAXIS', 'SLICE', 'WAAXIS',
]);

const ALL_CAPS_KEEP = new Set([
  'UPI', 'ATM', 'EMI', 'SIP', 'HDFC', 'ICICI', 'SBI', 'IRCTC', 'BSNL', 'LIC', 'PVR',
  'KFC', 'DTH', 'NPS', 'PPF', 'RD', 'FD', 'IT', 'GST', 'TDS', 'HP', 'IOCL', 'BPCL',
]);

/** A token carries identity only if it contains at least one letter. */
function hasLetters(token: string): boolean {
  return /[A-Z]/.test(token);
}

/**
 * Split a raw description into meaningful merchant tokens (uppercase).
 *
 * Descriptions are structured as slash- or pipe-separated segments, each of which is
 * either the merchant, a rail marker, a bank handle, or a reference. We evaluate
 * segments independently and keep the one that most looks like a merchant name,
 * rather than concatenating everything and hoping the regexes caught it all.
 */
export function merchantTokens(raw: string): string[] {
  if (!raw) return [];
  let s = String(raw);
  for (const pattern of STRUCTURED_NOISE) s = s.replace(pattern, ' ');
  s = s.toUpperCase();

  const segments = s.split(/[/|\\]+/);
  const candidates: string[][] = [];

  for (const segment of segments) {
    const words = segment
      .split(/[^A-Z0-9&'.]+/)
      .map((w) => w.replace(/^[.]+|[.]+$/g, ''))
      .filter(Boolean)
      .filter((w) => w.length > 1)
      .filter(hasLetters)
      .filter((w) => !RAIL_WORDS.has(w) && !CORP_WORDS.has(w) && !PLACE_WORDS.has(w));

    if (words.length === 0) continue;
    // A segment that is nothing but a bank handle or a rail verb identifies how the
    // money moved, not who was paid.
    if (words.length === 1 && (BANK_CODES.has(words[0]!) || SEGMENT_ONLY_RAIL_WORDS.has(words[0]!))) continue;
    candidates.push(words);
  }

  if (candidates.length === 0) return [];
  // Prefer the segment carrying the most alphabetic content — the merchant name is
  // almost always the wordiest part of the string.
  let best = candidates[0]!;
  let bestScore = -1;
  for (const words of candidates) {
    const score = words.join('').replace(/[^A-Z]/g, '').length;
    if (score > bestScore) {
      bestScore = score;
      best = words;
    }
  }
  return best.slice(0, 4);
}

/**
 * Human-readable merchant name.
 * "UPI/DR/4258319/SWIGGY/YESB/swiggy@ybl/Pay" → "Swiggy"
 */
export function normalizeMerchantName(raw: string): string {
  const tokens = merchantTokens(raw);
  if (tokens.length === 0) {
    const fallback = String(raw ?? '').trim().slice(0, 40);
    return fallback ? titleCase(fallback) : '';
  }
  return titleCase(tokens.join(' '));
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ALL_CAPS_KEEP.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ')
    .trim();
}

/**
 * Canonical grouping key: the merchant tokens, lowercased and concatenated.
 * Every description of the same merchant must produce the same key, because rollups,
 * merchant rules and "you ordered from X 11 times" all group on it.
 */
export function merchantKey(raw: string): string {
  const tokens = merchantTokens(raw);
  const key = tokens.join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key || 'unknown';
}

/**
 * Progressively shorter keys for the same description, longest first:
 * "AMAZON ORDER 402" → ['amazonorder', 'amazon'].
 *
 * Merchants append order ids, store numbers and city names, so an exact key match
 * alone would fail to reuse a mapping the user has already made. Matching the longest
 * candidate first keeps a specific mapping ("swiggyinstamart") ahead of a general one
 * ("swiggy").
 */
export function candidateKeys(raw: string): string[] {
  const tokens = merchantTokens(raw);
  if (tokens.length === 0) return ['unknown'];
  const keys: string[] = [];
  for (let i = tokens.length; i > 0; i--) {
    const key = tokens.slice(0, i).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key) keys.push(key);
  }
  return keys.length > 0 ? keys : ['unknown'];
}

// ---------------------------------------------------------------------------
// Built-in merchant rules
// ---------------------------------------------------------------------------

export interface MerchantRule {
  /** Matched against the normalised key and the raw description. */
  match: RegExp;
  /** Canonical display name. */
  name: string;
  /** Category slug from `categories.ts`. */
  categorySlug: string;
  /** Overrides the category's classification when the merchant is unambiguous. */
  isEssential?: boolean;
  /** Nudges the payment method when the merchant implies one. */
  paymentMethod?: PaymentMethod;
  /** Merchants that are almost always subscriptions. */
  likelyRecurring?: boolean;
}

/**
 * Ordered rules — the first match wins, so put specific rules above general ones
 * ("swiggy instamart" is groceries; plain "swiggy" is food delivery).
 */
export const BUILT_IN_RULES: MerchantRule[] = [
  // Food delivery & groceries
  { match: /swiggy\s*instamart|instamart/i, name: 'Swiggy Instamart', categorySlug: 'groceries' },
  { match: /zepto|blinkit|grofers|bigbasket|dunzo|jiomart|dmart|d\s*mart|more\s*retail|reliance\s*fresh|licious|country\s*delight/i, name: 'Groceries', categorySlug: 'groceries' },
  { match: /swiggy/i, name: 'Swiggy', categorySlug: 'food_delivery' },
  { match: /zomato|eatsure|faasos|behrouz|ovenstory|box8|freshmenu/i, name: 'Zomato', categorySlug: 'food_delivery' },
  { match: /dominos|pizza\s*hut|mcdonald|kfc|burger\s*king|subway|wow\s*momo|haldiram/i, name: 'Restaurant', categorySlug: 'restaurants' },
  { match: /starbucks|cafe\s*coffee|ccd|chaayos|blue\s*tokai|third\s*wave|barista|costa\s*coffee/i, name: 'Coffee', categorySlug: 'coffee_snacks' },

  // Transport
  { match: /\buber\b/i, name: 'Uber', categorySlug: 'taxi' },
  { match: /\bola\b|olacabs|ola\s*money/i, name: 'Ola', categorySlug: 'taxi' },
  { match: /rapido|blusmart|meru/i, name: 'Rapido', categorySlug: 'taxi' },
  { match: /irctc|indian\s*rail|redbus|abhibus/i, name: 'IRCTC', categorySlug: 'public_transport' },
  { match: /namma\s*metro|dmrc|metro\s*rail|bmtc|best\s*undertaking/i, name: 'Metro', categorySlug: 'public_transport' },
  { match: /indian\s*oil|iocl|bharat\s*petroleum|bpcl|hindustan\s*petroleum|hpcl|shell|reliance\s*petro|nayara|fuel|petrol\s*pump/i, name: 'Fuel', categorySlug: 'fuel' },
  { match: /fastag|paytm\s*fastag|toll|parking/i, name: 'FASTag / Tolls', categorySlug: 'parking' },

  // Shopping
  { match: /amazon\s*pay|amazonpay/i, name: 'Amazon Pay', categorySlug: 'online_shopping' },
  { match: /amazon|amzn/i, name: 'Amazon', categorySlug: 'online_shopping' },
  { match: /flipkart|myntra|ajio|meesho|nykaa|tatacliq|snapdeal|shopsy/i, name: 'Online Shopping', categorySlug: 'online_shopping' },
  { match: /croma|reliance\s*digital|vijay\s*sales|apple\s*store|imagine\s*store/i, name: 'Electronics', categorySlug: 'electronics' },
  { match: /zara|h\s*&\s*m|uniqlo|westside|lifestyle\s*store|shoppers\s*stop|pantaloons|max\s*fashion|decathlon/i, name: 'Clothing', categorySlug: 'clothing' },
  { match: /ikea|urban\s*ladder|pepperfry|home\s*centre|nilkamal/i, name: 'Home', categorySlug: 'personal_items' },

  // Subscriptions & bills
  { match: /netflix/i, name: 'Netflix', categorySlug: 'streaming', likelyRecurring: true },
  { match: /spotify|gaana|wynk|apple\s*music|youtube\s*premium|jiosaavn/i, name: 'Music Streaming', categorySlug: 'streaming', likelyRecurring: true },
  { match: /hotstar|disney|prime\s*video|sonyliv|zee5|jiocinema|aha\b/i, name: 'Video Streaming', categorySlug: 'streaming', likelyRecurring: true },
  { match: /google\s*(?:one|storage|cloud)|icloud|dropbox|adobe|notion|figma|github|openai|anthropic|claude|microsoft\s*365|office\s*365|canva|jetbrains/i, name: 'Software', categorySlug: 'software', likelyRecurring: true },
  { match: /airtel|jio\b|vodafone|\bvi\b|bsnl|reliance\s*jio/i, name: 'Mobile / Broadband', categorySlug: 'mobile', isEssential: true, likelyRecurring: true },
  { match: /act\s*fibernet|hathway|excitel|tikona|spectra/i, name: 'Broadband', categorySlug: 'internet', isEssential: true, likelyRecurring: true },
  { match: /bescom|tneb|mseb|adani\s*electricity|tata\s*power|torrent\s*power|electricity\s*board|kseb/i, name: 'Electricity', categorySlug: 'electricity', isEssential: true, likelyRecurring: true },
  { match: /\blic\b|hdfc\s*life|icici\s*pru|max\s*life|star\s*health|niva\s*bupa|policy\s*bazaar|acko|digit\s*insurance/i, name: 'Insurance', categorySlug: 'insurance', isEssential: true, likelyRecurring: true },
  { match: /cult\s*fit|cultfit|gold'?s\s*gym|anytime\s*fitness|gym\b/i, name: 'Gym', categorySlug: 'gym', likelyRecurring: true },

  // Entertainment & travel
  { match: /bookmyshow|pvr|inox|cinepolis/i, name: 'BookMyShow', categorySlug: 'entertainment' },
  { match: /makemytrip|goibibo|cleartrip|yatra|ixigo|easemytrip|airbnb|oyo|booking\.com|agoda/i, name: 'Travel Booking', categorySlug: 'travel' },
  { match: /indigo|air\s*india|vistara|spicejet|akasa|emirates|qatar\s*airways/i, name: 'Airline', categorySlug: 'travel' },

  // Health
  { match: /apollo\s*pharmacy|pharmeasy|1mg|netmeds|medplus|wellness\s*forever/i, name: 'Pharmacy', categorySlug: 'medicine', isEssential: true },
  { match: /apollo\s*hospital|fortis|manipal|max\s*healthcare|practo|cloudnine|narayana\s*health/i, name: 'Hospital', categorySlug: 'doctor', isEssential: true },
  { match: /\bdr\.?\s+[a-z]|clinic|diagnostics|lab\b|thyrocare|dr\s*lal\s*path|metropolis/i, name: 'Healthcare', categorySlug: 'doctor', isEssential: true },

  // Financial
  { match: /zerodha|groww|upstox|kuvera|coin\s*by|angel\s*one|icici\s*direct|smallcase|indmoney/i, name: 'Investment', categorySlug: 'investment', likelyRecurring: true },
  { match: /\bsip\b|mutual\s*fund|\bnps\b|\bppf\b|elss/i, name: 'Investment', categorySlug: 'investment', likelyRecurring: true },
  { match: /\bemi\b|loan\s*(?:emi|repay|instal)|equated\s*monthly/i, name: 'EMI', categorySlug: 'emi', isEssential: true, likelyRecurring: true },
  { match: /credit\s*card\s*pay|cc\s*payment|card\s*payment/i, name: 'Credit Card Payment', categorySlug: 'credit_card_payment' },
  { match: /\brent\b|rentpay|nobroker|housing\s*rent/i, name: 'Rent', categorySlug: 'rent', isEssential: true, likelyRecurring: true },

  // Education
  { match: /coursera|udemy|byju|unacademy|vedantu|upgrad|great\s*learning|scaler|physics\s*wallah/i, name: 'Courses', categorySlug: 'courses' },

  // Income
  { match: /salary|payroll|sal\s*cr\b/i, name: 'Salary', categorySlug: 'salary' },
];

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

/**
 * What a user's own words about a transaction imply.
 *
 * A UPI screenshot frequently carries no merchant at all — just a virtual address and
 * an amount — so the merchant rules have nothing to match. The remark the user types
 * at upload time ("auto to office", "team lunch") is often the ONLY signal about what
 * the money was for.
 *
 * Ordered most specific first, same as the merchant rules.
 */
const REMARK_RULES: Array<{ match: RegExp; categorySlug: string }> = [
  { match: /\b(?:grocer(?:y|ies)|vegetables?|sabzi|kirana|supermarket|provisions?|milk|ration)\b/i, categorySlug: 'groceries' },
  { match: /\b(?:food\s*delivery|swiggy|zomato|order(?:ed)?\s*(?:in|food))\b/i, categorySlug: 'food_delivery' },
  { match: /\b(?:lunch|dinner|breakfast|brunch|restaurant|eat(?:ing)?\s*out|dine|meal|canteen|mess)\b/i, categorySlug: 'restaurants' },
  { match: /\b(?:tea|chai|coffee|snacks?|juice|bakery)\b/i, categorySlug: 'coffee_snacks' },

  { match: /\b(?:petrol|diesel|fuel|gas\s*station|refuel)\b/i, categorySlug: 'fuel' },
  { match: /\b(?:auto|rickshaw|cab|taxi|uber|ola|rapido|ride)\b/i, categorySlug: 'taxi' },
  { match: /\b(?:bus|metro|train|railway|irctc|local)\b/i, categorySlug: 'public_transport' },
  { match: /\b(?:parking|toll|fastag)\b/i, categorySlug: 'parking' },
  { match: /\b(?:service|servicing|puncture|tyre|car\s*wash|bike\s*repair)\b/i, categorySlug: 'vehicle_maintenance' },

  { match: /\b(?:rent|landlord|house\s*rent)\b/i, categorySlug: 'rent' },
  { match: /\b(?:electricity|power\s*bill|current\s*bill)\b/i, categorySlug: 'electricity' },
  { match: /\b(?:water\s*bill|water\s*can|tanker)\b/i, categorySlug: 'water' },
  { match: /\b(?:wifi|broadband|internet\s*bill)\b/i, categorySlug: 'internet' },
  { match: /\b(?:recharge|mobile\s*bill|phone\s*bill|top\s*up)\b/i, categorySlug: 'mobile' },
  { match: /\b(?:maid|cook|driver|househelp|house\s*help|cleaning)\b/i, categorySlug: 'household_help' },

  { match: /\b(?:medicines?|pharmacy|medical|tablets?|prescriptions?)\b/i, categorySlug: 'medicine' },
  { match: /\b(?:doctor|clinic|hospital|checkup|check\s*up|consultation|dentist|lab\s*test)\b/i, categorySlug: 'doctor' },

  { match: /\b(?:movies?|cinema|concert|shows?|games?|outing)\b/i, categorySlug: 'entertainment' },
  { match: /\b(?:gym|fitness|yoga|workout)\b/i, categorySlug: 'gym' },
  { match: /\b(?:trip|travel|flight|hotel|vacation|holiday)\b/i, categorySlug: 'travel' },
  { match: /\b(?:gift|birthday|wedding|shagun|present)\b/i, categorySlug: 'gifts' },
  { match: /\b(?:clothes|clothing|shirts?|dress(?:es)?|shoes|apparel)\b/i, categorySlug: 'clothing' },
  { match: /\b(?:salon|haircut|parlour|parlor|grooming)\b/i, categorySlug: 'personal_items' },
  { match: /\b(?:courses?|class(?:es)?|tuition|books?|exam\s*fee)\b/i, categorySlug: 'courses' },

  { match: /\b(?:emi|instal(?:l)?ment|loan)\b/i, categorySlug: 'emi' },
  { match: /\b(?:sip|invest(?:ment)?|mutual\s*fund|stocks?)\b/i, categorySlug: 'investment' },
  { match: /\b(?:insurance|premium|policy)\b/i, categorySlug: 'insurance' },
  { match: /\b(?:salary|payroll)\b/i, categorySlug: 'salary' },
];

export interface RemarkMatch {
  categorySlug: string;
  /** The words that matched, so the review screen can say why. */
  matched: string;
}

/** What the user's remark says this transaction was, or null if it says nothing useful. */
export function categoryFromRemark(remark: string): RemarkMatch | null {
  if (!remark?.trim()) return null;
  for (const rule of REMARK_RULES) {
    const found = rule.match.exec(remark);
    if (found) return { categorySlug: rule.categorySlug, matched: found[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

export interface UserMapping {
  merchantKey: string;
  categoryId: UUID;
  displayName?: string;
  isEssential?: boolean | null;
  /** Times the user has confirmed this mapping. More confirmations = higher trust. */
  confirmations: number;
}

export type CategorySource = 'user_mapping' | 'built_in_rule' | 'remark' | 'none';

export interface CategorySuggestion {
  categoryId: UUID | null;
  categorySlug: string | null;
  merchantKey: string;
  merchantName: string;
  isEssential: boolean | null;
  likelyRecurring: boolean;
  /** 0–1. Rows below the review threshold are surfaced to the user. */
  confidence: number;
  source: CategorySource;
  /** Plain-language justification for the review screen. */
  reason: string;
}

export interface SuggestOptions {
  /** The user's learned/explicit merchant → category mappings. */
  userMappings?: readonly UserMapping[];
  /** Resolves a seed slug to the user's actual category row id. */
  categoryIdForSlug?: (slug: string) => UUID | null;
  rules?: readonly MerchantRule[];
  /**
   * What the user said this transaction was, captured at upload time.
   *
   * Consulted only after the merchant rules have failed. A matched merchant is
   * evidence about the payee; a remark is evidence about this one transaction, and
   * letting it override a confident merchant match would mean typing "swiggy order"
   * as a note could recategorise Swiggy.
   */
  remark?: string;
}

/**
 * Suggest a category for a transaction description.
 *
 * Precedence is user → built-in → nothing. A user's own correction always beats a
 * built-in rule, which is what makes "I moved Amazon to Electronics" stick: the
 * mapping is stored and consulted before the rule that says Amazon is shopping.
 */
export function suggestCategory(description: string, options: SuggestOptions = {}): CategorySuggestion {
  const key = merchantKey(description);
  const name = normalizeMerchantName(description) || 'Unknown';
  const rules = options.rules ?? BUILT_IN_RULES;
  const resolve = options.categoryIdForSlug ?? (() => null);

  const mappings = options.userMappings ?? [];
  const keys = candidateKeys(description);
  let userMapping: UserMapping | undefined;
  for (const candidate of keys) {
    const matches = mappings
      .filter((m) => m.merchantKey === candidate)
      .sort((a, b) => b.confirmations - a.confirmations);
    if (matches.length > 0) {
      userMapping = matches[0];
      break;
    }
  }

  if (userMapping) {
    return {
      categoryId: userMapping.categoryId,
      categorySlug: null,
      merchantKey: key,
      merchantName: userMapping.displayName ?? name,
      isEssential: userMapping.isEssential ?? null,
      likelyRecurring: false,
      // A mapping confirmed repeatedly is as trustworthy as anything gets here.
      confidence: Math.min(0.99, 0.85 + userMapping.confirmations * 0.03),
      source: 'user_mapping',
      reason: `You previously categorised ${userMapping.displayName ?? name} this way`,
    };
  }

  for (const rule of rules) {
    if (!rule.match.test(description) && !rule.match.test(name)) continue;
    return {
      categoryId: resolve(rule.categorySlug),
      categorySlug: rule.categorySlug,
      merchantKey: key,
      merchantName: rule.name,
      isEssential: rule.isEssential ?? null,
      likelyRecurring: rule.likelyRecurring ?? false,
      confidence: 0.85,
      source: 'built_in_rule',
      reason: `${rule.name} is usually ${rule.categorySlug.replace(/_/g, ' ')}`,
    };
  }

  // Nothing matched the payee — fall back to what the user said it was.
  const fromRemark = options.remark ? categoryFromRemark(options.remark) : null;
  if (fromRemark) {
    return {
      categoryId: resolve(fromRemark.categorySlug),
      categorySlug: fromRemark.categorySlug,
      merchantKey: key,
      merchantName: name,
      isEssential: null,
      likelyRecurring: false,
      // Lower than a merchant match: the user's shorthand is a good hint, not proof.
      confidence: 0.75,
      source: 'remark',
      reason: `Your note mentioned "${fromRemark.matched}"`,
    };
  }

  return {
    categoryId: null,
    categorySlug: null,
    merchantKey: key,
    merchantName: name,
    isEssential: null,
    likelyRecurring: false,
    confidence: 0.2,
    source: 'none',
    reason: 'No rule matched this merchant yet',
  };
}

/**
 * Fold a user's correction into their mapping set.
 *
 * Called when the user changes a category on a transaction. Re-confirming an existing
 * mapping increments its confirmation count; correcting to a different category resets
 * it, so a single mistaken tap does not permanently outrank a well-established rule.
 */
export function learnMapping(
  existing: readonly UserMapping[],
  correction: { merchantKey: string; categoryId: UUID; displayName?: string; isEssential?: boolean | null },
): UserMapping[] {
  const others = existing.filter((m) => m.merchantKey !== correction.merchantKey);
  const previous = existing.find((m) => m.merchantKey === correction.merchantKey);
  const sameCategory = previous?.categoryId === correction.categoryId;

  const next: UserMapping = {
    merchantKey: correction.merchantKey,
    categoryId: correction.categoryId,
    confirmations: sameCategory ? (previous?.confirmations ?? 0) + 1 : 1,
    ...(correction.displayName !== undefined
      ? { displayName: correction.displayName }
      : previous?.displayName !== undefined
        ? { displayName: previous.displayName }
        : {}),
    ...(correction.isEssential !== undefined ? { isEssential: correction.isEssential } : {}),
  };

  return [...others, next];
}

/** Rows at or below this confidence are flagged for review rather than auto-accepted. */
export const REVIEW_THRESHOLD = 0.7;

export function needsReview(confidence: number): boolean {
  return confidence < REVIEW_THRESHOLD;
}
