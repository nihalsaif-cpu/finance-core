/**
 * Screenshot extraction.
 *
 * A UPI or card-app screenshot is not a table — it is a short block of text where the
 * amount is visually prominent and the date and merchant sit near it. So instead of
 * column detection we look for the three things that must be present, and refuse to
 * emit a transaction unless we found an amount.
 *
 * The example from the brief:
 *     "SWIGGY INSTAMART 14/08/2026 ₹847"
 * → date 2026-08-14, merchant Swiggy Instamart, amount ₹847.
 */

import { parseLooseDate, type DayFirstPreference, type ISODate } from '../date';
import { parseAmountInput, type Minor } from '../money';
import type { ParsedRow } from './statement';
import { WARNINGS } from './statement';

/** Amounts as they appear on screen: ₹847, Rs. 1,234.50, INR 2,499, 847.00 */
/**
 * Amounts carrying a currency marker, a thousands separator, or paise.
 *
 * `Rs` and `INR` are word-bounded. Without that, "TRADE**RS** 27" reads as ₹27 — which
 * on a real receipt made the parser believe it had found a currency-marked amount,
 * disabled the bare-number fallback, and returned nothing at all. Any merchant ending
 * in "rs" hit it: TRADERS, MOTORS, STORES, MOBILES.
 */
