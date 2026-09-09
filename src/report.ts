/**
 * The end-of-cycle report.
 *
 * A month's figures are easy; a month's STORY is what someone actually reads and
 * remembers. So this returns findings — sentences with numbers in them — alongside the
 * totals, and the screen renders those rather than laying out a table and leaving the
 * reader to work out what happened.
 *
 * Pure. Takes a cycle's transactions and the one before it, returns a report.
 */

import type { SalaryCycle } from './cycle';
import type { CategoryIndex, CycleSnapshot, Rollup } from './analytics';
import { compare, spendByCategory, spendByMerchant } from './analytics';
import { DEFAULT_LEDGER_OPTIONS, type LedgerOptions, spendOf } from './ledger';
import { divide, sub, sum, ZERO, type Minor } from './money';
import type { AnalyzableTransaction } from './types';
import type { BudgetEvaluation } from './analytics';

export interface ReportFinding {
  key: string;
  /** One sentence. The number and what it means, nothing else. */
  text: string;
  tone: 'good' | 'neutral' | 'watch';
}

export interface MonthlyReport {
  cycle: SalaryCycle;
  income: Minor;
  spent: Minor;
  saved: Minor;
  savingsRate: number | null;
  /** Spend change against the previous cycle, signed. */
  change: Minor;
  changePercent: number | null;
  categories: Rollup[];
  merchants: Rollup[];
  biggest: AnalyzableTransaction | null;
  /** Average per day across the whole cycle. */
  dailyAverage: Minor;
  transactionCount: number;
  /** The busiest single day. */
  busiestDay: { date: string; total: Minor } | null;
  budgetsKept: number;
  budgetsBlown: number;
  /** The one-line verdict. */
  headline: string;
  findings: ReportFinding[];
}

export interface ReportInput {
  cycle: SalaryCycle;
  snapshot: CycleSnapshot;
  transactions: readonly AnalyzableTransaction[];
  previous: readonly AnalyzableTransaction[];
  categories: CategoryIndex;
  budgets: readonly BudgetEvaluation[];
  money: (value: Minor) => string;
  options?: LedgerOptions;
}

export function buildMonthlyReport(input: ReportInput): MonthlyReport {
  const options = input.options ?? DEFAULT_LEDGER_OPTIONS;
  const { snapshot, money } = input;

  const spent = snapshot.totals.totalSpend;
  const previousSpend = sum(input.previous.map((t) => spendOf(t, options)));
  const comparison = compare(spent, previousSpend);

  const categories = spendByCategory(input.transactions, input.categories, options);
  const merchants = spendByMerchant(input.transactions, options).slice(0, 5);

  const spendRows = input.transactions.filter((t) => spendOf(t, options) > 0);
  const biggest = spendRows.reduce<AnalyzableTransaction | null>(
    (best, t) => (best === null || spendOf(t, options) > spendOf(best, options) ? t : best),
    null,
  );

  const byDay = new Map<string, number>();
  for (const t of spendRows) {
    byDay.set(t.date, (byDay.get(t.date) ?? 0) + spendOf(t, options));
  }
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];

  const budgetsBlown = input.budgets.filter((b) => b.status === 'over_budget').length;
  const budgetsKept = input.budgets.length - budgetsBlown;

  const report: MonthlyReport = {
    cycle: input.cycle,
    income: snapshot.income,
    spent,
    saved: snapshot.savings,
    savingsRate: snapshot.savingsRate,
    change: sub(spent, previousSpend),
    changePercent: comparison.percentChange,
    categories,
    merchants,
    biggest,
    dailyAverage: divide(spent, Math.max(1, input.cycle.totalDays)),
    transactionCount: spendRows.length,
    busiestDay: busiest ? { date: busiest[0], total: busiest[1] as Minor } : null,
    budgetsKept,
    budgetsBlown,
    headline: '',
    findings: [],
  };

  report.headline = headlineFor(report, money);
  report.findings = findingsFor(report, previousSpend, money);
  return report;
}

