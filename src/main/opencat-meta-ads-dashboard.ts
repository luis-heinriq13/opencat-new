// OpenCat: the data behind the Meta Ads page. Main reads the Meta Graph API with the token of the
// "meta-ads" app, through the same module that the app's MCP server runs (the packaged `meta-ads` resource):
// its request code, time limit, error mapping, daily cap and hourly limit stay in one place. The
// token is read from the saved server settings, kept in this module and never sent to the renderer.
// Reads are cached for a short time to save calls. Pause and resume go through the tools of that
// module, so the cap rules are the module's own.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  META_ADS_RANGES,
  type MetaAdsAccount,
  type MetaAdsChange,
  type MetaAdsChangeResult,
  type MetaAdsChildren,
  type MetaAdsChildrenQuery,
  type MetaAdsDay,
  type MetaAdsFailedAccount,
  type MetaAdsFailure,
  type MetaAdsOverview,
  type MetaAdsQuery,
  type MetaAdsRow,
  type MetaAdsStatus,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import { bundledToolModule } from "./opencat-bundled-tool-path";

export const META_ADS_SERVER_NAME = "meta-ads";
export const META_ADS_MODULE_FILE = "meta-ads-mcp.mjs";
const META_ADS_LIMIT_FILE = join(homedir(), ".opencat", META_ADS_SERVER_NAME, "alteracoes.json");

/** How long a reading is reused, and the least time between two readings that the user forces. */
export const META_CACHE_MS = 90_000;
export const META_MIN_REFRESH_MS = 10_000;
const MAX_ACCOUNTS = 50;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"] as const;

/** The Graph query parameters that this page sends. */
export interface MetaGraphQuery {
  fields?: string;
  limit?: number;
  after?: string | undefined;
  level?: string;
  date_preset?: string;
  time_increment?: number;
}

/** What the installed module exports. */
interface MetaAdsModuleExports {
  createMetaAdsTools(options: { env: Record<string, string>; limitFile: string }): unknown;
}

/** The members of the Meta Ads module that this page uses. */
export interface MetaAdsModuleTools {
  graph(path: string, options?: { query?: MetaGraphQuery }): Promise<unknown>;
  callTool(name: string, args: DynamicRecord): Promise<unknown>;
  readonly changesAllowed: boolean;
  readonly cap: number | null;
  readonly hasToken: boolean;
}

export interface MetaAdsDashboardDependencies {
  /** The environment of the saved "meta-ads" server, or null when that server is not installed and on. */
  environment: () => Readonly<Record<string, string>> | null;
  /** Builds the tools of the module for one environment. Null when the module is not installed. */
  loadTools: (environment: Readonly<Record<string, string>>) => Promise<MetaAdsModuleTools | null>;
  now?: () => number;
}

function isModuleTools(value: unknown): value is MetaAdsModuleTools {
  return (
    isDynamicRecord(value) &&
    typeof value.graph === "function" &&
    typeof value.callTool === "function" &&
    typeof value.hasToken === "boolean"
  );
}

/** Loads the installed module. An older install without the structured members reads as not installed. */
export async function loadInstalledMetaAdsTools(
  environment: Readonly<Record<string, string>>,
): Promise<MetaAdsModuleTools | null> {
  try {
    const imported: MetaAdsModuleExports = await import(
      pathToFileURL(bundledToolModule(META_ADS_SERVER_NAME, META_ADS_MODULE_FILE)).href
    );
    if (typeof imported.createMetaAdsTools !== "function") return null;
    const created = imported.createMetaAdsTools({ env: { ...environment }, limitFile: META_ADS_LIMIT_FILE });
    return isModuleTools(created) ? created : null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 300) : fallback;
}

/** The first of the purchase action types that the account reports. One type only, so a purchase is not counted twice. */
function purchaseValue(list: unknown): number | null {
  if (!Array.isArray(list)) return null;
  for (const type of PURCHASE_TYPES) {
    const found = list.find((entry) => isDynamicRecord(entry) && entry.action_type === type);
    if (isDynamicRecord(found)) return numberOf(found.value);
  }
  return null;
}