const AMOUNT_PATTERN =
  /(?:₹|\bRs\.?|\bINR\b)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|\b([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?)\b|\b([0-9]+\.[0-9]{2})\b/gi;

/**
 * Month names are enumerated rather than matched as `[A-Za-z]{3,9}`: a generic word
 * pattern happily reads "INSTAMART 14" as a date, which then fails to parse and
 * silently loses the real date sitting further along the line.
 */
const MONTH_NAME =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const DATE_PATTERN = new RegExp(
  '\\b(' +
    '\\d{4}-\\d{2}-\\d{2}' +
    '|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}' +
    `|\\d{1,2}(?:st|nd|rd|th)?[\\s-]+${MONTH_NAME}(?:[\\s,-]+\\d{2,4})?` +
    `|${MONTH_NAME}[\\s-]+\\d{1,2}(?:st|nd|rd|th)?(?:[\\s,]+\\d{2,4})?` +
    ')\\b',
  'i',
);

const TIME_PATTERN = /\b\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?\b/;

/** Lines that are app chrome rather than transaction content. */
const CHROME_PATTERNS: RegExp[] = [
  /^\s*(?:paid\s*to|received\s*from|to|from|transaction\s*(?:id|details)|upi\s*(?:ref|transaction)\s*(?:id|no)?)\s*:?\s*$/i,
  /^\s*(?:completed|success(?:ful)?|pending|failed|processing)\s*$/i,
  /^\s*(?:share|download\s*receipt|view\s*details|contact\s*support|done|ok|back)\s*$/i,
  /^\s*(?:google\s*pay|phonepe|paytm|bhim|amazon\s*pay|cred)\s*$/i,
  /^\s*\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?\s*$/,
  /^[\s|·•—-]*$/,
  /**
   * Bank statement and passbook FIELD LABELS.
   *
   * A statement screenshot is mostly headers — "Branch Name Panampilly Nagar",
   * "Account Number 4400", "IFSC SBIN0001234". None of them is a payee, but each
   * looks like one: a capitalised phrase with no amount on it. Without this the
   * merchant came out as "Branch Name Panampilly Nagar", which groups with nothing
   * and matches no categorisation rule.
   */
  /^\s*(?:branch(?:\s*name)?|ifsc|micr|account\s*(?:no|number|type|holder)?|a\/c\s*(?:no|type)?|customer\s*(?:id|name)|cif|nominee|statement\s*(?:period|of\s*account)?|opening\s*balance|closing\s*balance|address|phone|email|generated\s*on|page\s*\d)\b.*$/i,
  /**
   * GST invoice FORM LABELS.
   *
   * A tax invoice is mostly a grid of field names, and OCR flattens them into
   * fragments like "Bill To · State · Gode · Mobile" — which reads as a plausible
   * merchant and is nothing of the sort. The seller's real name is elsewhere on the
   * page, so these have to lose before it can win.
   */
  /^\s*(?:bill\s*to|ship\s*to|sold\s*by|buyer|consignee|item\s*description|description\s*of\s*goods|narration|qty|quantity|hsn|sac|gstin|gst\s*no|invoice\s*(?:no|date|value)|total\s*(?:tax|taxable)|taxable\s*amount|round\s*off|salesman|rate|amount\s*with\s*tax|terms|declaration|e\s*&\s*oe|state\s*code|place\s*of\s*supply|pin|cer|dm|wt|g\.?w|n\.?w)\b.*$/i,
];

/**
 * How a company writes its own name on an invoice.
 *
 * The seller is almost never labelled "merchant" — it is the line carrying a legal
 * suffix. Matching the suffix finds "GLITZ GLAZE JEWELS PVT LTD" on a bill whose
 * every other candidate line is a form label.
 */
const COMPANY_SUFFIX =
  /\b(?:pvt\.?\s*ltd|private\s*limited|limited|ltd|llp|inc|corp|company|& ?co|enterprises?|traders?|jewell?ers?|stores?|mart|retail|foods?|motors?|agencies|industries|solutions?|services?|technologies)\b\.?/i;

export function looksLikeCompanyName(line: string): boolean {
  return COMPANY_SUFFIX.test(line) && !CHROME_PATTERNS.some((re) => re.test(line));
}

/**
 * Lines that identify an account or a transaction rather than a payee.
 *
 * On a payment receipt these sit right alongside the merchant name and would
 * otherwise be swept into it, producing a merchant like
 * "Upi Transaction 425831947261" that groups with nothing and matches no rule.
 */
/**
 * Lines whose digits are identity, never an amount.
 *
 * A real Google Pay receipt puts a masked phone number and a bank account suffix on
 * screen alongside the amount. Read as money they produced two invented transactions
 * — ₹4,682 from a phone number and ₹9,817 from an account number — which is far worse
 * than failing to read the receipt at all.
 */
const NOT_AN_AMOUNT_LINE =
  /(?:\+\d{1,3}\b|[•·*]{2,}|\bx{3,}\b)|\b(?:bank|a\/c|acc(?:ount)?|card|ifsc|upi|vpa|id|ref(?:erence)?|utr|rrn|txn|transaction|order|otp|pin|mobile|phone)\b/i;

const REFERENCE_LINE =
  /^(?:upi|transaction|txn|ref(?:erence)?|utr|rrn|order|google\s*transaction)\b.*\d|^(?:from|to)\b.*(?:bank|xxxx|\*{2,}|\d{4})|^\s*(?:completed|success(?:ful)?|pending|failed)\b/i;

/**
 * Labels that immediately precede the payee on Indian payment apps.
 *
 * "Paid to" / "Received from" sit on their own line with the name directly beneath —
 * by far the highest-signal way to find the merchant on these screens, and far more
 * reliable than picking the longest remaining line.
 */
const PAYEE_LABEL = /^\s*(?:paid\s*to|received\s*from|sent\s*to|to|from)\s*:?\s*$/i;

/**
 * The same labels with the name on the SAME line — "To Priya Menon".
 *
 * Google Pay's receipt header is written this way, so a rule that only handled the
 * label-on-its-own-line form found no payee at all and fell through to sweeping the
 * whole screen into the merchant field.
 */
const PAYEE_INLINE =
  /^\s*(?:paid\s*to|received\s*from|sent\s*to|to|from)\s*:?\s+(.{2,60})$/i;

/** Words that mark a credit rather than a debit on a receipt screen. */
const CREDIT_MARKERS = /\b(?:received\s*from|credited|money\s*received|refund(?:ed)?|cashback)\b/i;
const DEBIT_MARKERS = /\b(?:paid\s*to|debited|sent\s*to|money\s*sent|payment\s*to)\b/i;

function isChrome(line: string): boolean {
  return CHROME_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * A bare run of digits, used only as a fallback.
 *
 * On-device OCR frequently drops the ₹ glyph — it is a non-Latin symbol rendered in
 * app-specific fonts — so a perfectly legible "₹250" comes back as "250". Requiring a
 * currency mark, a comma or a decimal point rejected the amount and failed the whole
 * import on a clean screenshot.
 */
const BARE_NUMBER = /\b(\d{1,7})\b/g;

/** Digits that are identifiers, not money. */
const REFERENCE_CONTEXT =
  /\b(?:id|ids|ref|reference|utr|rrn|txn|transaction|order|account|acc|a\/c|card|xxxx|no|number|otp|pin)\b[^0-9]{0,12}$/i;

/**
 * Words that mark an amount as THE transaction value.
 *
 * A receipt or a payment screen usually labels the figure that matters. Finding that
 * label is far more reliable than any positional or size heuristic — an invoice's
 * grand total is not always its largest number, and a payment app's account balance
 * almost always is.
 */
const TOTAL_LABEL =
  /\b(?:grand\s*total|net\s*(?:payable|amount)|total\s*(?:amount|payable|due|bill)?|amount\s*(?:paid|payable|due)?|you\s*paid|paid|bill\s*amount|invoice\s*(?:total|amount|value)|payable)\b/i;

/**
 * Amounts that are explicitly NOT what was spent.
 *
 * The balance is the worst offender: it sits on the same screen, carries a currency
 * mark, and is nearly always the biggest number there — so "take the largest" read a
 * ₹52,000 account balance as a ₹120 payment.
 */
const NOT_THE_AMOUNT =
  /\b(?:balance|bal|avl|available|closing|opening|remaining|limit|wallet|points?|reward|cashback|you\s*sav(?:e|ed)|savings?|discount|off|coupon|mrp|qty|quantity|rate\s*per|per\s*unit)\b/i;

/**
 * Components of a bill rather than its total.
 *
 * On an invoice these are real money, but adding them or picking the largest gives a
 * figure the user never paid. They lose to a labelled total and are only used when
 * nothing better exists.
 */
const BILL_COMPONENT =
  /\b(?:sub\s*total|subtotal|tax(?:es|able)?|gst|cgst|sgst|igst|vat|cess|service\s*charge|delivery|packing|tip|round\s*off)\b/i;

export interface AmountCandidate {
  value: Minor;
  /** The line it was found on, for scoring against nearby words. */
  line: string;
  /** True when a ₹, Rs or INR marker sat next to it. */
  marked: boolean;
}

/**
 * How likely this number is to be the transaction value.
 *
 * Scored rather than ranked by size. The previous rule — take the largest — is right
 * on a bare receipt and wrong on every screen that also shows a balance, a limit or a
 * cashback offer, which is most of them.
 */
export function scoreAmount(candidate: AmountCandidate): number {
  const { line, marked } = candidate;
  let score = 0;

  if (TOTAL_LABEL.test(line)) score += 5;
  if (marked) score += 2;

  // Decisive, not a nudge: a balance must never win on size alone.
  if (NOT_THE_AMOUNT.test(line)) score -= 9;
  if (BILL_COMPONENT.test(line)) score -= 4;
  if (REFERENCE_LINE.test(line) || NOT_AN_AMOUNT_LINE.test(line)) score -= 5;

  return score;
}

/**
 * The transaction value, from every number on the screen.
 *
 * Highest score wins; size breaks ties. That ordering is the whole point — on a
 * grocery bill the total beats the biggest line item, and on a payment screen the
 * amount paid beats the account balance.
 */
export function pickAmount(candidates: readonly AmountCandidate[]): Minor | null {
  if (candidates.length === 0) return null;

  const scored = candidates.map((c) => ({ ...c, score: scoreAmount(c) }));
  const best = scored.reduce((winner, c) => {
    if (c.score !== winner.score) return c.score > winner.score ? c : winner;
    return c.value > winner.value ? c : winner;
  });

  /*
   * Everything looked like a balance or a reference.
   *
   * Returning the least-bad number would put a made-up figure into someone's
   * accounts. Nothing is the honest answer, and the row goes to review.
   */
  if (best.score < 0) return null;
  return best.value;
}

function currencyAmounts(text: string): AmountCandidate[] {
  const found: AmountCandidate[] = [];
  // Scored against the words around them, so each amount keeps its own line.
  for (const line of text.split(/\n|\s·\s/)) {
    AMOUNT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AMOUNT_PATTERN.exec(line)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (!raw) continue;
      const value = parseAmountInput(raw);
      // Only group 1 carries an explicit ₹/Rs/INR marker.
      if (value !== null && value > 0) found.push({ value, line, marked: Boolean(match[1]) });
    }
  }
  return found;
}

/**
 * Numbers with no currency mark at all.
 *
 * Deliberately a LAST resort: consulted only when nothing in the text carried a
 * currency marker, because a UPI reference and a card suffix are also bare digits.
 * Dates, times and anything sitting after an identifier keyword are removed first.
 */
function bareAmounts(text: string): AmountCandidate[] {
  // Drop whole lines that carry identifying digits before looking for an amount.
  const usable = text
    .split(/\n|\s·\s/)
    .filter((line) => !NOT_AN_AMOUNT_LINE.test(line))
    .join('\n');

  const cleaned = usable
    .replace(DATE_PATTERN, ' ')
    .replace(TIME_PATTERN, ' ')
    // Long digit runs are references, never amounts.
    .replace(/\b\d{8,}\b/g, ' ')
    .replace(/\b(?:x{2,}|\*{2,})\d+\b/gi, ' ')
    // Percentages are never money — battery level, cashback rate, interest.
    .replace(/\b\d{1,3}\s*%/g, ' ');

  const found: AmountCandidate[] = [];
  for (const line of cleaned.split('\n')) {
    BARE_NUMBER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BARE_NUMBER.exec(line)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      // Skip anything introduced by an identifier keyword.
      if (REFERENCE_CONTEXT.test(line.slice(0, match.index))) continue;
      const value = parseAmountInput(raw);
      if (value !== null && value > 0) found.push({ value, line, marked: false });
    }
  }
  return found;
}

