import { type AnalyticsTotals, analyticsTokens, type HostAnalytics } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  ArrowRight,
  Button,
  ChartNoAxesColumnIncreasing,
  Database,
  Download,
  Layers,
  MessageSquare,
  SlidingTabs,
  Upload,
  Zap,
} from "@openbot/ui";
import { Dynamic, type JSX } from "@solidjs/web";
import { type Component, createMemo, createStore, For, onSettled, Show } from "solid-js";
import { useText } from "../../text";
import { UsageChart } from "./UsageChart";
import { UsageProviderMark } from "./UsageProviderMark";
import {
  type UsageAgentLabel,
  type UsageMetric,
  type UsagePeriod,
  usageCompact,
  usageCost,
  usageExactCost,
  usageNumber,
  usagePeriodLabels,
  usageProviderName,
  usageProviders,
  usageSeriesColor,
} from "./usage-format";

type UsageTotalField = "processedTokens" | "cachedInput" | "uncachedInput" | "cacheCreation" | "output";

const TOTAL_ROWS = [
  { field: "processedTokens", label: "usage.totals.processedTokens", icon: Zap },
  { field: "cachedInput", label: "usage.totals.cachedInput", icon: Download },
  { field: "uncachedInput", label: "usage.totals.uncachedInput", icon: Upload },
  { field: "cacheCreation", label: "usage.totals.cacheCreation", icon: Layers },
  { field: "output", label: "usage.totals.output", icon: ArrowRight },
] as const satisfies ReadonlyArray<{ field: UsageTotalField; label: AppTextKey; icon: Component }>;