export function statusOf(effective: unknown): MetaAdsStatus {
  switch (effective) {
    case "ACTIVE":
      return "active";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "paused";
    case "ARCHIVED":
    case "DELETED":
      return "ended";
    default:
      return "issue";
  }
}

function failureOf(error: unknown): MetaAdsFailure {
  const kind = isDynamicRecord(error) ? error.kind : undefined;
  if (kind === "token") return { state: "token-expired" };
  if (kind === "permission") return { state: "error", reason: "permission" };
  if (kind === "rate") return { state: "error", reason: "rate" };
  const name = error instanceof Error ? error.name : "";
  return {
    state: "error",
    reason: name === "TypeError" || name === "TimeoutError" || name === "AbortError" ? "network" : "unknown",
  };
}

function rows(data: unknown): DynamicRecord[] {
  if (!isDynamicRecord(data) || !Array.isArray(data.data)) return [];
  return data.data.filter(isDynamicRecord);
}

function nextCursor(data: unknown): string | undefined {
  if (!isDynamicRecord(data) || !isDynamicRecord(data.paging) || !data.paging.next) return undefined;
  const cursors = data.paging.cursors;
  return isDynamicRecord(cursors) && typeof cursors.after === "string" ? cursors.after : undefined;
}

/** Runs a load once for a key, reuses its answer for `META_CACHE_MS`, and lets a forced read through after `META_MIN_REFRESH_MS`. */
class TimedCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();
  private readonly running = new Map<string, Promise<T>>();
  /** A clear starts a new generation: a load that began before it must not write its old answer. */
  private generation = 0;

  constructor(private readonly now: () => number) {}

  async get(key: string, refresh: boolean | undefined, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < (refresh ? META_MIN_REFRESH_MS : META_CACHE_MS)) return hit.value;
    const pending = this.running.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const work = load()
      .then((value) => {
        if (generation === this.generation) this.entries.set(key, { at: this.now(), value });
        return value;
      })
      .finally(() => {
        if (generation === this.generation) this.running.delete(key);
      });
    this.running.set(key, work);
    return work;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.running.clear();
  }
}

