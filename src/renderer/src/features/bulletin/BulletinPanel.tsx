import type { AgentTask, HostAnalytics, RoutineCalendar } from "@openbot/contracts/ipc";
import { analyticsRange } from "@openbot/contracts/ipc";
import { ArrowLeft, Button, IconButton, RefreshCw } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, For, onSettled, Show } from "solid-js";
import { useNavigation } from "../../navigation";
import { useTurns } from "../../turns";
import { agentThreadAttention } from "../agents/agent-thread-attention";
import { useAgents } from "../agents/agents-context";
import { desktopScheduleSource } from "../schedule/schedule-port";
import { desktopTasksSource } from "../tasks/tasks-port";
import { usagePort } from "../usage/usage-port";
import { useWindowPage } from "../window/window-page-context";
import { type BulletinAlert, summarizeBulletin } from "./bulletin-model";
import "./bulletin.css";

const DAY = 86_400_000;

type BulletinPeriod = 1 | 7;

interface BulletinPanelProps {
  serverId: string;
  hostName: string;
  onBack: () => void;
}

interface BulletinData {
  analytics: HostAnalytics | null;
  calendar: RoutineCalendar | null;
  tasks: AgentTask[];
}

function periodStart(days: BulletinPeriod, now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return start.getTime();
}

/**
 * OpenCat: the bulletin of a server. It reads the usage, routine and task reports that the host
 * already keeps, so it works on any server and holds no state of its own. A report that fails leaves
 * its part empty and says so, instead of hiding the others.
 */
