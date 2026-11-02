import {
  META_ADS_RANGES,
  META_ADS_STATUSES,
  type MetaAdsChange,
  type MetaAdsChangeResult,
  type MetaAdsChildren,
  type MetaAdsChildrenQuery,
  type MetaAdsOverview,
  type MetaAdsRange,
  type MetaAdsReady,
  type MetaAdsRow,
  type MetaAdsStatus,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Button,
  ChevronDown,
  ChevronRight,
  ConfirmDialog,
  IconButton,
  Label,
  NativeSelect,
  Pause,
  Play,
  RefreshCw,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createMemo, createStore, createUniqueId, For, Show } from "solid-js";
import { AppAgentsSection, type AppPageAgent } from "./AppAgentsSection";
import {
  currenciesOf,
  filterRows,
  META_SORT_KEYS,
  type MetaSortDirection,
  type MetaSortKey,
  ratesOf,
  revenueOfDays,
  sortRows,
  spendPerDay,
  totalsOf,
} from "./meta-ads-format";

export interface MetaAdsViewProps {
  /** The reading, or null before the first answer. */
  overview: MetaAdsOverview | null;
  /** A reading is in flight. */
  refreshing: boolean;
  range: MetaAdsRange;
  onRangeChange: (range: MetaAdsRange) => void;
  onRefresh: () => void;
  onBack: () => void;
  /** Opens the store page of the app, where the token is set. */
  onOpenApp: () => void;
  loadChildren: (query: Omit<MetaAdsChildrenQuery, "range" | "refresh">) => Promise<MetaAdsChildren>;
  onChange: (change: MetaAdsChange) => Promise<MetaAdsChangeResult>;
  agents: readonly AppPageAgent[];
  onAsk: (agentId: string, text: string) => Promise<boolean>;
  onOpenTasks: () => void;
}

const RANGE_LABELS = {
  today: "appPages.meta.range.today",
  yesterday: "appPages.meta.range.yesterday",
  last_7d: "appPages.meta.range.last_7d",
  last_14d: "appPages.meta.range.last_14d",
  last_30d: "appPages.meta.range.last_30d",
  this_month: "appPages.meta.range.this_month",
  last_month: "appPages.meta.range.last_month",
} as const satisfies Record<MetaAdsRange, AppTextKey>;

const STATUS_LABELS = {
  active: "appPages.meta.status.active",
  paused: "appPages.meta.status.paused",
  issue: "appPages.meta.status.issue",
  ended: "appPages.meta.status.ended",
} as const satisfies Record<MetaAdsStatus, AppTextKey>;

const COLUMN_LABELS = {
  name: "appPages.meta.col.name",
  status: "appPages.meta.col.status",
  spend: "appPages.meta.col.spend",
  purchases: "appPages.meta.col.purchases",
  cpa: "appPages.meta.col.cpa",
  roas: "appPages.meta.col.roas",
  ctr: "appPages.meta.col.ctr",
  cpc: "appPages.meta.col.cpc",
  cpm: "appPages.meta.col.cpm",
  impressions: "appPages.meta.col.impressions",
  clicks: "appPages.meta.col.clicks",
} as const satisfies Record<MetaSortKey, AppTextKey>;

const COLUMNS = META_SORT_KEYS;

const ERROR_LABELS = {
  permission: "appPages.meta.error.permission",
  rate: "appPages.meta.error.rate",
  network: "appPages.meta.error.network",
  unknown: "appPages.meta.error.unknown",
} as const satisfies Record<"permission" | "rate" | "network" | "unknown", AppTextKey>;

const CHANGE_LABELS = {
  disabled: "appPages.meta.change.disabled",
  refused: "appPages.meta.change.refused",
  limit: "appPages.meta.change.limit",
  failed: "appPages.meta.change.failed",
} as const satisfies Record<Exclude<MetaAdsChangeResult, { ok: true }>["reason"], AppTextKey>;

type Level = "campaign" | "adset" | "ad";