/**
 * The verdict, in one sentence.
 *
 * Leads with what was KEPT where there is income to compare against, because that is
 * the number people judge a month by. Spending alone, with no income recorded, gets a
 * plain statement rather than an invented rate.
 */
function headlineFor(report: MonthlyReport, money: (v: Minor) => string): string {
  if (report.transactionCount === 0) return 'Nothing was recorded this cycle.';

  if ((report.income as number) <= 0) {
    return `${money(report.spent)} spent across ${report.transactionCount} payments.`;
  }

  const rate = Math.round(report.savingsRate ?? 0);
  if (rate < 0) {
    return `You spent ${money(report.spent)} against ${money(report.income)} — ${Math.abs(rate)}% more than came in.`;
  }
  return `You kept ${money(report.saved)} of ${money(report.income)} — ${rate}%.`;
}

/**
 * Two to four findings, each worth a sentence.
 *
 * Ordered by how much they should change what the reader does next, not by size — a
 * blown budget matters more than the largest single payment even when the payment is
 * bigger.
 */
function findingsFor(
  report: MonthlyReport,
  previousSpend: Minor,
  money: (v: Minor) => string,
): ReportFinding[] {
  const findings: ReportFinding[] = [];

  if (report.budgetsBlown > 0) {
    findings.push({
      key: 'budgets',
      tone: 'watch',
      text: `${report.budgetsBlown} of ${report.budgetsKept + report.budgetsBlown} budgets went over.`,
    });
  } else if (report.budgetsKept > 0) {
    findings.push({
      key: 'budgets',
      tone: 'good',
      text: `Every one of your ${report.budgetsKept} budgets held.`,
    });
  }

  /*
   * The comparison is only offered when there IS a previous cycle to compare with.
   *
   * "Spending up 100%" against a month with no data recorded is arithmetically true
   * and completely meaningless.
   */
  if ((previousSpend as number) > 0 && report.changePercent !== null) {
    const up = (report.change as number) > 0;
    findings.push({
      key: 'change',
      tone: up ? 'watch' : 'good',
      text: `${money(Math.abs(report.change as number) as Minor)} ${up ? 'more' : 'less'} than last cycle, ${Math.abs(Math.round(report.changePercent))}% ${up ? 'up' : 'down'}.`,
    });
  }

  const top = report.categories[0];
  if (top && top.share !== null) {
    findings.push({
      key: 'top-category',
      tone: top.share > 45 ? 'watch' : 'neutral',
      text: `${top.label} took ${Math.round(top.share)}% of everything you spent.`,
    });
  }

  if (report.biggest) {
    findings.push({
      key: 'biggest',
      tone: 'neutral',
      text: `Biggest single payment: ${money(report.biggest.amount)} at ${report.biggest.merchantName ?? report.biggest.description}.`,
    });
  }

  return findings.slice(0, 4);
}

/**
 * The report as plain text, for sharing.
 *
 * Text rather than an image: it pastes into a message, a note or an email, survives
 * every client, and needs no rendering step. An image looks better and can be read by
 * nobody's search.
 */
export function reportToText(report: MonthlyReport, money: (v: Minor) => string): string {
  const lines = [
    `Spend Cents — ${report.cycle.label}`,
    '',
    report.headline,
    '',
    `Income   ${money(report.income)}`,
    `Spent    ${money(report.spent)}`,
    `Saved    ${money(report.saved)}`,
  ];

  if (report.categories.length > 0) {
    lines.push('', 'Where it went');
    for (const c of report.categories.slice(0, 5)) {
      lines.push(`  ${c.label} — ${money(c.amount)}`);
    }
  }

  if (report.findings.length > 0) {
    lines.push('');
    for (const f of report.findings) lines.push(`• ${f.text}`);
  }

  return lines.join('\n');
}

export { ZERO };