/**
 * Amounts in a fragment of text.
 *
 * `allowBare` is decided ONCE for the whole screenshot rather than per line. Deciding
 * per line meant that on a receipt containing "₹1,842", the separate line "70%"
 * (battery) found no currency amount of its own, fell through to bare digits, and the
 * screenshot was misread as a two-transaction list.
 */
function extractAmounts(text: string, allowBare: boolean): AmountCandidate[] {
  const marked = currencyAmounts(text);
  if (marked.length > 0) return marked;
  return allowBare ? bareAmounts(text) : [];
}

export interface ScreenshotParseOptions {
  today?: ISODate;
  preference?: DayFirstPreference;
}

/**
 * Extract transactions from OCR text.
 *
 * Handles both a single receipt screen (one transaction) and a transaction-list
 * screen (several), by first checking whether multiple lines each carry their own
 * amount.
 */
export function parseScreenshotText(text: string, options: ScreenshotParseOptions = {}): ParsedRow[] {
  const allRawLines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const lines = allRawLines.filter((line) => !isChrome(line));

  /**
   * Direction is read from the UNFILTERED text.
   *
   * "Paid to" and "Received from" are stripped as chrome because they are labels, not
   * merchant names — but on-device OCR returns them as their own lines, and those
   * lines carry the single most important fact on the screen. Reading direction from
   * the filtered text turned money received into money spent.
   */
  const directionContext = allRawLines.join(' ');

  if (lines.length === 0) return [];

  /**
   * Does anything on this screen carry a currency marker? Decided once, over the whole
   * text, so bare digits are only ever consulted when OCR lost the symbol entirely.
   */
  const allowBare = currencyAmounts(allRawLines.join(' ')).length === 0;

  /**
   * Only CURRENCY-MARKED amounts decide whether this is a list of transactions.
   *
   * A screen with no currency symbol anywhere is almost always a single receipt whose
   * symbol OCR lost — not a list. Letting bare digits vote here turned one receipt
   * into three, by reading a phone number and an account number as separate payments.
   */
  const linesWithAmounts = lines.filter((line) => currencyAmounts(line).length > 0);

  /**
   * A labelled total means ONE transaction, however many amounts are on screen.
   *
   * An itemised bill — five line items, tax, then "Total ₹1,820" — has an amount on
   * every line and looks exactly like a transaction list. It is not: it is one
   * purchase, and importing it as five would multiply the user's spending by the
   * number of things they bought. A transaction list never says "Total".
   */
  const isItemisedBill = lines.some((line) => TOTAL_LABEL.test(line));

  // Several lines each carrying a marked amount means this is a list screen.
  if (linesWithAmounts.length >= 2 && !isItemisedBill) {
    return linesWithAmounts
      .map((line, index) => parseSingle(line, index, lines, directionContext, allowBare, allRawLines, options))
      .filter((row): row is ParsedRow => row !== null);
  }

  const single = parseSingle(lines.join(' · '), 0, lines, directionContext, allowBare, allRawLines, options);
  return single ? [single] : [];
}