export function BulletinPanel(props: BulletinPanelProps) {
  const { t, format } = useText();
  const { agentList } = useAgents();
  const { pendingPrompts, approvals } = useTurns();
  const { selectAgent } = useNavigation();
  const windowPage = useWindowPage();
  const [period, setPeriod] = createSignal<BulletinPeriod>(1);
  const [now, setNow] = createSignal(new Date());
  const [state, setState] = createStore<{ loading: boolean; partial: boolean; data: BulletinData }>({
    loading: true,
    partial: false,
    data: { analytics: null, calendar: null, tasks: [] },
  });
  let generation = 0;

  async function load(): Promise<void> {
    const request = ++generation;
    const serverId = props.serverId;
    const days = period();
    const current = new Date();
    setState((draft) => {
      draft.loading = true;
    });
    const port = usagePort();
    const agents = await port.agent.listAgents(serverId).catch(() => null);
    const { agentId: _unused, ...range } = analyticsRange("", days, current);
    const [analytics, calendar, taskLists] = await Promise.allSettled([
      port.agent.getHostAnalytics(range, serverId),
      desktopScheduleSource().calendar(
        {
          from: new Date(periodStart(days, current) - DAY).toISOString(),
          to: new Date(current.getTime() + 2 * DAY).toISOString(),
        },
        serverId,
      ),
      Promise.allSettled((agents ?? []).map((agent) => desktopTasksSource().list(agent.id, serverId))),
    ]);
    if (request !== generation) return;
    const lists = taskLists.status === "fulfilled" ? taskLists.value : [];
    setNow(current);
    setState((draft) => {
      draft.loading = false;
      draft.partial =
        agents === null ||
        analytics.status === "rejected" ||
        calendar.status === "rejected" ||
        lists.some((list) => list.status === "rejected");
      draft.data = {
        analytics: analytics.status === "fulfilled" ? analytics.value : null,
        calendar: calendar.status === "fulfilled" ? calendar.value : null,
        tasks: lists.flatMap((list) => (list.status === "fulfilled" ? list.value.tasks : [])),
      };
    });
  }

  createEffect(
    () => [props.serverId, period()] as const,
    () => {
      void load();
    },
  );

  const approvalAgentIds = createMemo(() =>
    Object.entries(
      agentThreadAttention({ agents: agentList(), pendingPrompts: pendingPrompts(), approvals: approvals() })
        .pendingApprovals,
    )
      .filter(([, approval]) => approval !== undefined)
      .map(([agentId]) => agentId),
  );

  const bulletin = createMemo(() =>
    summarizeBulletin({
      analytics: state.data.analytics,
      calendar: state.data.calendar,
      tasks: state.data.tasks,
      approvalAgentIds: approvalAgentIds(),
      agentName: (agentId) => agentList().find((agent) => agent.id === agentId)?.name ?? agentId,
      since: periodStart(period(), now()),
      now: now().getTime(),
    }),
  );

  function openAgent(agentId: string): void {
    windowPage.showAgents();
    selectAgent(agentId);
  }

  const dateTime = (value: string) => format.date(new Date(value), { dateStyle: "short", timeStyle: "short" });

  function alertTitle(alert: BulletinAlert): string {
    if (alert.kind === "approval") return t("usage.bulletin.alert.approval", { agent: alert.agentName });
    return alert.kind === "routine"
      ? t("usage.bulletin.alert.routine", { title: alert.title })
      : t("usage.bulletin.alert.task", { title: alert.title });
  }

  let heading: HTMLHeadingElement | undefined;
  onSettled(() => heading?.focus());

  return (
    <section class="agent-usage" aria-label={t("usage.bulletin.title")}>
      <header class="agent-usage-header">
        <div class="agent-usage-identity">
          <IconButton variant="ghost" label={t("common.back")} onClick={props.onBack}>
            <ArrowLeft />
          </IconButton>
          <h2 ref={heading} tabindex={-1}>
            {t("usage.bulletin.title")} <span aria-hidden="true">/</span> <span>{props.hostName}</span>
          </h2>
        </div>
        <div class="agent-usage-controls">
          <Button variant={period() === 1 ? "secondary" : "ghost"} onClick={() => setPeriod(1)}>
            {t("usage.bulletin.period.today")}
          </Button>
          <Button variant={period() === 7 ? "secondary" : "ghost"} onClick={() => setPeriod(7)}>
            {t("usage.bulletin.period.week")}
          </Button>
          <IconButton
            variant="ghost"
            label={t("usage.bulletin.refresh")}
            disabled={state.loading}
            onClick={() => void load()}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </header>
      <div class="bulletin-body">
        <Show when={state.partial}>
          <p class="bulletin-muted">{t("usage.bulletin.partial")}</p>
        </Show>
        <div class="bulletin-stats">
          <div class="bulletin-stat">
            <strong>{bulletin().alerts.length}</strong>
            <span>{t("usage.bulletin.stat.attention")}</span>
          </div>
          <div class="bulletin-stat">
            <strong>{format.number(bulletin().tokens)}</strong>
            <span>{t("usage.bulletin.stat.tokens")}</span>
          </div>
          <div class="bulletin-stat">
            <strong>{format.number(bulletin().turns)}</strong>
            <span>{t("usage.bulletin.stat.turns")}</span>
          </div>
          <div class="bulletin-stat">
            <strong>{`${bulletin().routines.succeeded} / ${bulletin().routines.failed}`}</strong>
            <span>{t("usage.bulletin.stat.routines")}</span>
          </div>
          <div class="bulletin-stat">
            <strong>{`${bulletin().tasks.running} / ${bulletin().tasks.completed} / ${bulletin().tasks.failed}`}</strong>
            <span>{t("usage.bulletin.stat.tasks")}</span>
          </div>
        </div>

        <section class="bulletin-section">
          <h3>{t("usage.bulletin.section.attention")}</h3>
          <Show
            when={bulletin().alerts.length > 0}
            fallback={
              <p class="bulletin-muted">
                {state.loading ? t("usage.bulletin.loading") : t("usage.bulletin.empty.attention")}
              </p>
            }
          >
            <ul class="bulletin-list">
              <For each={bulletin().alerts}>
                {(alert) => {
                  const agentId = () => alert.agentId;
                  const at = () => {
                    const item = alert;
                    return item.kind === "approval" ? "" : dateTime(item.at);
                  };
                  const error = () => {
                    const item = alert;
                    return item.kind === "task" ? item.error : null;
                  };
                  return (
                    <li>
                      <Button
                        type="button"
                        variant="ghost"
                        class="bulletin-row"
                        disabled={!agentId()}
                        onClick={() => {
                          const id = agentId();
                          if (id) openAgent(id);
                        }}
                      >
                        <span>
                          {alertTitle(alert)}
                          <Show when={alert.agentName && alert.kind !== "approval"}>{` · ${alert.agentName}`}</Show>
                          <Show when={error()}>{(text) => <span class="bulletin-error">{text()}</span>}</Show>
                        </span>
                        <small>{at()}</small>
                      </Button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </section>

        <section class="bulletin-section">
          <h3>{t("usage.bulletin.section.agents")}</h3>
          <Show
            when={bulletin().topAgents.length > 0}
            fallback={<p class="bulletin-muted">{t("usage.bulletin.empty.agents")}</p>}
          >
            <ul class="bulletin-list">
              <For each={bulletin().topAgents}>
                {(agent) => (
                  <li>
                    <Button type="button" variant="ghost" class="bulletin-row" onClick={() => openAgent(agent.agentId)}>
                      <span>{agent.name}</span>
                      <small>{format.number(agent.tokens)}</small>
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="bulletin-section">
          <h3>{t("usage.bulletin.section.next")}</h3>
          <Show
            when={bulletin().routines.next.length > 0}
            fallback={<p class="bulletin-muted">{t("usage.bulletin.empty.next")}</p>}
          >
            <ul class="bulletin-list">
              <For each={bulletin().routines.next}>
                {(run) => (
                  <li class="bulletin-row">
                    <span>{run.name}</span>
                    <small>{dateTime(run.at)}</small>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </section>
  );
}
