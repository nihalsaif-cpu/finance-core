import { describe, expect, it } from 'vitest';
import {
  amortisationSchedule, computeEmi, evaluatePrepayment, fromMajor, outstandingAfter,
  summariseLoan, ZERO,
} from '../src/index';

const homeLoan = {
  principal: fromMajor('1000000'),
  annualRatePercent: 8.5,
  tenureMonths: 240,
};

describe('computeEmi', () => {
  it('matches the published figure for a standard home loan', () => {
    // ₹10,00,000 at 8.5% over 20 years is ~₹8,678 a month in every EMI table.
    const emi = computeEmi(homeLoan);
    expect(emi / 100).toBeCloseTo(8678, 0);
  });

  it('splits an interest-free loan evenly instead of returning NaN', () => {
    // 0/0 in the standard formula. A no-interest loan from family is a real case, and
    // NaN would poison every figure downstream.
    expect(computeEmi({ principal: fromMajor('120000'), annualRatePercent: 0, tenureMonths: 12 }))
      .toBe(fromMajor('10000'));
  });

  it('returns zero rather than dividing by a zero tenure', () => {
    expect(computeEmi({ ...homeLoan, tenureMonths: 0 })).toBe(ZERO);
  });
});

describe('amortisationSchedule', () => {
  const schedule = amortisationSchedule(homeLoan);

  it('clears the loan exactly — the closing balance is zero, not a few paise', () => {
    // The classic defect: a fixed EMI does not divide the principal exactly, so a
    // naive schedule ends owing 37 paise or overpays by a rupee.
    expect(schedule[schedule.length - 1]!.closing).toBe(0);
  });

  it('runs for the quoted tenure', () => {
    expect(schedule).toHaveLength(240);
  });

  it('has every row balance: opening − principal = closing, and interest + principal = payment', () => {
    for (const row of schedule) {
      expect((row.opening as number) - (row.principal as number)).toBe(row.closing);
      expect((row.interest as number) + (row.principal as number)).toBe(row.payment);
    }
  });

  it('shifts from interest to principal over the life of the loan', () => {
    // Early instalments are mostly interest; that shape is the whole reason
    // prepayment early saves so much more than prepayment late.
    expect(schedule[0]!.interest).toBeGreaterThan(schedule[0]!.principal);
    expect(schedule[239]!.principal).toBeGreaterThan(schedule[239]!.interest);
  });

  it('adjusts only the final instalment', () => {
    const payments = new Set(schedule.slice(0, -1).map((r) => r.payment));
    expect(payments.size).toBe(1);
  });

  it('dates each row from the first instalment', () => {
    const dated = amortisationSchedule(homeLoan, { startDate: '2026-09-05' });
    expect(dated[0]!.date).toBe('2026-09-05');
    expect(dated[11]!.date).toBe('2027-08-05');
  });

  it('stops rather than looping when the instalment never covers the interest', () => {
    // At this EMI the balance grows for ever. Running to the cap would imply the loan
    // eventually clears.
    const doomed = amortisationSchedule(homeLoan, { emi: fromMajor('100') });
    expect(doomed).toHaveLength(0);
  });
});

describe('summariseLoan', () => {
  it('totals what is actually repaid, and the interest inside it', () => {
    const summary = summariseLoan(homeLoan);
    expect(summary.months).toBe(240);
    expect(summary.totalPayable).toBe(
      amortisationSchedule(homeLoan).reduce((acc, r) => acc + (r.payment as number), 0),
    );
    // ~₹10.8 lakh of interest on a ₹10 lakh loan over 20 years.
    expect((summary.totalInterest as number) / 100).toBeGreaterThan(1000000);
    expect(summary.neverAmortises).toBe(false);
  });

  it('flags a loan that never amortises rather than reporting totals for it', () => {
    const summary = summariseLoan(homeLoan, { emi: fromMajor('100') });
    expect(summary.neverAmortises).toBe(true);
    expect(summary.totalInterest).toBe(ZERO);
  });
});

describe('outstandingAfter', () => {
  it('is the full principal before anything is paid', () => {
    expect(outstandingAfter(homeLoan, 0)).toBe(homeLoan.principal);
  });

  it('has barely moved after a year, which is the point of the shape', () => {
    const after12 = outstandingAfter(homeLoan, 12) as number;
    expect(after12).toBeLessThan(homeLoan.principal as number);
    // Less than 3% of a 20-year loan is repaid in its first year.
    expect(after12).toBeGreaterThan((homeLoan.principal as number) * 0.97);
  });

  it('is zero once every instalment is paid', () => {
    expect(outstandingAfter(homeLoan, 240)).toBe(0);
  });
});

describe('evaluatePrepayment', () => {
  it('shortens the loan and quantifies the interest saved', () => {
    const result = evaluatePrepayment(homeLoan, 12, fromMajor('200000'), {
      startDate: '2026-09-05',
    });

    expect(result.outstandingAfter).toBeLessThan(result.outstandingBefore);
    expect(result.monthsSaved).toBeGreaterThan(0);
    expect(result.interestSaved).toBeGreaterThan(0);
    expect(result.newPayoffDate).not.toBeNull();
  });

  it('saves more when made earlier, which is the advice the number exists to support', () => {
    const early = evaluatePrepayment(homeLoan, 12, fromMajor('200000'));
    const late = evaluatePrepayment(homeLoan, 180, fromMajor('200000'));
    expect(early.interestSaved).toBeGreaterThan(late.interestSaved);
  });

  it('clears the loan when the lump sum covers the balance, without going negative', () => {
    const result = evaluatePrepayment(homeLoan, 12, fromMajor('5000000'));
    expect(result.outstandingAfter).toBe(0);
    expect(result.remainingMonths).toBe(0);
  });
});
