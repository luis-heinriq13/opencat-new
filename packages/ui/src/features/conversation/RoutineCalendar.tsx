import type { RoutineSchedule } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  addCalendarDays,
  addCalendarMonths,
  type CalendarDay,
  calendarDayDate,
  calendarDayOf,
  calendarDays,
  calendarHourOf,
  calendarMonthStart,
  calendarWeekStart,
  clockChangeDay,
} from "@openbot/team-client/routine-calendar-dates";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  ArrowLeft,
  Button,
  buttonVariants,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  DropdownMenu,
  IconButton,
  Skeleton,
  SlidingTabs,
  X,
} from "@openbot/ui";
import { createMemo, createSignal, createStore, For, Match, onSettled, Show, Switch, untrack } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { RoutineCalendarEmpty } from "./RoutineCalendarEmpty";
import {
  nextRunOfEachRoutine,
  type RoutineDayPlan,
  type RoutineRunBlock,
  type RoutineRunGroup,
  routineDayPlan,
} from "./routine-calendar-groups";
import { weekHourRange } from "./routine-calendar-week";
import { type RoutineText, routineScheduleSummary } from "./routine-schedule-ui";

/**
 * A run is `active` or `paused` before it happens, and `completed` or `failed` after it. A paused
 * routine still shows its runs, so the person sees what resuming it brings back.
 */
export type RoutineCalendarStatus = "active" | "paused" | "failed" | "completed";
export type RoutineCalendarView = "month" | "week" | "day";
export type RoutineCalendarAgent = Pick<AgentProfile, "id" | "name" | "avatarSeed" | "avatarHue" | "avatarUrl">;

export interface RoutineCalendarRoutine {
  id: string;
  name: string;
  agentIds: string[];
  schedule: RoutineSchedule;
}

/** One run of a routine. The host expands the schedules, so the calendar never parses a cron. */
export interface RoutineCalendarRun {
  id: string;
  routineId: string;
  at: string;
  status: RoutineCalendarStatus;
}

