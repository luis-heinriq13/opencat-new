import type { MetaAdsAccount, MetaAdsDay, MetaAdsRow, MetaAdsStatus } from "@openbot/contracts/ipc";

/** The sums of a set of rows. Every rate is computed from these sums, never averaged from rates. */
export interface MetaAdsTotals {
  spend: number;
  revenue: number | null;
  purchases: number;
  impressions: number;
  clicks: number;
}

export interface MetaAdsRates {
  /** Click-through rate as a ratio (0.021 is 2.1%). */
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
}

export const EMPTY_TOTALS: MetaAdsTotals = { spend: 0, revenue: null, purchases: 0, impressions: 0, clicks: 0 };

export function totalsOf(
  rows: readonly Pick<MetaAdsRow, "spend" | "revenue" | "purchases" | "impressions" | "clicks">[],
): MetaAdsTotals {
  return rows.reduce<MetaAdsTotals>(
    (sum, row) => ({
      spend: sum.spend + row.spend,
      revenue: row.revenue === null ? sum.revenue : (sum.revenue ?? 0) + row.revenue,
      purchases: sum.purchases + row.purchases,
      impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks,
    }),
    EMPTY_TOTALS,
  );
}

const ratio = (top: number, bottom: number): number | null => (bottom > 0 ? top / bottom : null);

export function ratesOf(totals: MetaAdsTotals): MetaAdsRates {
  return {
    ctr: ratio(totals.clicks, totals.impressions),
    cpc: ratio(totals.spend, totals.clicks),
    cpm: ratio(totals.spend * 1000, totals.impressions),
    cpa: ratio(totals.spend, totals.purchases),
    roas: totals.revenue === null ? null : ratio(totals.revenue, totals.spend),
  };
}

export const META_SORT_KEYS = [
  "name",
  "status",
  "spend",
  "purchases",
  "cpa",
  "roas",
  "ctr",
  "cpc",
  "cpm",
  "impressions",
  "clicks",
] as const;
export type MetaSortKey = (typeof META_SORT_KEYS)[number];
export type MetaSortDirection = "asc" | "desc";

const STATUS_ORDER: Record<MetaAdsStatus, number> = { active: 0, issue: 1, paused: 2, ended: 3 };

function sortValue(row: MetaAdsRow, key: Exclude<MetaSortKey, "name" | "status">): number | null {
  const totals = totalsOf([row]);
  const rates = ratesOf(totals);
  switch (key) {
    case "spend":
      return row.spend;
    case "purchases":
      return row.purchases;
    case "impressions":
      return row.impressions;
    case "clicks":
      return row.clicks;
    case "cpa":
      return rates.cpa;
    case "roas":
      return rates.roas;
    case "ctr":
      return rates.ctr;
    case "cpc":
      return rates.cpc;
    case "cpm":
      return rates.cpm;
  }
}

/** A new array in the order asked. A row without a value for a rate (no clicks, no purchases) goes last in both directions. */
export function sortRows(rows: readonly MetaAdsRow[], key: MetaSortKey, direction: MetaSortDirection): MetaAdsRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "name") return sign * a.name.localeCompare(b.name);
    if (key === "status")
      return sign * (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.name.localeCompare(b.name);
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    return sign * (left - right) || a.name.localeCompare(b.name);
  });
}

export interface MetaAdsFilter {
  /** An account id, or null for every account. */
  accountId: string | null;
  status: MetaAdsStatus | null;
  currency: string | null;
}

export function currencyOfAccount(accounts: readonly MetaAdsAccount[], accountId: string): string | undefined {
  return accounts.find((account) => account.id === accountId)?.currency;
}

/** The currencies of the accounts that the account filter leaves in, the one with the most spend first. */
export function currenciesOf(
  accounts: readonly MetaAdsAccount[],
  rows: readonly MetaAdsRow[],
  accountId: string | null,
): string[] {
  const spend = new Map<string, number>();
  for (const account of accounts) {
    if (accountId !== null && account.id !== accountId) continue;
    spend.set(account.currency, spend.get(account.currency) ?? 0);
  }
  for (const row of rows) {
    const currency = currencyOfAccount(accounts, row.accountId);
    if (currency !== undefined && spend.has(currency)) spend.set(currency, (spend.get(currency) ?? 0) + row.spend);
  }
  return [...spend.entries()].sort((a, b) => b[1] - a[1]).map(([currency]) => currency);
}

export function filterRows(
  rows: readonly MetaAdsRow[],
  accounts: readonly MetaAdsAccount[],
  filter: MetaAdsFilter,
): MetaAdsRow[] {
  return rows.filter(
    (row) =>
      (filter.accountId === null || row.accountId === filter.accountId) &&
      (filter.status === null || row.status === filter.status) &&
      (filter.currency === null || currencyOfAccount(accounts, row.accountId) === filter.currency),
  );
}

export interface MetaSpendDay {
  date: string;
  spend: number;
}

/** Spend per date for the accounts that the filter leaves in, oldest first. */
export function spendPerDay(
  days: readonly MetaAdsDay[],
  accounts: readonly MetaAdsAccount[],
  filter: Pick<MetaAdsFilter, "accountId" | "currency">,
): MetaSpendDay[] {
  const byDate = new Map<string, number>();
  for (const day of days) {
    if (filter.accountId !== null && day.accountId !== filter.accountId) continue;
    if (filter.currency !== null && currencyOfAccount(accounts, day.accountId) !== filter.currency) continue;
    byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.spend);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, spend]) => ({ date, spend }));
}

/** The sum of the revenue of the days that the filter leaves in, or null when no day reports revenue. */
export function revenueOfDays(
  days: readonly MetaAdsDay[],
  accounts: readonly MetaAdsAccount[],
  filter: Pick<MetaAdsFilter, "accountId" | "currency">,
): number | null {
  let sum: number | null = null;
  for (const day of days) {
    if (day.revenue === null) continue;
    if (filter.accountId !== null && day.accountId !== filter.accountId) continue;
    if (filter.currency !== null && currencyOfAccount(accounts, day.accountId) !== filter.currency) continue;
    sum = (sum ?? 0) + day.revenue;
  }
  return sum;
}