function parseSingle(
  line: string,
  rowIndex: number,
  allLines: readonly string[],
  directionContext: string,
  allowBare: boolean,
  rawLines: readonly string[],
  options: ScreenshotParseOptions,
): ParsedRow | null {
  const warnings: string[] = [];
  let confidence = 0.75; // OCR is inherently less certain than a parsed file

  const amounts = extractAmounts(line, allowBare);
  if (amounts.length === 0) return null;

  /*
   * Where several numbers appear, the best-SCORING one is the transaction amount.
   *
   * Taking the largest read an account balance, a credit limit or a cashback offer as
   * the payment — all of which sit on the same screen, carry a currency mark, and are
   * usually bigger than what was actually spent.
   */
  const amount = pickAmount(amounts);
  if (amount === null) return null;

  /*
   * Only flag genuine ambiguity.
   *
   * Warning whenever more than one number appeared meant a receipt showing a total and
   * a balance was always "uncertain", which trains the user to tick past the warning.
   * It is only uncertain when two candidates score the same.
   */
  const best = scoreAmount({ value: amount, line, marked: true });
  const rivals = amounts.filter((c) => c.value !== amount && scoreAmount(c) >= best);
  if (rivals.length > 0) {
    warnings.push(WARNINGS.amountUncertain);
    confidence -= 0.15;
  }

  // The date may be on this line or elsewhere on the screen.
  const context = `${line} ${allLines.join(' ')}`;
  const dateMatch = DATE_PATTERN.exec(line) ?? DATE_PATTERN.exec(context);
  let date: ISODate | null = null;
  if (dateMatch) {
    const parsed = parseLooseDate(dateMatch[1] ?? '', {
      preference: options.preference ?? 'day-first',
      ...(options.today ? { today: options.today } : {}),
    });
    if (parsed) {
      date = parsed.date;
      if (parsed.ambiguous) {
        warnings.push(WARNINGS.dateAmbiguous);
        confidence -= 0.1;
      }
    }
  }
  if (!date) {
    warnings.push(WARNINGS.dateMissing);
    confidence -= 0.2;
  }

  // Direction: an explicit marker anywhere on the screen beats a guess, and it is
  // read from the unfiltered text so a standalone "Received from" line still counts.
  const credit = CREDIT_MARKERS.test(directionContext);
  const debit = DEBIT_MARKERS.test(directionContext);
  let signedAmount: Minor;
  if (credit && !debit) {
    signedAmount = amount;
  } else if (debit && !credit) {
    signedAmount = -amount as Minor;
  } else {
    signedAmount = -amount as Minor;
    if (!debit) {
      warnings.push(WARNINGS.directionUnknown);
      confidence -= 0.1;
    }
  }

  /**
   * The payee, in order of how much the layout tells us.
   *
   * 1. The line directly beneath a "Paid to" / "Received from" label.
   * 2. Otherwise the longest remaining line that is neither an amount nor an
   *    account/reference line.
   *
   * Previously this stripped the amount and date out of the joined text and kept
   * whatever was left, which on a real receipt produced
   * "250 · Rahul Kumar · , · UPI transaction ID … · From HDFC Bank XXXX1234".
   */
  let description = payeeFromLabel(rawLines) ?? '';

  if (!description) {
    description = line
      .replace(AMOUNT_PATTERN, ' ')
      .replace(DATE_PATTERN, ' ')
      .replace(TIME_PATTERN, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s·•|,-]+|[\s·•|,-]+$/g, '')
      .trim();
  }

  if (!description || REFERENCE_LINE.test(description)) {
    description =
      allLines
        .filter((other) => other !== line)
        .filter((other) => extractAmounts(other, allowBare).length === 0)
        .filter((other) => !REFERENCE_LINE.test(other))
        // Prefer lines that are mostly letters — a name, not an identifier.
        .sort((a, b) => letterCount(b) - letterCount(a))[0] ?? '';
  }

  if (!description) {
    warnings.push(WARNINGS.descriptionMissing);
    confidence -= 0.2;
  }

  return {
    rowIndex,
    rawText: line,
    date,
    signedAmount,
    description: description || line,
    referenceNo: extractReference(context),
    balance: null,
    confidence: Math.max(0.05, Math.min(1, confidence)),
    warnings,
  };
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