export interface RoutineCalendarProps {
  routines: RoutineCalendarRoutine[];
  runs: RoutineCalendarRun[];
  agents: RoutineCalendarAgent[];
  now: Date;
  /** The viewer's IANA time zone. Days and times show in it. */
  timeZone: string;
  state?: "ready" | "loading" | "error";
  errorText?: string;
  initialView?: RoutineCalendarView;
  /** 0 is Sunday, 1 is Monday. */
  weekStartsOn?: number;
  /** The first and last day the calendar shows, after each move, so the host can load their runs. */
  onRangeChange?: (first: CalendarDay, last: CalendarDay) => void;
  onOpenRoutine: (routineId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onRetry?: () => void;
  /** A full-pane calendar has a way back. With it, the heading takes focus when the calendar opens. */
  onBack?: () => void;
  /** The host whose routines show, after the title. */
  hostName?: string;
}

interface CalendarEntry {
  run: RoutineCalendarRun;
  routine: RoutineCalendarRoutine;
  agents: RoutineCalendarAgent[];
}

/** What the rows of a day need from the calendar. */
interface RoutineRowActions {
  timeText: (at: string) => string;
  statusText: (status: RoutineCalendarStatus) => string;
  isExpanded: (key: string) => boolean;
  toggleExpanded: (key: string) => void;
  onOpenRoutine: (routineId: string) => void;
}

/** A month day shows this many routines. The rest are one step away, in the day view. */
const MONTH_CELL_LIMIT = 3;
const UPCOMING_LIMIT = 6;
/** An entry shows this many agents and a count, so that its name keeps its width. */
const ENTRY_AGENT_LIMIT = 2;

const STATUS_LABEL = {
  active: "routine.settings.active",
  paused: "routine.settings.paused",
  failed: "routine.runStatus.failed",
  completed: "routine.calendar.completed",
} as const satisfies Record<RoutineCalendarStatus, AppTextKey>;

const PREVIOUS_LABEL = {
  month: "routine.calendar.previousMonth",
  week: "routine.calendar.previousWeek",
  day: "routine.calendar.previousDay",
} as const satisfies Record<RoutineCalendarView, AppTextKey>;

const NEXT_LABEL = {
  month: "routine.calendar.nextMonth",
  week: "routine.calendar.nextWeek",
  day: "routine.calendar.nextDay",
} as const satisfies Record<RoutineCalendarView, AppTextKey>;

export function RoutineCalendar(props: RoutineCalendarProps) {
  const text = useText();
  const { t, format } = text;
  const today = () => calendarDayOf(props.now, props.timeZone);
  // The props only seed the view: after that, the person moves it.
  const [state, setState] = createStore(
    untrack(() => ({
      view: props.initialView ?? "week",
      anchor: calendarDayOf(props.now, props.timeZone),
    })),
  );

  const daysFor = (anchor: CalendarDay, view: RoutineCalendarView) => {
    if (view === "day") return [anchor];
    const weekStartsOn = props.weekStartsOn ?? 1;
    if (view === "week") return calendarDays(calendarWeekStart(anchor, weekStartsOn), 7);
    // Whole weeks, from the week of the first day to the week of the last day: four to six rows.
    const next = addCalendarMonths(anchor, 1);
    const days: CalendarDay[] = [];
    for (let week = calendarWeekStart(calendarMonthStart(anchor), weekStartsOn); week < next; ) {
      days.push(...calendarDays(week, 7));
      week = addCalendarDays(week, 7);
    }
    return days;
  };
  const visibleDays = createMemo(() => daysFor(state.anchor, state.view));

  // The agents whose runs show. None picked means every agent.
  const [picked, setPicked] = createSignal<string[]>([]);
  const togglePicked = (agentId: string) =>
    setPicked((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  /** Only agents with a routine are worth a chip. */
  const routineAgents = createMemo(() => {
    const owners = new Set(props.routines.flatMap((routine) => routine.agentIds));
    return props.agents.filter((agent) => owners.has(agent.id));
  });

  const entries = createMemo(() => {
    const routines = new Map(props.routines.map((routine) => [routine.id, routine]));
    const agents = new Map(props.agents.map((agent) => [agent.id, agent]));
    const result: CalendarEntry[] = [];
    for (const run of props.runs) {
      const routine = routines.get(run.routineId);
      if (!routine) continue;
      const runAgents = routine.agentIds.flatMap((id) => agents.get(id) ?? []);
      const chosen = picked();
      if (chosen.length > 0 && !routine.agentIds.some((id) => chosen.includes(id))) continue;
      result.push({ run, routine, agents: runAgents });
    }
    return result.sort((left, right) => Date.parse(left.run.at) - Date.parse(right.run.at));
  });

  const entriesByDay = createMemo(() => {
    const byDay = new Map<CalendarDay, CalendarEntry[]>();
    for (const entry of entries()) {
      const day = calendarDayOf(new Date(entry.run.at), props.timeZone);
      const list = byDay.get(day);
      if (list) list.push(entry);
      else byDay.set(day, [entry]);
    }
    return byDay;
  });

  const dayPlans = createMemo(() => {
    const plans = new Map<CalendarDay, RoutineDayPlan<CalendarEntry>>();
    for (const [day, list] of entriesByDay()) {
      plans.set(
        day,
        routineDayPlan(list, (at) => calendarHourOf(new Date(at), props.timeZone)),
      );
    }
    return plans;
  });

  // The rows that show their single runs. A refresh of the runs keeps them open.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /** One line for each routine: a routine that runs each hour is not six lines. */
  const upcoming = createMemo(() =>
    nextRunOfEachRoutine(
      entries().filter((entry) => entry.run.status === "active" && Date.parse(entry.run.at) >= props.now.getTime()),
    ).slice(0, UPCOMING_LIMIT),
  );

  /** A month grid fills its first and last rows with days of the months next to it. */
  const outsideMonth = (day: CalendarDay) =>
    state.view === "month" && calendarMonthStart(day) !== calendarMonthStart(state.anchor);
  const clockChange = createMemo(() =>
    clockChangeDay(
      visibleDays().filter((day) => !outsideMonth(day)),
      props.timeZone,
    ),
  );

  const dayText = (day: CalendarDay, options: Intl.DateTimeFormatOptions) =>
    format.date(calendarDayDate(day), { ...options, timeZone: "UTC" });
  const longDay = (day: CalendarDay) => dayText(day, { weekday: "long", month: "long", day: "numeric" });
  const timeText = (at: string) =>
    format.date(new Date(at), { hour: "numeric", minute: "2-digit", timeZone: props.timeZone });
  const statusText = (status: RoutineCalendarStatus) => t(STATUS_LABEL[status]);
  const rowActions: RoutineRowActions = {
    timeText,
    statusText,
    isExpanded: (key) => expanded().has(key),
    toggleExpanded,
    onOpenRoutine: (routineId) => props.onOpenRoutine(routineId),
  };

  const rangeLabel = () => {
    const days = visibleDays();
    const first = days[0] ?? state.anchor;
    const last = days.at(-1) ?? state.anchor;
    if (state.view === "day") return longDay(first);
    if (state.view === "month") return dayText(state.anchor, { month: "long", year: "numeric" });
    return t("routine.calendar.range", {
      start: dayText(first, { month: "short", day: "numeric" }),
      end: dayText(last, { month: "short", day: "numeric", year: "numeric" }),
    });
  };

  let heading: HTMLHeadingElement | undefined;
  const moveTo = (anchor: CalendarDay, view: RoutineCalendarView = state.view) => {
    setState((draft) => {
      draft.anchor = anchor;
      draft.view = view;
    });
    const days = daysFor(anchor, view);
    const first = days[0];
    const last = days.at(-1);
    if (first && last) props.onRangeChange?.(first, last);
  };
  /** Today disables itself, and a day or "+N more" leaves the week: focus goes to the heading, not to the page. */
  const moveFrom = (anchor: CalendarDay, view?: RoutineCalendarView) => {
    moveTo(anchor, view);
    heading?.focus();
  };
  const step = (direction: -1 | 1) =>
    moveTo(
      state.view === "month"
        ? addCalendarMonths(state.anchor, direction)
        : addCalendarDays(state.anchor, direction * (state.view === "week" ? 7 : 1)),
    );
  const showsToday = () =>
    state.view === "month"
      ? calendarMonthStart(state.anchor) === calendarMonthStart(today())
      : visibleDays().includes(today());

  const upcomingWhen = (at: string) => {
    const day = calendarDayOf(new Date(at), props.timeZone);
    const time = timeText(at);
    if (day === today()) return t("routine.history.today", { time });
    if (day === addCalendarDays(today(), 1)) return t("routine.calendar.tomorrowAt", { time });
    return t("routine.card.nextRunAt", {
      day: dayText(day, { weekday: "short", month: "short", day: "numeric" }),
      time,
    });
  };

  /** The month grid names the weekdays once, above its columns. */
  const weekdayHeads = () => (
    <Show when={state.view === "month"}>
      <div class="routine-planner-weekdays" aria-hidden="true">
        <For each={visibleDays().slice(0, 7)}>{(day) => <span>{dayText(day, { weekday: "short" })}</span>}</For>
      </div>
    </Show>
  );

  onSettled(() => {
    if (untrack(() => props.onBack)) heading?.focus();
  });

  /** With no routine, there is nothing to move through: the calendar shows its pitch on a faint month. */
  const empty = () => (props.state ?? "ready") === "ready" && props.routines.length === 0;
  const emptyMonth = createMemo(() => daysFor(today(), "month"));

  return (
    <section class="routine-planner" aria-labelledby="routine-planner-heading" data-view={state.view}>
      <header class="routine-planner-header">
        <div class="routine-planner-title">
          <div class="routine-planner-identity">
            <Show when={props.onBack}>
              {(back) => (
                <IconButton
                  variant="ghost"
                  label={t("common.back")}
                  data-cuelume-tap="navigate"
                  onClick={() => back()()}
                >
                  <ArrowLeft />
                </IconButton>
              )}
            </Show>
            <h2 id="routine-planner-heading" ref={heading} tabindex={-1}>
              {t("routine.calendar.title")}
              <Show when={props.hostName}>
                {(host) => (
                  <>
                    {" "}
                    <span aria-hidden="true">/</span> <span>{host()}</span>
                  </>
                )}
              </Show>
            </h2>
          </div>
          <p>{t("routine.calendar.timeZone", { zone: props.timeZone.replaceAll("_", " ") })}</p>
        </div>
        <Show when={!empty()}>
          <div class="routine-planner-toolbar">
            <div class="routine-planner-nav">
              <IconButton
                variant="ghost"
                label={t(PREVIOUS_LABEL[state.view])}
                data-cuelume-tap="navigate"
                onClick={() => step(-1)}
              >
                <ChevronLeft aria-hidden="true" />
              </IconButton>
              <Button
                variant="outline"
                size="sm"
                disabled={showsToday()}
                data-cuelume-tap="navigate"
                onClick={() => moveFrom(today())}
              >
                {t("routine.calendar.today")}
              </Button>
              <IconButton
                variant="ghost"
                label={t(NEXT_LABEL[state.view])}
                data-cuelume-tap="navigate"
                onClick={() => step(1)}
              >
                <ChevronRight aria-hidden="true" />
              </IconButton>
              <p class="routine-planner-range" aria-live="polite">
                {rangeLabel()}
              </p>
            </div>
            <div class="routine-planner-controls">
              <Show when={routineAgents().length > 1}>
                <RoutineCalendarAgentFilter
                  agents={routineAgents()}
                  picked={picked()}
                  onToggle={togglePicked}
                  onClear={() => setPicked([])}
                />
              </Show>
              <SlidingTabs.Root
                value={state.view}
                onChange={(value) => moveTo(state.anchor, value === "day" || value === "month" ? value : "week")}
              >
                <SlidingTabs.List aria-label={t("routine.calendar.view")}>
                  <SlidingTabs.Trigger value="day">{t("routine.calendar.viewDay")}</SlidingTabs.Trigger>
                  <SlidingTabs.Trigger value="week">{t("routine.calendar.viewWeek")}</SlidingTabs.Trigger>
                  <SlidingTabs.Trigger value="month">{t("routine.calendar.viewMonth")}</SlidingTabs.Trigger>
                </SlidingTabs.List>
              </SlidingTabs.Root>
            </div>
          </div>
        </Show>
        <Show when={!empty() && clockChange()}>
          {(day) => (
            <p class="routine-planner-clock-change">{t("routine.calendar.clockChange", { day: longDay(day()) })}</p>
          )}
        </Show>
      </header>

      <Switch>
        <Match when={(props.state ?? "ready") === "loading"}>
          <div class="routine-planner-body" aria-busy="true">
            <p class="sr-only" role="status">
              {t("routine.calendar.loading")}
            </p>
            <div class="routine-planner-grid">
              {weekdayHeads()}
              <div class="routine-planner-week routine-planner-loading">
                <For each={visibleDays()}>
                  {(day) => (
                    <div class="routine-planner-day" data-outside={outsideMonth(day) ? "" : undefined}>
                      <Skeleton class="routine-planner-skeleton-heading" />
                      <Skeleton class="routine-planner-skeleton-run" />
                      <Skeleton class="routine-planner-skeleton-run" />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Match>
        <Match when={props.state === "error"}>
          <Alert tone="danger" class="routine-planner-error">
            <AlertContent>
              <AlertDescription>{props.errorText ?? t("routine.calendar.loadFailed")}</AlertDescription>
            </AlertContent>
            <Show when={props.onRetry}>
              <AlertActions>
                <Button variant="outline" size="sm" onClick={() => props.onRetry?.()}>
                  {t("common.retry")}
                </Button>
              </AlertActions>
            </Show>
          </Alert>
        </Match>
        <Match when={empty()}>
          <RoutineCalendarEmpty days={emptyMonth()} today={today()} agents={props.agents} />
        </Match>
        <Match when={true}>
          <div class="routine-planner-body">
            <Show
              when={state.view !== "day"}
              fallback={
                <RoutineCalendarDay
                  day={state.anchor}
                  plan={dayPlans().get(state.anchor)}
                  timeZone={props.timeZone}
                  actions={rowActions}
                  onOpenAgent={props.onOpenAgent}
                />
              }
            >
              <Show
                when={state.view === "month"}
                fallback={
                  <RoutineCalendarWeek
                    days={visibleDays()}
                    today={today()}
                    plans={dayPlans()}
                    actions={rowActions}
                    dayText={dayText}
                    longDay={longDay}
                    onOpenDay={(day) => moveFrom(day, "day")}
                  />
                }
              >
                <div class="routine-planner-grid">
                  {weekdayHeads()}
                  <ol class="routine-planner-week">
                    <For each={visibleDays()}>
                      {(day) => {
                        const plan = () => dayPlans().get(day);
                        const groups = () => plan()?.groups ?? [];
                        const hidden = () => Math.max(0, groups().length - MONTH_CELL_LIMIT);
                        return (
                          <li
                            class="routine-planner-day"
                            aria-current={day === today() ? "date" : undefined}
                            data-past={day < today() ? "" : undefined}
                            data-outside={outsideMonth(day) ? "" : undefined}
                          >
                            <h3 class="routine-planner-day-heading">
                              <Button
                                variant="ghost"
                                size="xs"
                                class="routine-planner-day-button"
                                aria-label={t("routine.calendar.openDay", { day: longDay(day) })}
                                data-cuelume-tap="navigate"
                                onClick={() => moveFrom(day, "day")}
                              >
                                <span>{dayText(day, { weekday: "short" })}</span>
                                <strong>{dayText(day, { day: "numeric" })}</strong>
                              </Button>
                            </h3>
                            <RoutineCalendarDaySummary runs={plan()?.runs ?? 0} failed={plan()?.failed ?? 0} />
                            <Show when={groups().length > 0}>
                              <ul class="routine-planner-runs">
                                <For each={groups().slice(0, MONTH_CELL_LIMIT)} keyed={(group) => group.routineId}>
                                  {(group) => (
                                    <RoutineCalendarGroup
                                      group={group()}
                                      scope={day}
                                      actions={rowActions}
                                      onOpenDay={() => moveFrom(day, "day")}
                                    />
                                  )}
                                </For>
                              </ul>
                            </Show>
                            <Show when={hidden() > 0}>
                              <Button
                                variant="ghost"
                                size="xs"
                                class="routine-planner-more"
                                aria-label={t("routine.calendar.showAll", {
                                  count: plan()?.runs ?? 0,
                                  day: longDay(day),
                                })}
                                data-cuelume-tap="navigate"
                                onClick={() => moveFrom(day, "day")}
                              >
                                {t("routine.calendar.more", { count: hidden() })}
                              </Button>
                            </Show>
                          </li>
                        );
                      }}
                    </For>
                  </ol>
                </div>
              </Show>
            </Show>

            <aside class="routine-planner-upcoming" aria-labelledby="routine-planner-upcoming-heading">
              <h3 id="routine-planner-upcoming-heading">{t("routine.calendar.upcoming")}</h3>
              <Show
                when={upcoming().length > 0}
                fallback={<p class="routine-planner-note">{t("routine.calendar.upcomingEmpty")}</p>}
              >
                <ul class="routine-planner-entries">
                  <For each={upcoming()}>
                    {(entry) => (
                      <RoutineCalendarEntry
                        entry={entry}
                        when={upcomingWhen(entry.run.at)}
                        upcoming
                        statusText={statusText}
                        onOpenRoutine={props.onOpenRoutine}
                        onOpenAgent={props.onOpenAgent}
                      />
                    )}
                  </For>
                </ul>
              </Show>
            </aside>
          </div>
        </Match>
      </Switch>
    </section>
  );
}

/** "24 runs" or "24 runs, 2 failures". */
function runSummaryText(text: RoutineText, runs: number, failed: number): string {
  const { t } = text;
  const runsText = t("routine.calendar.runCount", { count: runs });
  return failed > 0
    ? t("routine.calendar.summary", { runs: runsText, failures: t("routine.calendar.failureCount", { count: failed }) })
    : runsText;
}

interface RoutineCalendarAgentFilterProps {
  agents: RoutineCalendarAgent[];
  picked: string[];
  onToggle: (agentId: string) => void;
  onClear: () => void;
}

/** One control for the agent filter. The trigger names the choice, and the menu stays open for more picks. */
function RoutineCalendarAgentFilter(props: RoutineCalendarAgentFilterProps) {
  const { t } = useText();
  const pickedAgents = () => props.agents.filter((agent) => props.picked.includes(agent.id));
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={4} modal={false}>
      <DropdownMenu.Trigger
        class={`${buttonVariants({ variant: "outline", size: "sm" })} routine-planner-agent-trigger`}
        data-active={props.picked.length > 0 ? "" : undefined}
        aria-label={t("routine.calendar.filterAgents")}
      >
        <RoutineCalendarAvatars agents={pickedAgents()} />
        <span>
          {props.picked.length > 0
            ? t("routine.calendar.agentsPicked", { count: props.picked.length })
            : t("routine.calendar.agents")}
        </span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="routine-planner-agent-menu">
          <DropdownMenu.CheckboxItem
            checked={props.picked.length === 0}
            closeOnSelect={false}
            onChange={() => props.onClear()}
          >
            <RoutineCalendarMenuMark on={props.picked.length === 0} />
            {t("routine.calendar.allAgents")}
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator />
          <For each={props.agents} keyed={(agent) => agent.id}>
            {(agent) => (
              <DropdownMenu.CheckboxItem
                aria-label={agent().name}
                checked={props.picked.includes(agent().id)}
                closeOnSelect={false}
                onChange={() => props.onToggle(agent().id)}
              >
                <RoutineCalendarMenuMark on={props.picked.includes(agent().id)} />
                <AgentAvatar agent={agent()} class="routine-planner-avatar" />
                <span class="routine-planner-agent-name">{agent().name}</span>
              </DropdownMenu.CheckboxItem>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function RoutineCalendarMenuMark(props: { on: boolean }) {
  return (
    <span class="ui-menu-check" data-checked={props.on ? "" : undefined}>
      <Show when={props.on}>
        <Check aria-hidden="true" />
      </Show>
    </span>
  );
}

/** The short count at the top of a day. */
function RoutineCalendarDaySummary(props: { runs: number; failed: number }) {
  const { t } = useText();
  return (
    <Show when={props.runs > 0}>
      <p class="routine-planner-day-summary">
        <span>{t("routine.calendar.runCount", { count: props.runs })}</span>
        <Show when={props.failed > 0}>
          <span class="routine-planner-day-failures">
            {t("routine.calendar.failureCount", { count: props.failed })}
          </span>
        </Show>
      </p>
    </Show>
  );
}

/** A failure is a small mark with its count. The other states are the status mark alone. */
function RoutineCalendarOutcome(props: { status: RoutineCalendarStatus; failed: number; long?: boolean }) {
  const { t, format } = useText();
  return (
    <Switch>
      <Match when={props.failed > 1 || (props.long && props.failed > 0)}>
        <span class="routine-planner-failures">
          <X aria-hidden="true" />
          {props.long ? t("routine.calendar.failureCount", { count: props.failed }) : format.number(props.failed)}
        </span>
      </Match>
      <Match when={props.status !== "active"}>
        <RoutineCalendarStatusMark status={props.status} />
      </Match>
    </Switch>
  );
}

interface RoutineCalendarChipProps {
  name: string;
  meta: string;
  /** The full text. A column cuts the visible text short. */
  label: string;
  agents: RoutineCalendarAgent[];
  status: RoutineCalendarStatus;
  failed: number;
  /** Set when the chip opens its runs in place. */
  expanded?: boolean | undefined;
  onClick: () => void;
}

/** One row of a day: always the same two lines, so that a row has one height. */
function RoutineCalendarChip(props: RoutineCalendarChipProps) {
  return (
    <Button
      variant="ghost"
      class="routine-planner-chip"
      data-status={props.status}
      title={props.label}
      aria-label={props.label}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded ? "true" : "false"}
      onClick={() => props.onClick()}
    >
      <span class="routine-planner-chip-name">{props.name}</span>
      <RoutineCalendarAvatars agents={props.agents} />
      <span class="routine-planner-chip-meta">{props.meta}</span>
      <span class="routine-planner-chip-mark">
        <RoutineCalendarOutcome status={props.status} failed={props.failed} />
        <Show when={props.expanded !== undefined}>
          <ChevronDown class="routine-planner-chip-chevron" aria-hidden="true" />
        </Show>
      </span>
    </Button>
  );
}

/** The single runs of a group. Each one opens its routine. */
function RoutineCalendarSingleRuns(props: { entries: CalendarEntry[]; actions: RoutineRowActions }) {
  const { t } = useText();
  return (
    <ul class="routine-planner-single-runs">
      <For each={props.entries} keyed={(entry) => entry.run.id}>
        {(entry) => (
          <li>
            <Button
              variant="ghost"
              class="routine-planner-single-run"
              data-status={entry().run.status}
              aria-label={t("routine.calendar.runLabel", {
                name: entry().routine.name,
                time: props.actions.timeText(entry().run.at),
                status: props.actions.statusText(entry().run.status),
              })}
              onClick={() => props.actions.onOpenRoutine(entry().routine.id)}
            >
              <span class="routine-planner-run-time">{props.actions.timeText(entry().run.at)}</span>
              <RoutineCalendarStatusMark status={entry().run.status} />
            </Button>
          </li>
        )}
      </For>
    </ul>
  );
}

interface RoutineCalendarGroupProps {
  group: RoutineRunGroup<CalendarEntry>;
  /** The day of the group, so that the same routine on another day opens on its own. */
  scope: string;
  actions: RoutineRowActions;
  /** A month cell has no space for the single runs: a repeating routine opens its day instead. */
  onOpenDay?: () => void;
}

/** A routine in a column. One run opens the routine; more runs show one row that opens them. */
function RoutineCalendarGroup(props: RoutineCalendarGroupProps) {
  const text = useText();
  const { t } = text;
  const key = () => `${props.scope}/${props.group.routineId}`;
  const repeats = () => props.group.entries.length > 1;
  const inline = () => repeats() && !props.onOpenDay;
  const label = () =>
    repeats()
      ? t("routine.calendar.groupLabel", {
          name: props.group.first.routine.name,
          summary: runSummaryText(text, props.group.entries.length, props.group.failed),
        })
      : t("routine.calendar.runLabel", {
          name: props.group.first.routine.name,
          time: props.actions.timeText(props.group.first.run.at),
          status: props.actions.statusText(props.group.first.run.status),
        });
  const activate = () => {
    if (!repeats()) props.actions.onOpenRoutine(props.group.routineId);
    else if (props.onOpenDay) props.onOpenDay();
    else props.actions.toggleExpanded(key());
  };
  return (
    <li>
      <RoutineCalendarChip
        name={props.group.first.routine.name}
        meta={
          repeats()
            ? t("routine.calendar.repeatCount", { count: props.group.entries.length })
            : props.actions.timeText(props.group.first.run.at)
        }
        label={label()}
        agents={props.group.first.agents.slice(0, 1)}
        status={props.group.status}
        failed={props.group.failed}
        expanded={inline() ? props.actions.isExpanded(key()) : undefined}
        onClick={activate}
      />
      <Show when={inline() && props.actions.isExpanded(key())}>
        <RoutineCalendarSingleRuns entries={props.group.entries} actions={props.actions} />
      </Show>
    </li>
  );
}

/** The routines of one hour in a column. Two or more share one row that opens them. */
function RoutineCalendarBlock(props: {
  block: RoutineRunBlock<CalendarEntry>;
  scope: string;
  actions: RoutineRowActions;
}) {
  const text = useText();
  const { t, format } = text;
  const key = () => `${props.scope}@${props.block.hour}`;
  const names = () => format.list(props.block.groups.map((group) => group.first.routine.name));
  const agents = () => {
    const unique = new Map(
      props.block.groups.flatMap((group) => group.first.agents).map((agent) => [agent.id, agent] as const),
    );
    return [...unique.values()];
  };
  const groupList = () => (
    <For each={props.block.groups} keyed={(group) => group.routineId}>
      {(group) => <RoutineCalendarGroup group={group()} scope={props.scope} actions={props.actions} />}
    </For>
  );
  return (
    <Show when={props.block.groups.length > 1} fallback={<ul class="routine-planner-runs">{groupList()}</ul>}>
      <div class="routine-planner-block">
        <RoutineCalendarChip
          name={names()}
          meta={t("routine.calendar.routineCount", { count: props.block.groups.length })}
          label={t("routine.calendar.groupLabel", {
            name: names(),
            summary: runSummaryText(text, props.block.groups.length, props.block.failed),
          })}
          agents={agents()}
          status={props.block.status}
          failed={props.block.failed}
          expanded={props.actions.isExpanded(key())}
          onClick={() => props.actions.toggleExpanded(key())}
        />
        <Show when={props.actions.isExpanded(key())}>
          <ul class="routine-planner-runs">{groupList()}</ul>
        </Show>
      </div>
    </Show>
  );
}

interface RoutineCalendarWeekProps {
  days: CalendarDay[];
  today: CalendarDay;
  plans: Map<CalendarDay, RoutineDayPlan<CalendarEntry>>;
  actions: RoutineRowActions;
  dayText: (day: CalendarDay, options: Intl.DateTimeFormatOptions) => string;
  longDay: (day: CalendarDay) => string;
  onOpenDay: (day: CalendarDay) => void;
}

/**
 * A week as a grid: a column for each day, the routines that repeat in the first row, and each other
 * run in the row of its hour. Each cell is one row until the person opens it.
 */
function RoutineCalendarWeek(props: RoutineCalendarWeekProps) {
  const { t, format } = useText();
  const layout = createMemo(() => {
    const blocks = new Map<string, RoutineRunBlock<CalendarEntry>>();
    const hours: number[] = [];
    let hasRepeating = false;
    for (const day of props.days) {
      const plan = props.plans.get(day);
      if (!plan) continue;
      if (plan.repeating.length > 0) hasRepeating = true;
      for (const block of plan.blocks) {
        hours.push(block.hour);
        blocks.set(`${day}@${block.hour}`, block);
      }
    }
    const range = weekHourRange(hours);
    // With only repeating routines, no run has an hour of its own to show.
    const rows =
      hours.length === 0 && hasRepeating
        ? []
        : Array.from({ length: range.last - range.first + 1 }, (_, index) => range.first + index);
    return { blocks, rows, hasRepeating };
  });
  const hourText = (hour: number) =>
    format.date(new Date(Date.UTC(2000, 0, 3, hour)), { hour: "numeric", timeZone: "UTC" });
  return (
    <div class="routine-planner-timegrid-scroll">
      <div
        class="routine-planner-timegrid"
        style={{ "--routine-planner-hours": String(layout().rows.length + (layout().hasRepeating ? 1 : 0)) }}
      >
        <div class="routine-planner-hour-axis" aria-hidden="true">
          <Show when={layout().hasRepeating}>
            <span>{t("routine.calendar.repeating")}</span>
          </Show>
          <For each={layout().rows}>{(hour) => <span>{hourText(hour)}</span>}</For>
        </div>
        <For each={props.days}>
          {(day) => (
            <section class="routine-planner-column" data-today={day === props.today ? "" : undefined}>
              <div class="routine-planner-column-head">
                <h3 class="routine-planner-day-heading">
                  <Button
                    variant="ghost"
                    size="xs"
                    class="routine-planner-day-button"
                    aria-label={t("routine.calendar.openDay", { day: props.longDay(day) })}
                    aria-current={day === props.today ? "date" : undefined}
                    data-cuelume-tap="navigate"
                    onClick={() => props.onOpenDay(day)}
                  >
                    <span>{props.dayText(day, { weekday: "short" })}</span>
                    <strong>{props.dayText(day, { day: "numeric" })}</strong>
                  </Button>
                </h3>
                <RoutineCalendarDaySummary
                  runs={props.plans.get(day)?.runs ?? 0}
                  failed={props.plans.get(day)?.failed ?? 0}
                />
              </div>
              <Show when={layout().hasRepeating}>
                <div class="routine-planner-cell">
                  <ul class="routine-planner-runs">
                    <For each={props.plans.get(day)?.repeating ?? []} keyed={(group) => group.routineId}>
                      {(group) => <RoutineCalendarGroup group={group()} scope={day} actions={props.actions} />}
                    </For>
                  </ul>
                </div>
              </Show>
              <For each={layout().rows}>
                {(hour) => (
                  <div class="routine-planner-cell">
                    <Show when={layout().blocks.get(`${day}@${hour}`)}>
                      {(block) => <RoutineCalendarBlock block={block()} scope={day} actions={props.actions} />}
                    </Show>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

interface RoutineCalendarDayProps {
  day: CalendarDay;
  plan: RoutineDayPlan<CalendarEntry> | undefined;
  timeZone: string;
  actions: RoutineRowActions;
  onOpenAgent: (agentId: string) => void;
}

/** One day: its count, the routines that repeat, then the other runs by hour. */
function RoutineCalendarDay(props: RoutineCalendarDayProps) {
  const { t, format } = useText();
  const repeating = () => props.plan?.repeating ?? [];
  return (
    <div class="routine-planner-day-view">
      <Show
        when={(props.plan?.runs ?? 0) > 0}
        fallback={<p class="routine-planner-note">{t("routine.calendar.dayEmpty")}</p>}
      >
        <RoutineCalendarDaySummary runs={props.plan?.runs ?? 0} failed={props.plan?.failed ?? 0} />
        <Show when={repeating().length > 0}>
          <section class="routine-planner-hour">
            <h3>{t("routine.calendar.repeating")}</h3>
            <ul class="routine-planner-entries">
              <For each={repeating()} keyed={(group) => group.routineId}>
                {(group) => (
                  <RoutineCalendarGroupEntry
                    group={group()}
                    scope={props.day}
                    actions={props.actions}
                    onOpenAgent={props.onOpenAgent}
                  />
                )}
              </For>
            </ul>
          </section>
        </Show>
        <For each={props.plan?.blocks ?? []} keyed={(block) => block.hour}>
          {(block) => (
            <section class="routine-planner-hour">
              <h3>
                {format.date(new Date(block().groups[0]?.first.run.at ?? 0), {
                  hour: "numeric",
                  timeZone: props.timeZone,
                })}
              </h3>
              <ul class="routine-planner-entries">
                <For each={block().groups} keyed={(group) => group.routineId}>
                  {(group) => (
                    <RoutineCalendarEntry
                      entry={group().first}
                      when={props.actions.timeText(group().first.run.at)}
                      statusText={props.actions.statusText}
                      onOpenRoutine={props.actions.onOpenRoutine}
                      onOpenAgent={props.onOpenAgent}
                    />
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

interface RoutineCalendarGroupEntryProps {
  group: RoutineRunGroup<CalendarEntry>;
  scope: string;
  actions: RoutineRowActions;
  onOpenAgent: (agentId: string) => void;
}

/** A repeating routine in the day view: one line with its count and hours, which opens its single runs. */
function RoutineCalendarGroupEntry(props: RoutineCalendarGroupEntryProps) {
  const text = useText();
  const { t } = text;
  const key = () => `${props.scope}/${props.group.routineId}`;
  const routine = () => props.group.first.routine;
  const meta = () =>
    t("routine.calendar.groupMeta", {
      times: t("routine.calendar.repeatCount", { count: props.group.entries.length }),
      range: t("routine.calendar.timeRange", {
        start: props.actions.timeText(props.group.first.run.at),
        end: props.actions.timeText(props.group.last.run.at),
      }),
      schedule: routineScheduleSummary(routine().schedule, false, text),
    });
  return (
    <li class="routine-planner-entry" data-status={props.group.status === "paused" ? "paused" : undefined}>
      <Button
        variant="ghost"
        class="routine-planner-entry-main"
        title={t("routine.calendar.groupLabel", { name: routine().name, summary: meta() })}
        aria-label={t("routine.calendar.groupLabel", {
          name: routine().name,
          summary: runSummaryText(text, props.group.entries.length, props.group.failed),
        })}
        aria-expanded={props.actions.isExpanded(key()) ? "true" : "false"}
        onClick={() => props.actions.toggleExpanded(key())}
      >
        <ChevronDown class="routine-planner-chip-chevron" aria-hidden="true" />
        <span class="routine-planner-entry-text">
          <span class="routine-planner-entry-name">{routine().name}</span>
          <span class="routine-planner-entry-meta">{meta()}</span>
        </span>
        <RoutineCalendarOutcome status={props.group.status} failed={props.group.failed} long />
      </Button>
      <RoutineCalendarEntryAgents agents={props.group.first.agents} onOpenAgent={props.onOpenAgent} />
      <Show when={props.actions.isExpanded(key())}>
        <RoutineCalendarSingleRuns entries={props.group.entries} actions={props.actions} />
      </Show>
    </li>
  );
}

interface RoutineCalendarEntryProps {
  entry: CalendarEntry;
  when: string;
  /** The next run of a routine: its time and its frequency, each on its own line. */
  upcoming?: boolean;
  statusText: (status: RoutineCalendarStatus) => string;
  onOpenRoutine: (routineId: string) => void;
  onOpenAgent: (agentId: string) => void;
}

/** A run with its routine, recurrence and agents. The routine and each agent open on their own. */
function RoutineCalendarEntry(props: RoutineCalendarEntryProps) {
  const text = useText();
  const { t } = text;
  const schedule = () => routineScheduleSummary(props.entry.routine.schedule, false, text);
  return (
    <li class="routine-planner-entry" data-status={props.entry.run.status}>
      <Button
        variant="ghost"
        class="routine-planner-entry-main"
        title={t("routine.calendar.groupLabel", { name: props.entry.routine.name, summary: schedule() })}
        aria-label={t("routine.card.open", { name: props.entry.routine.name })}
        onClick={() => props.onOpenRoutine(props.entry.routine.id)}
      >
        <RoutineCalendarStatusMark status={props.entry.run.status} />
        <span class="routine-planner-entry-text">
          <span class="routine-planner-entry-name">{props.entry.routine.name}</span>
          <Show
            when={props.upcoming}
            fallback={
              <span class="routine-planner-entry-meta">
                {t("routine.calendar.entryMeta", {
                  when: props.when,
                  schedule: schedule(),
                  status: props.statusText(props.entry.run.status),
                })}
              </span>
            }
          >
            <span class="routine-planner-entry-meta">{props.when}</span>
            <span class="routine-planner-entry-meta">{schedule()}</span>
          </Show>
        </span>
      </Button>
      <RoutineCalendarEntryAgents agents={props.entry.agents} onOpenAgent={props.onOpenAgent} />
    </li>
  );
}

/** The agents of an entry. A channel can have many: the rest show as a count, with their names on hover. */
function RoutineCalendarEntryAgents(props: { agents: RoutineCalendarAgent[]; onOpenAgent: (agentId: string) => void }) {
  const { t, format } = useText();
  const rest = () => props.agents.slice(ENTRY_AGENT_LIMIT);
  return (
    <span class="routine-planner-entry-agents">
      <For each={props.agents.slice(0, ENTRY_AGENT_LIMIT)}>
        {(agent) => (
          <IconButton
            variant="ghost"
            class="routine-planner-agent"
            label={t("routine.calendar.openAgent", { name: agent.name })}
            data-cuelume-tap="navigate"
            onClick={() => props.onOpenAgent(agent.id)}
          >
            <AgentAvatar agent={agent} class="routine-planner-avatar" />
          </IconButton>
        )}
      </For>
      <Show when={rest().length > 0}>
        <span class="routine-planner-more-agents" title={format.list(rest().map((agent) => agent.name))}>
          {t("routine.calendar.moreAgents", { count: rest().length })}
        </span>
      </Show>
    </span>
  );
}

function RoutineCalendarAvatars(props: { agents: RoutineCalendarAgent[] }) {
  return (
    <span class="routine-planner-avatars" aria-hidden="true">
      <For each={props.agents.slice(0, 2)}>
        {(agent) => <AgentAvatar agent={agent} motion="idle" class="routine-planner-avatar" />}
      </For>
    </span>
  );
}

function RoutineCalendarStatusMark(props: { status: RoutineCalendarStatus }) {
  return (
    <span class="routine-planner-status" data-status={props.status} aria-hidden="true">
      <Switch fallback={<span class="routine-planner-status-dot" />}>
        <Match when={props.status === "paused"}>
          <CirclePause />
        </Match>
        <Match when={props.status === "failed"}>
          <X />
        </Match>
        <Match when={props.status === "completed"}>
          <Check />
        </Match>
      </Switch>
    </span>
  );
}