export function createMetaAdsDashboard({ environment, loadTools, now = Date.now }: MetaAdsDashboardDependencies) {
  let signature = "";
  let tools: MetaAdsModuleTools | null = null;
  const overviews = new TimedCache<MetaAdsOverview>(now);
  const levels = new TimedCache<{ rows: MetaAdsRow[]; truncated: boolean }>(now);

  /** The tools for the saved token. A changed token or cap drops the cache and builds the tools again. */
  async function currentTools(): Promise<MetaAdsModuleTools | MetaAdsFailure> {
    const env = environment();
    if (!env || !(env.META_ACCESS_TOKEN ?? "").trim()) return { state: "not-connected" };
    const next = JSON.stringify(env);
    if (next !== signature || !tools) {
      const loaded = await loadTools(env);
      if (!loaded?.hasToken) return { state: "not-connected" };
      signature = next;
      tools = loaded;
      overviews.clear();
      levels.clear();
    }
    return tools;
  }

  async function pages(
    active: MetaAdsModuleTools,
    path: string,
    query: MetaGraphQuery,
  ): Promise<{ list: DynamicRecord[]; truncated: boolean }> {
    const list: DynamicRecord[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await active.graph(path, { query: { ...query, limit: PAGE_SIZE, after } });
      list.push(...rows(data));
      after = nextCursor(data);
      if (!after) return { list, truncated: false };
    }
    return { list, truncated: true };
  }

  function insightRow(raw: DynamicRecord, id: string, name: string, accountId: string): Omit<MetaAdsRow, "status"> {
    return {
      id,
      name,
      accountId,
      spend: numberOf(raw.spend),
      impressions: numberOf(raw.impressions),
      clicks: numberOf(raw.clicks),
      purchases: purchaseValue(raw.actions) ?? 0,
      revenue: purchaseValue(raw.action_values),
    };
  }

  /** The items of one level with their status and the results of the period. An item without results shows zeros. */
  async function levelRows(
    active: MetaAdsModuleTools,
    parent: string,
    accountId: string,
    level: "campaign" | "adset" | "ad",
    range: string,
  ): Promise<{ rows: MetaAdsRow[]; truncated: boolean }> {
    const edge = level === "campaign" ? "campaigns" : level === "adset" ? "adsets" : "ads";
    const [objects, insights] = await Promise.all([
      pages(active, `/${parent}/${edge}`, { fields: "id,name,effective_status" }),
      pages(active, `/${parent}/insights`, {
        level,
        date_preset: range,
        fields: `${level}_id,${level}_name,spend,impressions,clicks,actions,action_values`,
      }),
    ]);
    const results = new Map<string, DynamicRecord>();
    for (const entry of insights.list) {
      const id = textOf(entry[`${level}_id`]);
      if (id) results.set(id, entry);
    }
    const list = objects.list.flatMap((object): MetaAdsRow[] => {
      const id = textOf(object.id);
      if (!id) return [];
      return [
        {
          ...insightRow(results.get(id) ?? {}, id, textOf(object.name), accountId),
          status: statusOf(object.effective_status),
        },
      ];
    });
    return { rows: list, truncated: objects.truncated || insights.truncated };
  }

  async function readOverview(active: MetaAdsModuleTools, range: MetaAdsQuery["range"]): Promise<MetaAdsOverview> {
    const accountMap = new Map<string, MetaAdsAccount>();
    let accountsTruncated = false;

    // 1. Direct ad accounts on user
    try {
      const accountPage = await pages(active, "/me/adaccounts", { fields: "id,name,account_status,currency,business" });
      if (accountPage.truncated) accountsTruncated = true;
      for (const raw of accountPage.list) {
        const id = textOf(raw.id);
        if (!id) continue;
        const bizName = isDynamicRecord(raw.business) ? textOf(raw.business.name) : "";
        const rawName = textOf(raw.name);
        const name = bizName && !rawName.includes(bizName) ? `[${bizName}] ${rawName}` : rawName;
        accountMap.set(id, {
          id,
          name,
          currency: textOf(raw.currency, "?"),
          active: raw.account_status === 1,
        });
      }
    } catch (error) {
      if (failureOf(error).state === "token-expired") throw error;
    }

    // 2. Business Manager (BM) accounts
    try {
      const bizPage = await pages(active, "/me/businesses", { fields: "id,name" });
      for (const biz of bizPage.list) {
        const bizId = textOf(biz.id);
        const bizName = textOf(biz.name);
        if (!bizId) continue;

        // Owned accounts
        try {
          const owned = await pages(active, `/${bizId}/owned_ad_accounts`, {
            fields: "id,name,account_status,currency",
          });
          for (const raw of owned.list) {
            const id = textOf(raw.id);
            if (!id || accountMap.has(id)) continue;
            const rawName = textOf(raw.name);
            const name = bizName && !rawName.includes(bizName) ? `[${bizName}] ${rawName}` : rawName;
            accountMap.set(id, {
              id,
              name,
              currency: textOf(raw.currency, "?"),
              active: raw.account_status === 1,
            });
          }
        } catch {}

        // Client accounts
        try {
          const client = await pages(active, `/${bizId}/client_ad_accounts`, {
            fields: "id,name,account_status,currency",
          });
          for (const raw of client.list) {
            const id = textOf(raw.id);
            if (!id || accountMap.has(id)) continue;
            const rawName = textOf(raw.name);
            const name = bizName && !rawName.includes(bizName) ? `[${bizName}] ${rawName}` : rawName;
            accountMap.set(id, {
              id,
              name,
              currency: textOf(raw.currency, "?"),
              active: raw.account_status === 1,
            });
          }
        } catch {}
      }
    } catch {}

    const accounts = Array.from(accountMap.values()).slice(0, MAX_ACCOUNTS);
    if (accountMap.size > MAX_ACCOUNTS) accountsTruncated = true;

    const campaigns: MetaAdsRow[] = [];
    const daily: MetaAdsDay[] = [];
    let truncated = accountsTruncated;
    const failedAccounts: MetaAdsFailedAccount[] = [];
    let firstError: unknown;
    for (const account of accounts) {
      let level: Awaited<ReturnType<typeof levelRows>>;
      let perDay: Awaited<ReturnType<typeof pages>>;
      try {
        [level, perDay] = await Promise.all([
          levelRows(active, account.id, account.id, "campaign", range),
          pages(active, `/${account.id}/insights`, {
            date_preset: range,
            time_increment: 1,
            fields: "spend,actions,action_values",
          }),
        ]);
      } catch (error) {
        // An expired token fails every account alike. Any other failure is of this account only.
        if (failureOf(error).state === "token-expired") throw error;
        firstError ??= error;
        failedAccounts.push({ id: account.id, name: account.name });
        continue;
      }
      campaigns.push(...level.rows);
      truncated = truncated || level.truncated || perDay.truncated;
      for (const day of perDay.list) {
        const date = textOf(day.date_start);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          daily.push({
            date,
            accountId: account.id,
            spend: numberOf(day.spend),
            revenue: purchaseValue(day.action_values),
          });
        }
      }
    }
    if (accounts.length > 0 && failedAccounts.length === accounts.length) throw firstError;
    return {
      state: "ready",
      fetchedAt: now(),
      range,
      accounts,
      campaigns,
      daily,
      changes: { enabled: active.changesAllowed && active.cap !== null, dailyCap: active.cap },
      truncated,
      failedAccounts,
    };
  }

  async function guarded<T extends { state: string }>(
    work: (active: MetaAdsModuleTools) => Promise<T>,
  ): Promise<T | MetaAdsFailure> {
    try {
      const active = await currentTools();
      if (!("graph" in active)) return active;
      return await work(active);
    } catch (error) {
      return failureOf(error);
    }
  }

  return {
    overview(query: MetaAdsQuery): Promise<MetaAdsOverview> {
      return guarded((active) => overviews.get(query.range, query.refresh, () => readOverview(active, query.range)));
    },

    children(query: MetaAdsChildrenQuery): Promise<MetaAdsChildren> {
      return guarded(async (active) => {
        const key = `${query.level}:${query.parentId}:${query.range}`;
        const read = await levels.get(key, query.refresh, () =>
          levelRows(active, query.parentId, query.accountId, query.level, query.range),
        );
        return { state: "ready" as const, rows: read.rows };
      });
    },

    async change(change: MetaAdsChange): Promise<MetaAdsChangeResult> {
      const active = await currentTools();
      if (!("graph" in active) || !active.changesAllowed || active.cap === null) {
        return { ok: false, reason: "disabled", detail: "" };
      }
      const result = await active.callTool(change.action === "pause" ? "meta_pausar" : "meta_retomar", {
        id: change.id,
      });
      // A change makes every cached reading stale.
      overviews.clear();
      levels.clear();
      return changeResultOf(result);
    },
  };
}

/** The result of a tool call as the page shows it: the first line of the refusal, without markers of other people's text. */
export function changeResultOf(result: unknown): MetaAdsChangeResult {
  const content = isDynamicRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = content.find(isDynamicRecord);
  const full = first && typeof first.text === "string" ? first.text : "";
  const isError = isDynamicRecord(result) && result.isError === true;
  if (!isError) return { ok: true };
  const detail = full
    .split("\n")
    .find((line) => line.trim() !== "" && !line.includes("<<<"))
    ?.slice(0, 300)
    .trim();
  const text = detail ?? "";
  if (/^Limite de \d+ alterações/.test(text)) return { ok: false, reason: "limit", detail: text };
  if (/^Recusado/.test(text)) return { ok: false, reason: "refused", detail: text };
  if (/desligadas|exigem um teto/.test(text)) return { ok: false, reason: "disabled", detail: text };
  return { ok: false, reason: "failed", detail: text };
}

export function isMetaAdsRange(value: unknown): value is (typeof META_ADS_RANGES)[number] {
  return isOneOf(META_ADS_RANGES, value);
}
