/**
 * Loan arithmetic: EMI, amortisation, payoff and prepayment.
 *
 * Everything here works in integer paise and rounds at every step the way a lender
 * does, because a schedule that is right to the rupee but drifts by paise does not
 * reconcile against a real statement — and a user comparing this app to their bank
 * will trust the bank.
 *
 * Two decisions carry most of the correctness:
 *
 *   1. INTEREST IS ROUNDED PER MONTH, not accumulated as a float and rounded at the
 *      end. Lenders charge a whole number of paise each month, and compounding a
 *      float for 240 months puts the balance out by rupees.
 *   2. THE FINAL INSTALMENT ABSORBS THE REMAINDER. A fixed EMI almost never divides
 *      the principal exactly, so the last payment differs by a few paise. Real
 *      lenders adjust it; a schedule that instead ends at a non-zero balance, or pays
 *      a phantom extra rupee, is wrong in a way people notice on the last month.
 */

import { addMonths, type ISODate } from './date';
import { ZERO, clampAtZero, fromMinor, sub, sum, type Minor } from './money';

export interface LoanTerms {
  principal: Minor;
  /** Nominal annual rate, e.g. 8.5 for 8.5%. */
  annualRatePercent: number;
  tenureMonths: number;
}

/** Monthly rate as a fraction. 8.5% a year is 0.00708333 a month. */
export function monthlyRate(annualRatePercent: number): number {
  return annualRatePercent / 12 / 100;
}

/**
 * The equated monthly instalment.
 *
 *   EMI = P·r·(1+r)^n / ((1+r)^n − 1)
 *
 * At a zero rate that formula is 0/0, so it degrades to the only sensible answer:
 * the principal split evenly. An interest-free loan from family is a real case, and
 * returning NaN for it would poison every figure downstream.
 */
export function computeEmi(terms: LoanTerms): Minor {
  const { principal, tenureMonths } = terms;
  if (tenureMonths <= 0) return ZERO;
  if ((principal as number) <= 0) return ZERO;

  const r = monthlyRate(terms.annualRatePercent);
  if (r <= 0) return fromMinor(Math.round((principal as number) / tenureMonths));

  const growth = Math.pow(1 + r, tenureMonths);
  const exact = ((principal as number) * r * growth) / (growth - 1);

  // Rounded UP, as lenders do. Rounding to nearest under-pays by up to half a paise a
  // month, which over 240 months leaves the loan owing a rupee or two and spills into
  // a 241st instalment the borrower was never quoted. Rounding up gains a paise a
  // month, which always covers the drift, and the final instalment is correspondingly
  // smaller.
  return fromMinor(Math.ceil(exact));
}

export interface AmortisationEntry {
  /** 1-based month of the loan. */
  monthIndex: number;
  date: ISODate | null;
  opening: Minor;
  payment: Minor;
  interest: Minor;
  principal: Minor;
  closing: Minor;
}

export interface ScheduleOptions {
  /** First instalment date, used to date each row. */
  startDate?: ISODate;
  /** Overrides the computed EMI — for a loan whose instalment the user was quoted. */
  emi?: Minor;
  /** Safety bound: a rate below the monthly interest never amortises. */
  maxMonths?: number;
}

/** Beyond this the loan is not amortising and the caller has bad inputs. */
const MAX_SCHEDULE_MONTHS = 1200;