interface ChildrenEntry {
  phase: "loading" | "ready" | "failed";
  rows: MetaAdsRow[];
}

interface ViewState {
  accountId: string | null;
  status: MetaAdsStatus | null;
  currency: string | null;
  sortKey: MetaSortKey;
  sortDirection: MetaSortDirection;
  expanded: Record<string, boolean>;
  children: Record<string, ChildrenEntry>;
  pending: { row: MetaAdsRow; action: "pause" | "resume" } | null;
  notice: {
    tone: "ok" | "error";
    reason: Exclude<MetaAdsChangeResult, { ok: true }>["reason"] | "done";
    detail: string;
  } | null;
}

type VisibleItem =
  | { kind: "row"; key: string; row: MetaAdsRow; level: Level }
  | { kind: "note"; key: string; level: Level; phase: "loading" | "failed" | "empty" };

/** The page of the Meta Ads app: the numbers of the period, the spend per day and the campaigns down to the ads. */
export function MetaAdsView(props: MetaAdsViewProps) {
  const { t, format } = useText();
  const headingId = `app-page-meta-${createUniqueId()}`;
  const [state, setState] = createStore<ViewState>({
    accountId: null,
    status: null,
    currency: null,
    sortKey: "spend",
    sortDirection: "desc",
    expanded: {},
    children: {},
    pending: null,
    notice: null,
  });

  const errorReason = (): keyof typeof ERROR_LABELS | null =>
    props.overview?.state === "error" ? props.overview.reason : null;
  const ready = (): MetaAdsReady | null => (props.overview?.state === "ready" ? props.overview : null);

  const money = (value: number, currency: string, digits = 2): string => {
    try {
      return format.number(value, {
        style: "currency",
        currency,
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
    } catch {
      return `${format.number(value, { maximumFractionDigits: digits })} ${currency}`;
    }
  };
  const count = (value: number): string => format.number(value, { maximumFractionDigits: 0 });

  /** The currencies that the account filter leaves in. */
  const currencies = createMemo(() => {
    const data = ready();
    return data ? currenciesOf(data.accounts, data.campaigns, state.accountId) : [];
  });
  /** The currency in view: the owner's choice if it still applies, else the one with the most spend. */
  const currency = createMemo(() => {
    const list = currencies();
    return state.currency !== null && list.includes(state.currency) ? state.currency : (list[0] ?? null);
  });
  const filtered = createMemo(() => {
    const data = ready();
    return data
      ? filterRows(data.campaigns, data.accounts, {
          accountId: state.accountId,
          status: state.status,
          currency: currency(),
        })
      : [];
  });
  const totals = createMemo(() => totalsOf(filtered()));
  const rates = createMemo(() => ratesOf(totals()));
  const days = createMemo(() => {
    const data = ready();
    return data ? spendPerDay(data.daily, data.accounts, { accountId: state.accountId, currency: currency() }) : [];
  });
  const dayRevenue = createMemo(() => {
    const data = ready();
    return data ? revenueOfDays(data.daily, data.accounts, { accountId: state.accountId, currency: currency() }) : null;
  });
  const maxDay = createMemo(() => Math.max(0, ...days().map((day) => day.spend)));
  const sorted = createMemo(() => sortRows(filtered(), state.sortKey, state.sortDirection));

  const accountCurrency = (accountId: string): string =>
    ready()?.accounts.find((account) => account.id === accountId)?.currency ?? currency() ?? "";

  const visible = createMemo<VisibleItem[]>(() => {
    const items: VisibleItem[] = [];
    const walk = (rows: readonly MetaAdsRow[], level: Level) => {
      for (const row of rows) {
        items.push({ kind: "row", key: `${level}:${row.id}`, row, level });
        const next: Level | null = level === "campaign" ? "adset" : level === "adset" ? "ad" : null;
        if (!next || !state.expanded[row.id]) continue;
        const entry = state.children[`${next}:${row.id}`];
        if (!entry || entry.phase === "loading")
          items.push({ kind: "note", key: `note:${row.id}`, level: next, phase: "loading" });
        else if (entry.phase === "failed")
          items.push({ kind: "note", key: `note:${row.id}`, level: next, phase: "failed" });
        else if (entry.rows.length === 0)
          items.push({ kind: "note", key: `note:${row.id}`, level: next, phase: "empty" });
        else walk(sortRows(entry.rows, state.sortKey, state.sortDirection), next);
      }
    };
    walk(sorted(), "campaign");
    return items;
  });

  async function toggle(row: MetaAdsRow, level: Level): Promise<void> {
    const next: "adset" | "ad" | null = level === "campaign" ? "adset" : level === "adset" ? "ad" : null;
    if (!next) return;
    const open = state.expanded[row.id] === true;
    setState((draft) => {
      draft.expanded[row.id] = !open;
    });
    const key = `${next}:${row.id}`;
    if (open || state.children[key]?.phase === "ready") return;
    setState((draft) => {
      draft.children[key] = { phase: "loading", rows: [] };
    });
    let answer: MetaAdsChildren;
    try {
      answer = await props.loadChildren({ level: next, parentId: row.id, accountId: row.accountId });
    } catch {
      answer = { state: "error", reason: "unknown" };
    }
    setState((draft) => {
      draft.children[key] =
        answer.state === "ready" ? { phase: "ready", rows: answer.rows } : { phase: "failed", rows: [] };
    });
  }

  function sortBy(key: MetaSortKey): void {
    setState((draft) => {
      if (draft.sortKey === key) draft.sortDirection = draft.sortDirection === "asc" ? "desc" : "asc";
      else {
        draft.sortKey = key;
        draft.sortDirection = key === "name" || key === "status" ? "asc" : "desc";
      }
    });
  }

  async function confirmChange(): Promise<void> {
    const pending = state.pending;
    if (!pending) return;
    let result: MetaAdsChangeResult;
    try {
      result = await props.onChange({ id: pending.row.id, action: pending.action });
    } catch {
      result = { ok: false, reason: "failed", detail: "" };
    }
    setState((draft) => {
      draft.pending = null;
      draft.children = {};
      draft.expanded = {};
      draft.notice = result.ok
        ? { tone: "ok", reason: "done", detail: "" }
        : { tone: "error", reason: result.reason, detail: result.detail };
    });
    if (result.ok) props.onRefresh();
  }

  const ariaSort = (key: MetaSortKey): "ascending" | "descending" | "none" =>
    state.sortKey !== key ? "none" : state.sortDirection === "asc" ? "ascending" : "descending";

  const kpis = createMemo(() => {
    const code = currency() ?? "";
    const current = totals();
    const rate = rates();
    const none = t("appPages.meta.kpi.none");
    const revenue = current.revenue ?? dayRevenue();
    return [
      { id: "spend", label: t("appPages.meta.kpi.spend"), value: money(current.spend, code) },
      { id: "revenue", label: t("appPages.meta.kpi.revenue"), value: revenue === null ? none : money(revenue, code) },
      {
        id: "roas",
        label: t("appPages.meta.kpi.roas"),
        value: rate.roas === null ? none : `${format.number(rate.roas, { maximumFractionDigits: 2 })}x`,
      },
      { id: "purchases", label: t("appPages.meta.kpi.purchases"), value: count(current.purchases) },
      { id: "cpa", label: t("appPages.meta.kpi.cpa"), value: rate.cpa === null ? none : money(rate.cpa, code) },
      {
        id: "ctr",
        label: t("appPages.meta.kpi.ctr"),
        value: rate.ctr === null ? none : format.percent(rate.ctr, { maximumFractionDigits: 2 }),
      },
      { id: "cpc", label: t("appPages.meta.kpi.cpc"), value: rate.cpc === null ? none : money(rate.cpc, code) },
      { id: "cpm", label: t("appPages.meta.kpi.cpm"), value: rate.cpm === null ? none : money(rate.cpm, code) },
      { id: "impressions", label: t("appPages.meta.kpi.impressions"), value: count(current.impressions) },
      { id: "clicks", label: t("appPages.meta.kpi.clicks"), value: count(current.clicks) },
    ];
  });

  const dayLabel = (date: string): string => {
    const [year, month, day] = date.split("-").map(Number);
    return format.date(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1), { day: "2-digit", month: "2-digit" });
  };

  const cell = (row: MetaAdsRow) => {
    const rate = ratesOf(totalsOf([row]));
    const code = accountCurrency(row.accountId);
    const none = t("appPages.meta.kpi.none");
    return {
      spend: money(row.spend, code),
      purchases: count(row.purchases),
      cpa: rate.cpa === null ? none : money(rate.cpa, code),
      roas: rate.roas === null ? none : `${format.number(rate.roas, { maximumFractionDigits: 2 })}x`,
      ctr: rate.ctr === null ? none : format.percent(rate.ctr, { maximumFractionDigits: 2 }),
      cpc: rate.cpc === null ? none : money(rate.cpc, code),
      cpm: rate.cpm === null ? none : money(rate.cpm, code),
      impressions: count(row.impressions),
      clicks: count(row.clicks),
    };
  };

  const rowOf = (item: VisibleItem) => (item.kind === "row" ? item : undefined);
  const noteText = (item: VisibleItem): string => {
    if (item.kind !== "note") return "";
    if (item.phase === "loading") return t("appPages.meta.children.loading");
    return item.phase === "failed" ? t("appPages.meta.children.failed") : t("appPages.meta.children.empty");
  };

  const rangeLabel = () => t(RANGE_LABELS[props.range]);
  const noticeText = (): string => {
    const notice = state.notice;
    if (!notice) return "";
    return notice.reason === "done" ? t("appPages.meta.change.done") : t(CHANGE_LABELS[notice.reason]);
  };

  return (
    <section class="agent-usage app-page" aria-labelledby={headingId}>
      <header class="agent-usage-header">
        <div class="agent-usage-identity">
          <IconButton variant="ghost" label={t("common.back")} onClick={props.onBack}>
            <ArrowLeft />
          </IconButton>
          <h2 id={headingId}>{t("appPages.meta.title")}</h2>
        </div>
        <div class="agent-usage-controls">
          <Label class="app-page-visually-hidden" for={`${headingId}-range`}>
            {t("appPages.meta.range.label")}
          </Label>
          <NativeSelect
            id={`${headingId}-range`}
            size="sm"
            value={props.range}
            onChange={(event) => {
              const next = META_ADS_RANGES.find((range) => range === event.currentTarget.value);
              if (next) props.onRangeChange(next);
            }}
          >
            <For each={META_ADS_RANGES}>{(range) => <option value={range}>{t(RANGE_LABELS[range])}</option>}</For>
          </NativeSelect>
          <IconButton
            variant="outline"
            label={t("appPages.refresh")}
            disabled={props.refreshing}
            onClick={props.onRefresh}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </header>
      <div class="agent-usage-body app-page-body">
        <p class="app-page-risk" role="note">
          <TriangleAlert aria-hidden="true" />
          <span>{t("appPages.meta.risk")}</span>
        </p>
        <Show when={state.notice}>
          {(notice) => (
            <p
              class="app-page-status"
              data-tone={notice().tone === "ok" ? "ok" : "error"}
              role={notice().tone === "ok" ? "status" : "alert"}
            >
              {noticeText()}
              <Show when={notice().tone === "error" && notice().detail !== ""}>
                <span class="app-page-muted"> {notice().detail}</span>
              </Show>
            </p>
          )}
        </Show>

        <Show when={props.overview === null}>
          <div class="agent-usage-loading" role="status">
            <span>{t("appPages.loading")}</span>
            <div class="agent-usage-placeholder" />
          </div>
        </Show>
        <Show when={props.overview?.state === "not-connected"}>
          <div class="app-page-empty">
            <h3>{t("appPages.meta.notConnected.title")}</h3>
            <p>{t("appPages.meta.notConnected.body")}</p>
            <Button onClick={props.onOpenApp}>{t("appPages.meta.notConnected.action")}</Button>
          </div>
        </Show>
        <Show when={props.overview?.state === "token-expired"}>
          <div class="app-page-empty">
            <h3>{t("appPages.meta.expired.title")}</h3>
            <p>{t("appPages.meta.expired.body")}</p>
            <Button onClick={props.onOpenApp}>{t("appPages.meta.expired.action")}</Button>
          </div>
        </Show>
        <Show when={errorReason()}>
          {(reason) => (
            <div class="app-page-empty">
              <p role="alert">{t(ERROR_LABELS[reason()])}</p>
              <Button variant="secondary" onClick={props.onRefresh}>
                {t("common.retry")}
              </Button>
            </div>
          )}
        </Show>

        <Show when={ready()}>
          {(data) => (
            <>
              <p class="app-page-muted">
                {t("appPages.updated", { time: format.date(data().fetchedAt, { hour: "2-digit", minute: "2-digit" }) })}
              </p>
              <Show when={data().failedAccounts.length > 0}>
                <p class="app-page-status" data-tone="error" role="alert">
                  {t("appPages.meta.accountsFailed", {
                    names: format.list(data().failedAccounts.map((account) => account.name)),
                  })}
                </p>
              </Show>
              <Show when={data().truncated}>
                <p class="app-page-status" role="status">
                  {t("appPages.meta.truncated")}
                </p>
              </Show>
              <div class="app-page-filters">
                <div class="app-page-field">
                  <Label for={`${headingId}-account`}>{t("appPages.meta.account.label")}</Label>
                  <NativeSelect
                    id={`${headingId}-account`}
                    size="sm"
                    value={state.accountId ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setState((draft) => {
                        draft.accountId = value === "" ? null : value;
                      });
                    }}
                  >
                    <option value="">{t("appPages.meta.account.all")}</option>
                    <For each={data().accounts}>
                      {(account) => (
                        <option value={account.id}>
                          {account.active ? account.name : t("appPages.meta.account.inactive", { name: account.name })}
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                </div>
                <div class="app-page-field">
                  <span class="app-page-field-label" id={`${headingId}-status`}>
                    {t("appPages.meta.status.label")}
                  </span>
                  <fieldset class="app-page-segments" aria-labelledby={`${headingId}-status`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="app-page-segment"
                      aria-pressed={state.status === null ? "true" : "false"}
                      onClick={() =>
                        setState((draft) => {
                          draft.status = null;
                        })
                      }
                    >
                      {t("appPages.meta.status.all")}
                    </Button>
                    <For each={META_ADS_STATUSES}>
                      {(status) => (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          class="app-page-segment"
                          aria-pressed={state.status === status ? "true" : "false"}
                          onClick={() =>
                            setState((draft) => {
                              draft.status = status;
                            })
                          }
                        >
                          {t(STATUS_LABELS[status])}
                        </Button>
                      )}
                    </For>
                  </fieldset>
                </div>
                <Show when={currencies().length > 1}>
                  <div class="app-page-field">
                    <span class="app-page-field-label" id={`${headingId}-currency`}>
                      {t("appPages.meta.currency.label")}
                    </span>
                    <fieldset class="app-page-segments" aria-labelledby={`${headingId}-currency`}>
                      <For each={currencies()}>
                        {(code) => (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="app-page-segment"
                            aria-pressed={currency() === code ? "true" : "false"}
                            onClick={() =>
                              setState((draft) => {
                                draft.currency = code;
                              })
                            }
                          >
                            {code}
                          </Button>
                        )}
                      </For>
                    </fieldset>
                  </div>
                </Show>
              </div>
              <Show when={currencies().length > 1}>
                <p class="app-page-muted">{t("appPages.meta.currency.note")}</p>
              </Show>

              <Show
                when={data().campaigns.length > 0 || data().daily.length > 0}
                fallback={
                  <div class="app-page-empty">
                    <h3>{t("appPages.meta.empty.title")}</h3>
                    <p>{t("appPages.meta.empty.body")}</p>
                  </div>
                }
              >
                <div class="app-page-kpis">
                  <For each={kpis()}>
                    {(kpi) => (
                      <div class="app-page-kpi">
                        <span class="app-page-kpi-label">{kpi.label}</span>
                        <strong class="app-page-kpi-value">{kpi.value}</strong>
                      </div>
                    )}
                  </For>
                </div>

                <section class="app-page-card" aria-label={t("appPages.meta.chart.title")}>
                  <h3>{t("appPages.meta.chart.title")}</h3>
                  <Show
                    when={days().length > 0 && maxDay() > 0}
                    fallback={<p class="app-page-muted">{t("appPages.meta.chart.empty")}</p>}
                  >
                    <ul class="app-page-chart">
                      <For each={days()}>
                        {(day) => (
                          <li
                            class="app-page-bar"
                            title={t("appPages.meta.chart.day", {
                              date: dayLabel(day.date),
                              amount: money(day.spend, currency() ?? ""),
                            })}
                            aria-label={t("appPages.meta.chart.day", {
                              date: dayLabel(day.date),
                              amount: money(day.spend, currency() ?? ""),
                            })}
                          >
                            <span
                              class="app-page-bar-fill"
                              style={{ height: `${Math.max(2, (day.spend / maxDay()) * 100)}%` }}
                            />
                            <span class="app-page-bar-date" aria-hidden="true">
                              {dayLabel(day.date)}
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>

                <section class="app-page-card" aria-labelledby={`${headingId}-table`}>
                  <h3 id={`${headingId}-table`}>{t("appPages.meta.table.title")}</h3>
                  <Show when={!data().changes.enabled}>
                    <p class="app-page-muted">{t("appPages.meta.readOnly")}</p>
                  </Show>
                  <Show
                    when={visible().length > 0}
                    fallback={<p class="app-page-muted">{t("appPages.meta.table.empty")}</p>}
                  >
                    <div class="app-page-table-wrap">
                      <table class="app-page-table">
                        <thead>
                          <tr>
                            <For each={COLUMNS}>
                              {(key) => (
                                <th
                                  scope="col"
                                  aria-sort={ariaSort(key)}
                                  data-numeric={key === "name" || key === "status" ? undefined : "true"}
                                >
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    class="app-page-sort"
                                    aria-label={t("appPages.meta.sortBy", { column: t(COLUMN_LABELS[key]) })}
                                    onClick={() => sortBy(key)}
                                  >
                                    {t(COLUMN_LABELS[key])}
                                    <Show when={state.sortKey === key}>
                                      {state.sortDirection === "asc" ? (
                                        <ArrowUp aria-hidden="true" />
                                      ) : (
                                        <ArrowDown aria-hidden="true" />
                                      )}
                                    </Show>
                                  </Button>
                                </th>
                              )}
                            </For>
                            <Show when={data().changes.enabled}>
                              <th scope="col">{t("appPages.meta.col.actions")}</th>
                            </Show>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={visible()} keyed={(item) => item.key}>
                            {(item) => (
                              <Show
                                when={rowOf(item())}
                                fallback={
                                  <tr class="app-page-note-row">
                                    <td colspan={COLUMNS.length + (data().changes.enabled ? 1 : 0)}>
                                      {noteText(item())}
                                    </td>
                                  </tr>
                                }
                              >
                                {(entry) => {
                                  const row = () => entry().row;
                                  const level = () => entry().level;
                                  const numbers = () => cell(row());
                                  return (
                                    <tr data-level={level()}>
                                      <th scope="row" class="app-page-name">
                                        <span class="app-page-name-line" data-level={level()}>
                                          <Show
                                            when={level() !== "ad"}
                                            fallback={<span class="app-page-chevron-space" />}
                                          >
                                            <IconButton
                                              variant="ghost"
                                              class="app-page-expand"
                                              aria-expanded={state.expanded[row().id] === true ? "true" : "false"}
                                              label={
                                                state.expanded[row().id] === true
                                                  ? t("appPages.meta.collapse", { name: row().name })
                                                  : level() === "campaign"
                                                    ? t("appPages.meta.expand.campaign", { name: row().name })
                                                    : t("appPages.meta.expand.adset", { name: row().name })
                                              }
                                              onClick={() => void toggle(row(), level())}
                                            >
                                              {state.expanded[row().id] === true ? (
                                                <ChevronDown aria-hidden="true" />
                                              ) : (
                                                <ChevronRight aria-hidden="true" />
                                              )}
                                            </IconButton>
                                          </Show>
                                          <span class="app-page-name-text">{row().name}</span>
                                        </span>
                                      </th>
                                      <td>
                                        <span class="app-page-pill" data-status={row().status}>
                                          {t(STATUS_LABELS[row().status])}
                                        </span>
                                      </td>
                                      <td data-numeric="true">{numbers().spend}</td>
                                      <td data-numeric="true">{numbers().purchases}</td>
                                      <td data-numeric="true">{numbers().cpa}</td>
                                      <td data-numeric="true">{numbers().roas}</td>
                                      <td data-numeric="true">{numbers().ctr}</td>
                                      <td data-numeric="true">{numbers().cpc}</td>
                                      <td data-numeric="true">{numbers().cpm}</td>
                                      <td data-numeric="true">{numbers().impressions}</td>
                                      <td data-numeric="true">{numbers().clicks}</td>
                                      <Show when={data().changes.enabled}>
                                        <td>
                                          <Show when={row().status === "active" || row().status === "paused"}>
                                            <Button
                                              type="button"
                                              variant="outline"
                                              size="sm"
                                              aria-label={
                                                row().status === "active"
                                                  ? t("appPages.meta.pauseLabel", { name: row().name })
                                                  : t("appPages.meta.resumeLabel", { name: row().name })
                                              }
                                              onClick={() =>
                                                setState((draft) => {
                                                  draft.pending = {
                                                    row: row(),
                                                    action: row().status === "active" ? "pause" : "resume",
                                                  };
                                                })
                                              }
                                            >
                                              {row().status === "active" ? (
                                                <Pause aria-hidden="true" />
                                              ) : (
                                                <Play aria-hidden="true" />
                                              )}
                                              {row().status === "active"
                                                ? t("appPages.meta.pause")
                                                : t("appPages.meta.resume")}
                                            </Button>
                                          </Show>
                                        </td>
                                      </Show>
                                    </tr>
                                  );
                                }}
                              </Show>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </section>
              </Show>
            </>
          )}
        </Show>

        <AppAgentsSection
          title={t("appPages.agents.title")}
          guideTitle={t("appPages.meta.guide.title")}
          guideBody={t("appPages.meta.guide.body")}
          draft={t("appPages.meta.guide.draft", { period: rangeLabel().toLowerCase() })}
          agents={props.agents}
          onAsk={props.onAsk}
          onOpenTasks={props.onOpenTasks}
        />
      </div>

      <ConfirmDialog
        open={state.pending !== null}
        tone={state.pending?.action === "resume" ? "destructive" : "default"}
        icon={state.pending?.action === "resume" ? <Play /> : <Pause />}
        title={
          state.pending?.action === "resume"
            ? t("appPages.meta.confirm.resumeTitle", { name: state.pending.row.name })
            : t("appPages.meta.confirm.pauseTitle", { name: state.pending?.row.name ?? "" })
        }
        description={
          state.pending?.action === "resume"
            ? t("appPages.meta.confirm.resumeBody", {
                cap: money(ready()?.changes.dailyCap ?? 0, accountCurrency(state.pending.row.accountId), 0),
              })
            : t("appPages.meta.confirm.pauseBody")
        }
        confirmLabel={
          state.pending?.action === "resume"
            ? t("appPages.meta.confirm.resumeAction")
            : t("appPages.meta.confirm.pauseAction")
        }
        onCancel={() =>
          setState((draft) => {
            draft.pending = null;
          })
        }
        onConfirm={confirmChange}
      />
    </section>
  );
}
