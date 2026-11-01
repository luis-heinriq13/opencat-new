import {
  ATTENDANCE_PERIODS,
  type AttendanceAttentionItem,
  type AttendancePeriod,
  type AttendanceReport,
  appConnectionState,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { ArrowLeft, Button, CircleAlert, Hand, IconButton, Input, Pause, Play, TriangleAlert } from "@openbot/ui";
import { Area, AreaChart, ChartContainer, ChartTooltip, ChartTooltipContent, XAxis, YAxis } from "@openbot/ui/chart";
import { useText } from "@openbot/ui/text";
import { Dynamic } from "@solidjs/web";
import { createMemo, For, onSettled, Show } from "solid-js";
import { attendanceTrend, heatLevel, peakCell, savedMinutes, shareOf, sparklineSeries } from "./attendance-format";
import { WhatsAppIcon } from "./WhatsAppIcon";

export interface AttendanceViewProps {
  /** The report, or null before the first answer. */
  report: AttendanceReport | null;
  phase: "loading" | "ready" | "error";
  period: AttendancePeriod;
  onPeriodChange: (period: AttendancePeriod) => void;
  /** The name of the connected agent, or null. */
  agentName: string | null;
  minutesPerReply: number;
  onMinutesPerReplyChange: (minutes: number) => void;
  /** A pause or resume is in flight. */
  busy?: boolean | undefined;
  /** The last pause or resume failed. */
  actionFailed?: boolean | undefined;
  onPause: () => void;
  onResume: () => void;
  /** Makes the agent answer one paused conversation again. */
  onResumeConversation: (ref: string) => void;
  onOpenStore: () => void;
  onRetry: () => void;
  onBack: () => void;
}

const PERIOD_LABELS = {
  today: "attendance.period.today",
  "7d": "attendance.period.7d",
  "30d": "attendance.period.30d",
} as const satisfies Record<AttendancePeriod, AppTextKey>;

const STATE_LABELS = {
  on: "attendance.state.on",
  paused: "attendance.state.paused",
  none: "attendance.state.none",
} as const satisfies Record<"on" | "paused" | "none", AppTextKey>;

const EVENT_LABELS = {
  humano: "attendance.attention.humano",
  bloqueada: "attendance.attention.bloqueada",
  falhou: "attendance.attention.falhou",
} as const satisfies Record<AttendanceAttentionItem["event"], AppTextKey>;

const FAILURE_LABELS = {
  limite: "attendance.failures.limite",
  motor: "attendance.failures.motor",
  entrega: "attendance.failures.entrega",
  agente: "attendance.failures.agente",
  outro: "attendance.failures.outro",
} as const satisfies Record<AttendanceReport["failures"][number]["category"], AppTextKey>;

const SPARK = { width: 160, height: 44 };

/** A small line of the replies over the period. The main series, so it wears the accent. */
function Sparkline(props: { values: readonly number[]; label: string }) {
  const path = createMemo(() => {
    const max = Math.max(1, ...props.values);
    const step = props.values.length > 1 ? SPARK.width / (props.values.length - 1) : 0;
    return props.values
      .map((value, index) => {
        const x = index * step;
        const y = SPARK.height - 3 - (value / max) * (SPARK.height - 6);
        return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  });
  return (
    <svg
      class="attendance-spark"
      viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <path d={path()} fill="none" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** The page of the WhatsApp attendance: how the agent answers, from counts and times that the bridge keeps. */
export function AttendanceView(props: AttendanceViewProps) {
  const { t, format } = useText();
  const state = () => (props.report ? appConnectionState(props.report.connection) : "none");
  const connected = () => state() !== "none";
  const showEmpty = () => props.phase === "ready" && props.report !== null && !props.report.hasData && !connected();
  const duration = (ms: number | null): string => {
    if (ms === null) return t("attendance.duration.none");
    const seconds = ms / 1000;
    if (seconds < 60) {
      return t("attendance.duration.seconds", {
        value: format.number(seconds, { maximumFractionDigits: seconds < 10 ? 1 : 0 }),
      });
    }
    const minutes = seconds / 60;
    if (minutes < 60) {
      return t("attendance.duration.minutes", {
        value: format.number(minutes, { maximumFractionDigits: minutes < 10 ? 1 : 0 }),
      });
    }
    return t("attendance.duration.hours", { value: format.number(minutes / 60, { maximumFractionDigits: 1 }) });
  };
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  const weekday = (day: number) => format.date(new Date(2024, 0, 7 + day, 12), { weekday: "short" });
  let heading: HTMLHeadingElement | undefined;
  // The heading takes focus when the page opens, as the usage page does.
  onSettled(() => heading?.focus({ preventScroll: true }));

  return (
    <section class="agent-usage attendance" aria-label={t("attendance.label")}>
      <header class="agent-usage-header">
        <div class="agent-usage-identity">
          <IconButton variant="ghost" label={t("common.back")} onClick={props.onBack}>
            <ArrowLeft />
          </IconButton>
          <h2
            ref={(element: HTMLHeadingElement) => {
              heading = element;
            }}
            tabindex={-1}
          >
            {t("attendance.title")} <span aria-hidden="true">/</span>{" "}
            <span>{props.agentName ?? t("attendance.agent.none")}</span>
          </h2>
          <Show when={props.report}>
            <span class="attendance-state" data-state={state()} role="status">
              {t(STATE_LABELS[state()])}
            </span>
          </Show>
        </div>
        <Show when={props.phase !== "loading" && !showEmpty()}>
          <div class="agent-usage-controls">
            <div class="attendance-periods" role="toolbar" aria-label={t("attendance.period.label")}>
              <For each={ATTENDANCE_PERIODS}>
                {(period) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    class="attendance-period"
                    aria-pressed={props.period === period ? "true" : "false"}
                    onClick={() => props.onPeriodChange(period)}
                  >
                    {t(PERIOD_LABELS[period])}
                  </Button>
                )}
              </For>
            </div>
            <Show when={state() === "on"}>
              <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onPause}>
                <Pause aria-hidden="true" />
                {t("attendance.pause")}
              </Button>
            </Show>
            <Show when={state() === "paused"}>
              <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onResume}>
                <Play aria-hidden="true" />
                {t("attendance.resume")}
              </Button>
            </Show>
          </div>
        </Show>
      </header>
      <div class="agent-usage-body attendance-body">
        <Show when={props.actionFailed}>
          <p class="agent-usage-notice" role="alert">
            {t("attendance.pauseFailed")}
          </p>
        </Show>
        <Show when={props.phase === "loading" && !props.report}>
          <div class="agent-usage-loading" role="status">
            <span>{t("attendance.loading")}</span>
            <div class="agent-usage-placeholder" />
          </div>
        </Show>
        <Show when={props.phase === "error" && !props.report}>
          <div class="agent-usage-notice">
            <p role="alert">{t("attendance.loadFailed")}</p>
            <Button variant="secondary" onClick={props.onRetry}>
              {t("common.retry")}
            </Button>
          </div>
        </Show>
        <Show when={showEmpty()}>
          <div class="attendance-empty">
            <WhatsAppIcon class="attendance-empty-icon" aria-hidden="true" />
            <h3>{t("attendance.empty.title")}</h3>
            <p>{t("attendance.empty.body")}</p>
            <Button variant="default" onClick={props.onOpenStore}>
              {t("attendance.empty.action")}
            </Button>
          </div>
        </Show>
        <Show when={props.report && !showEmpty() && props.report}>
          {(report) => (
            <AttendanceReportBody
              busy={props.busy}
              onResumeConversation={props.onResumeConversation}
              report={report()}
              period={props.period}
              minutesPerReply={props.minutesPerReply}
              onMinutesPerReplyChange={props.onMinutesPerReplyChange}
              duration={duration}
              hourLabel={hourLabel}
              weekday={weekday}
            />
          )}
        </Show>
      </div>
    </section>
  );
}

function AttendanceReportBody(props: {
  busy?: boolean | undefined;
  onResumeConversation: (ref: string) => void;
  report: AttendanceReport;
  period: AttendancePeriod;
  minutesPerReply: number;
  onMinutesPerReplyChange: (minutes: number) => void;
  duration: (ms: number | null) => string;
  hourLabel: (hour: number) => string;
  weekday: (day: number) => string;
}) {
  const { t, format } = useText();
  const totals = () => props.report.totals;
  const trend = () => attendanceTrend(totals().answered, props.report.previousAnswered);
  const trendText = () => {
    const current = trend();
    switch (current.kind) {
      case "up":
        return t("attendance.hero.trendUp", {
          percent: format.percent(current.percent / 100, { maximumFractionDigits: 0 }),
        });
      case "down":
        return t("attendance.hero.trendDown", {
          percent: format.percent(current.percent / 100, { maximumFractionDigits: 0 }),
        });
      case "same":
        return t("attendance.hero.trendSame");
      case "new":
        return t("attendance.hero.trendNew");
      case "none":
        return "";
    }
  };
  const saved = () => savedMinutes(totals().answered, props.minutesPerReply);
  const savedText = () =>
    saved() >= 60
      ? t("attendance.duration.hours", { value: format.number(saved() / 60, { maximumFractionDigits: 1 }) })
      : t("attendance.duration.minutes", { value: format.number(saved()) });

  const rows = createMemo(() =>
    props.report.buckets.map((bucket) => {
      const date = new Date(bucket.start);
      const hour = props.hourLabel(date.getHours());
      const label =
        props.period === "today"
          ? hour
          : props.report.bucketHours === 1
            ? `${format.date(date, { month: "short", day: "numeric" })} ${hour}`
            : format.date(date, { month: "short", day: "numeric" });
      return { label, answered: bucket.answered, received: bucket.received };
    }),
  );
  const chartSeries = (key: string) => ({
    name: key === "answered" ? t("attendance.chart.answered") : t("attendance.chart.received"),
    mark: <span class="attendance-dot" data-series={key} />,
  });

  const heatMax = () => Math.max(0, ...props.report.heatmap.flat());
  const peak = () => peakCell(props.report.heatmap);
  const latencyMax = () => Math.max(1, ...props.report.latency.map((hour) => hour.p90 ?? 0));
  const hasLatency = () => props.report.latency.some((hour) => hour.answers > 0);
  const funnelRows = () =>
    [
      { key: "received", label: t("attendance.funnel.received"), value: totals().received },
      { key: "answered", label: t("attendance.funnel.answered"), value: totals().answered },
      { key: "handoff", label: t("attendance.funnel.handoff"), value: totals().handoff },
    ] as const;
  const funnelAside = () =>
    [
      { key: "blocked", label: t("attendance.funnel.blocked"), value: totals().blocked },
      { key: "failed", label: t("attendance.funnel.failed"), value: totals().failed },
    ] as const;
  const attentionIcon = (event: AttendanceAttentionItem["event"]) =>
    event === "humano" ? Hand : event === "bloqueada" ? CircleAlert : TriangleAlert;
  const failureMax = () => Math.max(1, ...props.report.failures.map((entry) => entry.count));
  const BAR = { width: 480, height: 150, top: 14, gap: 3 };
  const barWidth = (BAR.width - 23 * BAR.gap) / 24;

  return (
    <>
      <section class="attendance-hero" aria-label={t("attendance.hero.label")}>
        <div class="attendance-hero-main">
          <p class="attendance-kicker">{t("attendance.hero.label")}</p>
          <p class="attendance-hero-number">{format.number(totals().answered)}</p>
          <p class="attendance-hero-summary">
            <Show when={totals().answered > 0} fallback={t("attendance.hero.summaryNone")}>
              {t("attendance.hero.summary", {
                count: totals().answered,
                conversations: format.number(totals().conversations),
                handoff: format.number(totals().handoff),
              })}
            </Show>
          </p>
          <div class="attendance-hero-trend">
            <Sparkline values={sparklineSeries(props.report.buckets)} label={t("attendance.hero.sparkline")} />
            <Show when={trendText()}>
              <span class="attendance-trend-text" data-trend={trend().kind}>
                {trendText()}
              </span>
            </Show>
          </div>
        </div>
        <dl class="attendance-ledger">
          <div>
            <dt>{t("attendance.stat.median")}</dt>
            <dd>
              {props.duration(props.report.latencyOverall.p50)}
              <Show when={props.report.latencyOverall.p90 !== null}>
                <span class="attendance-note">
                  {t("attendance.stat.p90", { time: props.duration(props.report.latencyOverall.p90) })}
                </span>
              </Show>
            </dd>
          </div>
          <div>
            <dt>
              {t("attendance.stat.saved")} <span class="attendance-tag">{t("attendance.stat.estimate")}</span>
            </dt>
            <dd>
              {savedText()}
              <span class="attendance-note">
                {t("attendance.stat.savedFormula", {
                  count: totals().answered,
                  minutes: format.number(props.minutesPerReply, { maximumFractionDigits: 1 }),
                })}
              </span>
              <label class="attendance-minutes">
                <span>{t("attendance.stat.minutes")}</span>
                <Input
                  type="number"
                  size="sm"
                  min={0.5}
                  max={240}
                  step={0.5}
                  inputmode="decimal"
                  defaultValue={String(props.minutesPerReply)}
                  aria-describedby="attendance-minutes-hint"
                  onValueChange={(value: string) => {
                    const minutes = Number(value.replace(",", "."));
                    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 240)
                      props.onMinutesPerReplyChange(minutes);
                  }}
                />
              </label>
              <span class="attendance-note" id="attendance-minutes-hint">
                {t("attendance.stat.minutesHint")}
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <div class="attendance-grid attendance-grid-main">
        <section class="attendance-panel" aria-labelledby="attendance-chart-title">
          <header class="agent-usage-section-header">
            <h3 id="attendance-chart-title">
              {props.report.bucketHours === 1 ? t("attendance.chart.titleHour") : t("attendance.chart.titleSix")}
            </h3>
            <span class="attendance-legend">
              <span>
                <span class="attendance-dot" data-series="answered" />
                {t("attendance.chart.answered")}
              </span>
              <span>
                <span class="attendance-dot" data-series="received" />
                {t("attendance.chart.received")}
              </span>
            </span>
          </header>
          <div class="attendance-chart">
            <ChartContainer label={t("attendance.chart.label")}>
              <AreaChart
                data={rows()}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                accessibilityLayer
                role="img"
                tabIndex={0}
                aria-label={t("attendance.chart.label")}
              >
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={56}
                  tickMargin={10}
                  stroke="var(--openbot-text-muted)"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  allowDecimals={false}
                  stroke="var(--openbot-text-muted)"
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--openbot-text-muted)", strokeWidth: 1 }}
                  content={(contentProps) => (
                    <ChartTooltipContent
                      {...contentProps}
                      formatValue={(value: number) => format.number(value)}
                      series={chartSeries}
                    />
                  )}
                />
                <Area
                  dataKey="received"
                  type="monotone"
                  stroke="var(--openbot-text-muted)"
                  fill="var(--openbot-text-muted)"
                  fillOpacity={0.08}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Area
                  dataKey="answered"
                  type="monotone"
                  stroke="var(--attendance-accent)"
                  fill="var(--attendance-accent)"
                  fillOpacity={0.16}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          </div>
        </section>

        <section class="attendance-panel" aria-labelledby="attendance-funnel-title">
          <header class="agent-usage-section-header">
            <h3 id="attendance-funnel-title">{t("attendance.funnel.title")}</h3>
          </header>
          <ol class="attendance-funnel" aria-label={t("attendance.funnel.label")}>
            <For each={funnelRows()} keyed={(row) => row.key}>
              {(row) => (
                <li data-step={row().key}>
                  <span class="attendance-funnel-label">{row().label}</span>
                  <strong>{format.number(row().value)}</strong>
                  <span class="attendance-funnel-track" aria-hidden="true">
                    <span
                      class="attendance-bar"
                      data-tone={row().key === "answered" ? "strong" : undefined}
                      style={{ width: `${shareOf(row().value, totals().received) * 100}%` }}
                    />
                  </span>
                  <Show when={row().key !== "received"}>
                    <span class="attendance-note">
                      {t("attendance.funnel.share", {
                        percent: format.percent(shareOf(row().value, totals().received), { maximumFractionDigits: 0 }),
                      })}
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ol>
          <dl class="attendance-funnel-aside">
            <For each={funnelAside()} keyed={(row) => row.key}>
              {(row) => (
                <div data-step={row().key} data-empty={row().value === 0 ? "" : undefined}>
                  <dt>{row().label}</dt>
                  <dd>{format.number(row().value)}</dd>
                </div>
              )}
            </For>
          </dl>
        </section>
      </div>

      <div class="attendance-grid attendance-grid-hours">
        <section class="attendance-panel" aria-labelledby="attendance-heatmap-title">
          <header class="agent-usage-section-header">
            <h3 id="attendance-heatmap-title">{t("attendance.heatmap.title")}</h3>
            <span class="attendance-legend" aria-hidden="true">
              {t("attendance.heatmap.less")}
              <For each={[0, 1, 2, 3, 4]}>{(level) => <span class="attendance-heat-key" data-level={level} />}</For>
              {t("attendance.heatmap.more")}
            </span>
          </header>
          <figure class="attendance-heatmap" aria-label={t("attendance.heatmap.label")}>
            <div class="attendance-heat-hours" aria-hidden="true">
              <For each={[0, 6, 12, 18]}>
                {(hour) => <span style={{ "grid-column": `${hour + 1} / span 6` }}>{props.hourLabel(hour)}</span>}
              </For>
            </div>
            <For each={props.report.heatmap}>
              {(row, day) => (
                <div class="attendance-heat-row">
                  <span class="attendance-heat-day" aria-hidden="true">
                    {props.weekday(day())}
                  </span>
                  <div class="attendance-heat-cells">
                    <For each={row} keyed={false}>
                      {(count, hour) => (
                        <span
                          class="attendance-heat-cell"
                          data-level={heatLevel(count(), heatMax())}
                          role="img"
                          aria-label={t("attendance.heatmap.cell", {
                            day: props.weekday(day()),
                            hour: props.hourLabel(hour),
                            count: count(),
                          })}
                          title={t("attendance.heatmap.cell", {
                            day: props.weekday(day()),
                            hour: props.hourLabel(hour),
                            count: count(),
                          })}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </figure>
          <Show when={peak()}>
            {(cell) => (
              <p class="attendance-note">
                {t("attendance.heatmap.cell", {
                  day: props.weekday(cell().day),
                  hour: props.hourLabel(cell().hour),
                  count: cell().count,
                })}
              </p>
            )}
          </Show>
        </section>

        <section class="attendance-panel" aria-labelledby="attendance-latency-title">
          <header class="agent-usage-section-header">
            <h3 id="attendance-latency-title">{t("attendance.latency.title")}</h3>
            <span class="attendance-legend" aria-hidden="true">
              <span>
                <span class="attendance-swatch" data-kind="median" />
                {t("attendance.latency.median")}
              </span>
              <span>
                <span class="attendance-swatch" data-kind="slow" />
                {t("attendance.latency.slow")}
              </span>
              <span>
                <span class="attendance-swatch" data-kind="failure" />
                {t("attendance.latency.failure")}
              </span>
            </span>
          </header>
          <Show when={hasLatency()} fallback={<p class="attendance-note">{t("attendance.latency.empty")}</p>}>
            <svg
              class="attendance-latency"
              viewBox={`0 0 ${BAR.width} ${BAR.height}`}
              preserveAspectRatio="none"
              role="img"
              tabindex="0"
              aria-label={t("attendance.latency.label")}
            >
              <For each={props.report.latency} keyed={(hour) => hour.hour}>
                {(hour) => (
                  <g
                    transform={`translate(${hour().hour * (barWidth + BAR.gap)} 0)`}
                    aria-label={t("attendance.latency.cell", {
                      hour: props.hourLabel(hour().hour),
                      median: props.duration(hour().p50),
                      slow: props.duration(hour().p90),
                      count: hour().answers,
                      failures: hour().failures,
                    })}
                  >
                    <title>
                      {t("attendance.latency.cell", {
                        hour: props.hourLabel(hour().hour),
                        median: props.duration(hour().p50),
                        slow: props.duration(hour().p90),
                        count: hour().answers,
                        failures: hour().failures,
                      })}
                    </title>
                    <Show when={hour().p90 !== null}>
                      <rect
                        class="attendance-bar-slow"
                        x={0}
                        width={barWidth}
                        y={BAR.height - ((hour().p90 ?? 0) / latencyMax()) * (BAR.height - BAR.top)}
                        height={((hour().p90 ?? 0) / latencyMax()) * (BAR.height - BAR.top)}
                      />
                      <rect
                        class="attendance-bar-median"
                        x={0}
                        width={barWidth}
                        y={BAR.height - ((hour().p50 ?? 0) / latencyMax()) * (BAR.height - BAR.top)}
                        height={((hour().p50 ?? 0) / latencyMax()) * (BAR.height - BAR.top)}
                      />
                    </Show>
                    <Show when={hour().failures > 0}>
                      <rect class="attendance-bar-failure" x={0} y={0} width={barWidth} height={6} />
                    </Show>
                  </g>
                )}
              </For>
            </svg>
            <div class="attendance-latency-axis" aria-hidden="true">
              <For each={[0, 6, 12, 18]}>{(hour) => <span>{props.hourLabel(hour)}</span>}</For>
            </div>
          </Show>
        </section>
      </div>

      <div class="attendance-grid attendance-grid-attention">
        <section class="attendance-panel" aria-labelledby="attendance-attention-title">
          <header class="agent-usage-section-header">
            <h3 id="attendance-attention-title">{t("attendance.attention.title")}</h3>
          </header>
          <Show
            when={props.report.attention.length > 0}
            fallback={<p class="attendance-note">{t("attendance.attention.empty")}</p>}
          >
            <ul class="attendance-attention">
              <For each={props.report.attention.slice(0, 8)} keyed={false}>
                {(item) => (
                  <li data-event={item().event}>
                    <span class="attendance-attention-icon" aria-hidden="true">
                      <Dynamic component={attentionIcon(item().event)} />
                    </span>
                    <span class="attendance-attention-text">
                      <strong>
                        {item().name ??
                          (item().kind === "group"
                            ? t("attendance.attention.group", { ref: item().ref })
                            : t("attendance.attention.contact", { ref: item().ref }))}
                      </strong>
                      <span class="attendance-attention-meta">
                        {t(EVENT_LABELS[item().event])}
                        <Show when={item().category}>{(category) => <> · {t(FAILURE_LABELS[category()])}</>}</Show>
                      </span>
                    </span>
                    <Show when={item().paused}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={props.busy}
                        onClick={() => props.onResumeConversation(item().ref)}
                      >
                        {t("attendance.attention.resume")}
                      </Button>
                    </Show>
                    <time class="attendance-attention-meta" datetime={new Date(item().at).toISOString()}>
                      {format.date(item().at, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </time>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="attendance-panel" aria-labelledby="attendance-failures-title">
          <header class="agent-usage-section-header">
            <h3 id="attendance-failures-title">{t("attendance.failures.title")}</h3>
          </header>
          <Show
            when={props.report.failures.length > 0}
            fallback={<p class="attendance-note">{t("attendance.failures.empty")}</p>}
          >
            <ul class="attendance-failures">
              <For each={props.report.failures} keyed={(entry) => entry.category}>
                {(entry) => (
                  <li>
                    <span>{t(FAILURE_LABELS[entry().category])}</span>
                    <strong>{format.number(entry().count)}</strong>
                    <span class="attendance-funnel-track" aria-hidden="true">
                      <span
                        class="attendance-bar"
                        data-tone="danger"
                        style={{ width: `${(entry().count / failureMax()) * 100}%` }}
                      />
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </>
  );
}