/** One compact total: a colored tile, its label and its value. */
function TotalCard(props: { icon: Component; label: string; children: JSX.Element; title?: string | undefined }) {
  return (
    <div title={props.title}>
      <span class="agent-usage-total-tile" aria-hidden="true">
        <Dynamic component={props.icon} />
      </span>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

// The fields that `Date.prototype.toLocaleString()` shows when it gets no options.
const UPDATED_AT_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

function Amount(props: { value: number | null; cost?: boolean }) {
  const text = useText();
  return (
    <>
      <span aria-hidden="true">{props.cost ? usageCost(props.value, text) : usageCompact(props.value, text)}</span>
      <span class="sr-only">{props.cost ? usageExactCost(props.value, text) : usageNumber(props.value, text)}</span>
    </>
  );
}
// The model and agent tables carry the same three value columns, so they share them and
// the metric switch changes the same one column in both by construction. The headers name
// the measure only: every cost cell carries its currency, and the note under the tables
// already says a share is of the known amount.
function BreakdownColumns(props: { label: string }) {
  const { t } = useText();
  return (
    <tr>
      <th scope="col">{props.label}</th>
      <th scope="col">{t("usage.column.cost")}</th>
      <th scope="col">{t("usage.column.share")}</th>
      <th scope="col">{t("usage.column.tokens")}</th>
    </tr>
  );
}
function BreakdownCells(props: { row: AnalyticsTotals; cost: boolean; share: (amount: number | null) => string }) {
  return (
    <>
      <td>
        <Amount value={props.row.estimatedCostUsd} cost />
      </td>
      <td>
        <span class="agent-usage-share">
          {props.share(props.cost ? props.row.estimatedCostUsd : analyticsTokens(props.row))}
        </span>
      </td>
      <td>
        <Amount value={analyticsTokens(props.row)} />
      </td>
    </>
  );
}
export function AgentUsageReport(props: {
  result: HostAnalytics;
  metric: UsageMetric;
  /** Named in the label above the total. */
  period?: UsagePeriod | undefined;
  agentLabel: (agentId: string) => UsageAgentLabel;
  onReady: () => void;
}) {
  const text = useText();
  const { t, format } = text;
  onSettled(() => queueMicrotask(props.onReady));
  // The host report answers "which teammate spent this" first, so the split by agent is
  // the tab that opens.
  const [state, setState] = createStore({ breakdown: "agent" });
  const totals = () => props.result.totals;
  const cost = () => props.metric === "cost";
  const providers = createMemo(() =>
    usageProviders(props.result.models).sort((a, b) =>
      cost() ? (b.cost ?? -1) - (a.cost ?? -1) : b.tokens - a.tokens,
    ),
  );
  const models = createMemo(() =>
    [...props.result.models].sort((a, b) =>
      cost() ? (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) : analyticsTokens(b) - analyticsTokens(a),
    ),
  );
  const agents = createMemo(() =>
    [...props.result.agents].sort((a, b) =>
      cost() ? (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1) : analyticsTokens(b) - analyticsTokens(a),
    ),
  );
  const partial = () =>
    totals().missingUsageTurns > 0 || totals().unpricedRecords > 0 || totals().incompleteRecords > 0;
  const share = (amount: number | null) => {
    const total = cost() ? totals().estimatedCostUsd : analyticsTokens(totals());
    return amount === null || total === null
      ? t("usage.unavailable")
      : format.percent(total ? amount / total : 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  };
  const messageDetail = () =>
    `${t("usage.totals.userMessages")}: ${usageNumber(totals().userMessages, text)} · ${t("usage.totals.assistantMessages")}: ${usageNumber(totals().assistantMessages, text)}`;
  let dailyTable: HTMLTableElement | undefined;
  function showDailyData() {
    setState((draft) => {
      draft.breakdown = "day";
    });
    queueMicrotask(() => dailyTable?.focus());
  }
  return (
    <>
      <Show when={!totals().turns && !totals().userMessages && !totals().processedTokens}>
        <p class="agent-usage-notice" role="status">
          {t("usage.empty")}
        </p>
      </Show>
      <Show when={partial()}>
        <p class="agent-usage-notice" role="status">
          {t("usage.partial", {
            turns: totals().missingUsageTurns,
            unpriced: totals().unpricedRecords,
            incomplete: totals().incompleteRecords,
          })}
        </p>
      </Show>
      <section class="agent-usage-summary" aria-label={t("usage.summary")}>
        <div class="agent-usage-hero-card">
          <span class="agent-usage-hero-tile" aria-hidden="true">
            <ChartNoAxesColumnIncreasing />
          </span>
          <div class="agent-usage-hero-copy">
            <p class="agent-usage-hero-label">
              {cost() ? t("usage.metric.cost") : t("usage.metric.tokens")}
              <Show when={props.period}>{(period) => <> · {t(usagePeriodLabels[period()])}</>}</Show>
            </p>
            <p class="agent-usage-hero">
              <Amount value={cost() ? totals().estimatedCostUsd : analyticsTokens(totals())} cost={cost()} />
            </p>
            <p class="agent-usage-secondary">
              {t("usage.sessions", { count: totals().sessions, sessions: usageNumber(totals().sessions, text) })} ·{" "}
              {cost() ? t("usage.costEstimate") : t("usage.knownTokens")}
            </p>
          </div>
        </div>
        <div class="agent-usage-providers">
          <div class="agent-usage-section-header">
            <h3>{cost() ? t("usage.dailyCost") : t("usage.dailyTokens")}</h3>
            <Button variant="ghost" size="xs" onClick={showDailyData}>
              {t("usage.viewDailyData")}
            </Button>
          </div>
          <div class="agent-usage-provider-list">
            <For each={providers()}>
              {(provider) => (
                <div class="agent-usage-provider">
                  {/* The chart below needs a legend, and this list names every series, so the tile
                      has the color of the provider rather than of the row's place in the list. */}
                  <span
                    class="agent-usage-provider-tile"
                    style={{ background: usageSeriesColor(provider.provider) }}
                    aria-hidden="true"
                  />
                  <div class="agent-usage-provider-heading">
                    <span>
                      <UsageProviderMark provider={provider.provider} />
                      {usageProviderName(provider.provider)}
                    </span>
                    <strong>
                      <Amount value={cost() ? provider.cost : provider.tokens} cost={cost()} />
                    </strong>
                  </div>
                  <p>
                    {/* A provider with no known cost has no share of it, and its heading already says so. */}
                    <Show when={!cost() || provider.cost !== null}>
                      {cost()
                        ? t("usage.provider.shareOfCost", { share: share(provider.cost) })
                        : t("usage.provider.shareOfTokens", { share: share(provider.tokens) })}{" "}
                      ·{" "}
                    </Show>
                    {cost()
                      ? t("usage.tokensAmount", { tokens: usageCompact(provider.tokens, text) })
                      : usageCost(provider.cost, text)}
                  </p>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>
      <section class="agent-usage-totals-section" aria-label={t("usage.totals.title")}>
        <h3>{t("usage.totals.title")}</h3>
        <dl class="agent-usage-totals">
          <TotalCard icon={Database} label={t("usage.totals.tokens")}>
            <Amount value={analyticsTokens(totals())} />
          </TotalCard>
          <For each={TOTAL_ROWS}>
            {(item) => (
              <TotalCard icon={item.icon} label={t(item.label)}>
                <Amount value={totals()[item.field]} />
              </TotalCard>
            )}
          </For>
          {/* The two message counts share one card. Its title and the spoken text keep each value. */}
          <TotalCard icon={MessageSquare} label={t("usage.totals.messages")} title={messageDetail()}>
            <span aria-hidden="true">{usageCompact(totals().userMessages + totals().assistantMessages, text)}</span>
            <span class="sr-only">{messageDetail()}</span>
          </TotalCard>
        </dl>
      </section>
      <section class="agent-usage-breakdown">
        <SlidingTabs.Root
          value={state.breakdown}
          onChange={(value) =>
            setState((draft) => {
              draft.breakdown = value;
            })
          }
        >
          <div class="agent-usage-section-header">
            <h3>{t("usage.breakdown.title")}</h3>
            <SlidingTabs.List aria-label={t("usage.breakdown.label")}>
              <SlidingTabs.Trigger value="model">{t("usage.breakdown.model")}</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="agent">{t("usage.breakdown.agent")}</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="day">{t("usage.breakdown.day")}</SlidingTabs.Trigger>
            </SlidingTabs.List>
          </div>
          {/* Every panel is force-mounted, and the grid slot is what makes the hidden ones
            share one cell instead of each reserving its own height below the visible table. */}
          <SlidingTabs.ContentSlot>
            <SlidingTabs.Content value="model">
              <div class="agent-usage-table">
                <table>
                  <caption class="sr-only">{t("usage.breakdown.byModel")}</caption>
                  <thead>
                    <BreakdownColumns label={t("usage.breakdown.model")} />
                  </thead>
                  <tbody>
                    <For each={models()}>
                      {(model) => (
                        <tr>
                          <th scope="row">
                            <span class="agent-usage-model-name">
                              <UsageProviderMark provider={model.provider} />
                              <span>
                                {model.model || t("usage.unknownModel")}
                                {/* The logo carries the provider for a reader who sees it, and the
                                  row stays one line high; the name is still spoken. */}
                                <span class="sr-only">{usageProviderName(model.provider)}</span>
                              </span>
                            </span>
                          </th>
                          <BreakdownCells row={model} cost={cost()} share={share} />
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </SlidingTabs.Content>
            <SlidingTabs.Content value="agent">
              <div class="agent-usage-table">
                <table>
                  <caption class="sr-only">{t("usage.breakdown.byAgent")}</caption>
                  <thead>
                    <BreakdownColumns label={t("usage.breakdown.agent")} />
                  </thead>
                  <tbody>
                    <For each={agents()}>
                      {(agent) => (
                        <tr>
                          <th scope="row">
                            <span class="agent-usage-model-name">
                              <UsageProviderMark provider={props.agentLabel(agent.agentId).provider} />
                              <span>{props.agentLabel(agent.agentId).name}</span>
                            </span>
                          </th>
                          <BreakdownCells row={agent} cost={cost()} share={share} />
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </SlidingTabs.Content>
            <SlidingTabs.Content value="day">
              <div class="agent-usage-table">
                <table ref={dailyTable} tabindex={-1}>
                  <caption class="sr-only">{t("usage.breakdown.byDay")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("usage.column.date")}</th>
                      <th scope="col">{t("usage.column.costUsd")}</th>
                      <th scope="col">{t("usage.column.tokens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={[...props.result.daily].reverse()}>
                      {(day) => (
                        <tr>
                          <th scope="row">{day.date}</th>
                          <td>{usageExactCost(day.estimatedCostUsd, text)}</td>
                          <td>{usageNumber(analyticsTokens(day), text)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </SlidingTabs.Content>
          </SlidingTabs.ContentSlot>
        </SlidingTabs.Root>
      </section>
      <section class="agent-usage-trend" aria-label={t("usage.dailyTrend")}>
        <h3>{t("usage.dailyTrend")}</h3>
        <UsageChart result={props.result} metric={props.metric} />
      </section>
      <footer class="agent-usage-footer">
        <p>
          {t("usage.footer", {
            started: format.date(new Date(props.result.collectionStartedAt)),
            updated: props.result.updatedAt
              ? format.date(new Date(props.result.updatedAt), UPDATED_AT_FORMAT)
              : t("usage.updatedNever"),
          })}
        </p>
        <details>
          <summary>{t("usage.about.title")}</summary>
          <p>{t("usage.about.body")}</p>
          <p>{t("usage.about.tokens")}</p>
        </details>
      </footer>
    </>
  );
}