/**
 * The payee named by a "Paid to" / "To" label, in either layout.
 *
 * The inline form is checked first because it is unambiguous: the name is on the same
 * line as the label. Only then do we look for a label sitting alone above the name.
 */
function payeeFromLabel(rawLines: readonly string[]): string | null {
  for (const raw of rawLines) {
    const line = (raw ?? '').trim();
    const inline = PAYEE_INLINE.exec(line);
    if (!inline) continue;
    const name = (inline[1] ?? '').trim();
    // "To: PRIYA MENON R" is a payee; "From HDFC Bank XXXX1234" is an account.
    if (!name || REFERENCE_LINE.test(line) || NOT_AN_AMOUNT_LINE.test(name)) continue;
    if (!/[A-Za-z]/.test(name)) continue;
    return name;
  }

  for (let i = 0; i < rawLines.length - 1; i++) {
    if (!PAYEE_LABEL.test(rawLines[i] ?? '')) continue;
    for (let j = i + 1; j < rawLines.length; j++) {
      const candidate = (rawLines[j] ?? '').trim();
      if (!candidate) continue;
      if (REFERENCE_LINE.test(candidate)) continue;
      // A line that is only digits is an amount, not a name.
      if (!/[A-Za-z]/.test(candidate)) continue;
      return candidate;
    }
  }

  /**
   * Last resort on an invoice: the line that names a company.
   *
   * A tax invoice has no "Paid to" label — the seller is simply the line carrying a
   * legal suffix. Without this the merchant came out as "Bill State Gode Mobile",
   * assembled from the form's own field names, while "GLITZ GLAZE JEWELS PVT LTD"
   * sat unused a few lines away.
   */
  for (const raw of rawLines) {
    const line = (raw ?? '').trim();
    if (!looksLikeCompanyName(line)) continue;
    if (REFERENCE_LINE.test(line) || NOT_AN_AMOUNT_LINE.test(line)) continue;
    // Trim any leading label the OCR ran together with the name.
    const cleaned = line.replace(/^.*?(?:name|sold\s*by|seller|from)\s*:?\s*/i, '').trim();
    const name = cleaned.length >= 3 ? cleaned : line;
    if (/[A-Za-z]/.test(name)) return name.slice(0, 60);
  }

  return null;
}

/** UPI reference / UTR numbers, when the screenshot includes them. */
function extractReference(text: string): string | null {
  const match =
    /\b(?:UPI\s*(?:Ref\.?|transaction)\s*(?:ID|No\.?)?|UTR|Ref(?:erence)?\s*(?:No\.?|ID)?)\s*:?\s*([A-Z0-9]{6,})/i.exec(text) ??
    /\b(\d{12,})\b/.exec(text);
  return match?.[1] ?? null;
}