export function amortisationSchedule(
  terms: LoanTerms,
  options: ScheduleOptions = {},
): AmortisationEntry[] {
  const emi = options.emi ?? computeEmi(terms);
  const r = monthlyRate(terms.annualRatePercent);
  const cap = Math.min(options.maxMonths ?? MAX_SCHEDULE_MONTHS, MAX_SCHEDULE_MONTHS);

  const rows: AmortisationEntry[] = [];
  let outstanding = terms.principal as number;

  for (let month = 1; month <= cap && outstanding > 0; month++) {
    const interest = Math.round(outstanding * r);

    // If the instalment does not cover the interest the balance grows for ever.
    // Stopping is the honest response; a schedule that runs to the cap would imply
    // the loan eventually clears, which it does not.
    if (emi <= interest && r > 0) break;

    // The final instalment settles whatever is left, interest included, rather than
    // leaving a few paise outstanding or overpaying by a rupee.
    //
    // Also forced at the quoted tenure when the remainder is within one instalment:
    // per-month interest rounding can still leave a few paise after the last scheduled
    // payment, and a borrower quoted 240 months must not be shown 241. A remainder
    // LARGER than an instalment is not rounding — the instalment is genuinely too
    // small — so the schedule runs on and tells the truth.
    const remainder = outstanding + interest;
    const atQuotedTenure = month === terms.tenureMonths && remainder <= (emi as number) * 2;
    const isFinal = remainder <= (emi as number) || atQuotedTenure;
    const payment = isFinal ? outstanding + interest : (emi as number);
    const principalPaid = payment - interest;
    const closing = outstanding - principalPaid;

    rows.push({
      monthIndex: month,
      date: options.startDate ? addMonths(options.startDate, month - 1) : null,
      opening: fromMinor(outstanding),
      payment: fromMinor(payment),
      interest: fromMinor(interest),
      principal: fromMinor(principalPaid),
      closing: fromMinor(closing),
    });

    outstanding = closing;
  }

  return rows;
}

export interface LoanSummary {
  emi: Minor;
  /** Months the schedule actually takes, which can differ from the quoted tenure. */
  months: number;
  totalPayable: Minor;
  totalInterest: Minor;
  /** True when the instalment never clears the loan. Every other figure is then zero. */
  neverAmortises: boolean;
}

export function summariseLoan(terms: LoanTerms, options: ScheduleOptions = {}): LoanSummary {
  const emi = options.emi ?? computeEmi(terms);
  const schedule = amortisationSchedule(terms, { ...options, emi });

  if (schedule.length === 0 || (schedule[schedule.length - 1]!.closing as number) > 0) {
    return { emi, months: 0, totalPayable: ZERO, totalInterest: ZERO, neverAmortises: true };
  }

  const totalPayable = sum(schedule.map((row) => row.payment));
  return {
    emi,
    months: schedule.length,
    totalPayable,
    totalInterest: sub(totalPayable, terms.principal),
    neverAmortises: false,
  };
}

/** Balance after a number of instalments have been paid. */
export function outstandingAfter(
  terms: LoanTerms,
  paymentsMade: number,
  options: ScheduleOptions = {},
): Minor {
  if (paymentsMade <= 0) return terms.principal;
  const schedule = amortisationSchedule(terms, options);
  const row = schedule[Math.min(paymentsMade, schedule.length) - 1];
  return row ? row.closing : ZERO;
}

export interface PrepaymentResult {
  /** Balance the prepayment is applied to. */
  outstandingBefore: Minor;
  outstandingAfter: Minor;
  /** Instalments removed from the end of the loan. */
  monthsSaved: number;
  interestSaved: Minor;
  /** Months still to run after the prepayment. */
  remainingMonths: number;
  newPayoffDate: ISODate | null;
}

/**
 * What a lump sum actually buys.
 *
 * Modelled as a TENURE reduction — the instalment stays and the loan ends sooner —
 * because that is what saves interest and what most Indian lenders do by default.
 * Keeping the tenure and cutting the EMI is a different product and would need saying
 * so explicitly rather than being silently assumed.
 */
export function evaluatePrepayment(
  terms: LoanTerms,
  paymentsMade: number,
  lumpSum: Minor,
  options: ScheduleOptions = {},
): PrepaymentResult {
  const emi = options.emi ?? computeEmi(terms);
  const before = outstandingAfter(terms, paymentsMade, { ...options, emi });
  const after = clampAtZero(sub(before, lumpSum));

  const remainingWithout = amortisationSchedule(
    { ...terms, principal: before },
    { ...options, emi },
  );
  const remainingWith = amortisationSchedule(
    { ...terms, principal: after },
    { ...options, emi },
  );

  const interestWithout = sum(remainingWithout.map((row) => row.interest));
  const interestWith = sum(remainingWith.map((row) => row.interest));

  const nextDate = options.startDate ? addMonths(options.startDate, paymentsMade) : null;

  return {
    outstandingBefore: before,
    outstandingAfter: after,
    monthsSaved: remainingWithout.length - remainingWith.length,
    interestSaved: clampAtZero(sub(interestWithout, interestWith)),
    remainingMonths: remainingWith.length,
    newPayoffDate:
      nextDate && remainingWith.length > 0 ? addMonths(nextDate, remainingWith.length - 1) : null,
  };
}
