import type { RoutineSchedule } from "@openbot/contracts/ipc";
import {
  RoutineCalendar,
  type RoutineCalendarAgent,
  type RoutineCalendarRoutine,
  type RoutineCalendarRun,
} from "@openbot/ui/features/conversation/RoutineCalendar";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENTS } from "./fixtures";

/*
 * Issue #1242: one place that shows when every routine runs, across all agents. The host expands
 * each schedule into runs; the calendar only places them. Runs before `now` carry their outcome,
 * runs after it carry the routine state. All times are wall-clock times in the viewer's zone.
 */

const WARSAW = "Europe/Warsaw";
const [chief, research, sales] = STORY_AGENTS;
const AGENTS: RoutineCalendarAgent[] = STORY_AGENTS;

interface StoryRoutine extends RoutineCalendarRoutine {
  paused?: boolean;
  /** Days on which the run failed, as "2026-10-13". */
  failedOn?: string[];
}

function routine(
  id: string,
  name: string,
  agents: (RoutineCalendarAgent | undefined)[],
  schedule: RoutineSchedule,
  extra: Pick<StoryRoutine, "paused" | "failedOn"> = {},
): StoryRoutine {
  return {
    id,
    name,
    agentIds: agents.flatMap((agent) => (agent ? [agent.id] : [])),
    schedule,
    ...extra,
  };
}

const ROUTINES: StoryRoutine[] = [
  routine("morning-brief", "Morning brief", [chief], { kind: "weekdays", time: "07:00" }),
  routine("paper-digest", "Paper digest", [research], { kind: "weekly", weekday: 1, time: "08:30" }),
  routine("inbox-triage", "Inbox triage", [chief], { kind: "daily", time: "09:00" }),
  routine("monthly-invoices", "Monthly invoices", [chief], { kind: "monthly", day: 15, time: "10:00" }),
  routine(
    "competitor-watch",
    "Competitor watch",
    [research],
    { kind: "daily", time: "12:00" },
    {
      failedOn: ["2026-10-13"],
    },
  ),
  routine("lead-follow-up", "Lead follow-up", [sales], { kind: "weekdays", time: "14:00" }),
  routine(
    "weekly-planning",
    "Weekly planning",
    [chief],
    { kind: "weekly", weekday: 5, time: "16:00" },
    {
      paused: true,
    },
  ),
  routine("pipeline-report", "Pipeline report", [sales, chief], { kind: "weekly", weekday: 4, time: "17:30" }),
];

/** Wednesday, October 14, 2026, 10:30 in Warsaw. */
const NOW = new Date("2026-10-14T08:30:00.000Z");
/** Wednesday, October 21, 2026. The clocks in Warsaw go back on Sunday, October 25. */
const NOW_BEFORE_CLOCK_CHANGE = new Date("2026-10-21T08:30:00.000Z");

function runsFor(routines: StoryRoutine[], now: Date, timeZone: string): RoutineCalendarRun[] {
  const first = addDays(now.toISOString().slice(0, 10), -21);
  const runs: RoutineCalendarRun[] = [];
  for (let offset = 0; offset < 49; offset += 1) {
    const day = addDays(first, offset);
    for (const item of routines) {
      const time = runTime(item.schedule, day);
      if (!time) continue;
      const at = zonedInstant(day, time, timeZone);
      const past = at.getTime() < now.getTime();
      runs.push({
        id: `${item.id}-${day}`,
        routineId: item.id,
        at: at.toISOString(),
        status: past ? (item.failedOn?.includes(day) ? "failed" : "completed") : item.paused ? "paused" : "active",
      });
    }
  }
  return runs;
}

/** The story schedules only: one wall-clock time on the days the schedule picks. */
function runTime(schedule: RoutineSchedule, day: string): string | null {
  const date = new Date(`${day}T12:00:00.000Z`);
  const weekday = date.getUTCDay();
  switch (schedule.kind) {
    case "daily":
      return schedule.time;
    case "weekdays":
      return weekday >= 1 && weekday <= 5 ? schedule.time : null;
    case "weekly":
      return weekday === schedule.weekday ? schedule.time : null;
    case "monthly":
      return date.getUTCDate() === schedule.day ? schedule.time : null;
    default:
      return null;
  }
}

function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** The instant at which the wall clock in `timeZone` shows `time` on `day`. */
function zonedInstant(day: string, time: string, timeZone: string): Date {
  const guess = Date.parse(`${day}T${time}:00.000Z`);
  const offset = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instant);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute")) - instant;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

/** Forty routines spread over the working day, so a week cell has more runs than it shows. */
const MANY_ROUTINES: StoryRoutine[] = Array.from({ length: 40 }, (_, index) => {
  const hour = 7 + (index % 11);
  const minute = (index * 15) % 60;
  const agent = STORY_AGENTS[index % STORY_AGENTS.length];
  const names = ["Inbox sweep", "Price check", "Lead scoring", "Paper scan", "Status digest", "Backup check"];
  return routine(
    `bulk-${index}`,
    `${names[index % names.length]} ${index + 1}`,
    [agent],
    index % 3 === 0
      ? { kind: "weekdays", time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` }
      : { kind: "daily", time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` },
    { paused: index % 9 === 4, failedOn: index % 7 === 2 ? ["2026-10-13"] : [] },
  );
});

const FORTALEZA = "America/Fortaleza";
/** Sunday, November 1, 2026, 15:34 in Fortaleza. */
const CROWDED_NOW = new Date("2026-11-01T18:34:00.000Z");
const CROWDED_DAYS = ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];

/** Twenty agents with a routine each would be a wall of avatars: the filter is one menu. */
const CROWDED_AGENTS: RoutineCalendarAgent[] = Array.from({ length: 20 }, (_, index) => ({
  id: `crowded-agent-${index}`,
  name: `Agente ${index + 1}`,
  avatarSeed: `crowded-${index}`,
  avatarHue: null,
  avatarUrl: null,
}));

const crowdedAgent = (index: number) => CROWDED_AGENTS[index];

const CROWDED_ROUTINES: StoryRoutine[] = [
  routine("monitoring", "Monitoramento dos agentes", [crowdedAgent(0)], { kind: "hourly", minute: 12 }),
  routine("post-install", "Pós-instalação do OpenCat", [crowdedAgent(0)], { kind: "hourly", minute: 27 }),
  routine("disk-check", "Checagem de disco", [crowdedAgent(1)], {
    kind: "interval",
    amount: 6,
    unit: "hours",
    anchorAt: "2026-10-01T00:00:00.000Z",
  }),
  routine("daily-summary", "Resumo diário", [crowdedAgent(2)], { kind: "daily", time: "08:00" }),
  routine("daily-summary-2", "Resumo diário", [crowdedAgent(3)], { kind: "daily", time: "08:00" }),
  routine("health", "ChatNeed — Saúde diária (Sentinela)", [crowdedAgent(4)], { kind: "daily", time: "08:00" }),
  routine("disk-summary", "Resumo do disco", [crowdedAgent(1)], { kind: "daily", time: "09:00" }),
  routine("fork-update", "Atualização do fork do OpenBot", [crowdedAgent(5)], { kind: "daily", time: "06:40" }),
  routine("channel-review", "Revisão do canal com todos os agentes", CROWDED_AGENTS.slice(6, 14), {
    kind: "daily",
    time: "17:00",
  }),
  ...CROWDED_AGENTS.slice(14).map((agent, index) =>
    routine(`weekly-${index}`, `Relatório semanal ${index + 1}`, [agent], {
      kind: "daily",
      time: `${String(10 + index).padStart(2, "0")}:30`,
    }),
  ),
];

/** The times of a story routine on one day, as "HH:MM". */
function crowdedTimes(item: StoryRoutine): string[] {
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
  switch (item.schedule.kind) {
    case "hourly": {
      const minute = String(item.schedule.minute).padStart(2, "0");
      return hours.map((hour) => `${hour}:${minute}`);
    }
    case "interval":
      return hours.filter((_, hour) => hour % 6 === 0).map((hour) => `${hour}:00`);
    case "daily":
      return [item.schedule.time];
    default:
      return [];
  }
}

/** The failures are fixed, so that the story stays the same in each run. */
function crowdedRuns(): RoutineCalendarRun[] {
  const runs: RoutineCalendarRun[] = [];
  let count = 0;
  for (const day of CROWDED_DAYS) {
    for (const item of CROWDED_ROUTINES) {
      for (const time of crowdedTimes(item)) {
        count += 1;
        const at = zonedInstant(day, time, FORTALEZA);
        runs.push({
          id: `${item.id}-${day}-${time}`,
          routineId: item.id,
          at: at.toISOString(),
          status: at.getTime() >= CROWDED_NOW.getTime() ? "active" : count % 7 === 0 ? "failed" : "completed",
        });
      }
    }
  }
  return runs;
}

/** The props go in directly, so that this story does not depend on the Storybook args. */
function crowdedStory(initialView: "week" | "day" | "month"): Story {
  return {
    render: () => (
      <main style={{ width: "min(1400px, 100vw)", padding: "var(--openbot-space-6)" }}>
        <RoutineCalendar
          routines={CROWDED_ROUTINES}
          runs={crowdedRuns()}
          agents={CROWDED_AGENTS}
          now={CROWDED_NOW}
          timeZone={FORTALEZA}
          initialView={initialView}
          onOpenRoutine={fn()}
          onOpenAgent={fn()}
        />
      </main>
    ),
  };
}

const meta = {
  title: "Routines/Calendar",
  component: RoutineCalendar,
  render: (args) => (
    <main style={{ width: "min(1400px, 100vw)", padding: "var(--openbot-space-6)" }}>
      <RoutineCalendar {...args} />
    </main>
  ),
  args: {
    routines: ROUTINES,
    runs: runsFor(ROUTINES, NOW, WARSAW),
    agents: AGENTS,
    now: NOW,
    timeZone: WARSAW,
    state: "ready",
    onOpenRoutine: fn(),
    onOpenAgent: fn(),
    onRangeChange: fn(),
    onRetry: fn(),
  },
  argTypes: {
    state: { control: "inline-radio", options: ["ready", "loading", "error"] },
    initialView: { control: "inline-radio", options: ["month", "week", "day"] },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof RoutineCalendar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Hours down the left, a column for each day, today highlighted. Only the hours with runs show.
 * Past runs show their outcome. Weekly planning is paused, so its Friday run is a dashed ghost.
 * The Agents menu in the toolbar filters the runs.
 */
export const Week: Story = {};

/** One routine: the grid keeps a minimum of eight hour rows, so the week is not a thin strip. */
export const WeekOneRoutine: Story = {
  args: { routines: ROUTINES.slice(0, 1), runs: runsFor(ROUTINES.slice(0, 1), NOW, WARSAW) },
};

/** One agent has nobody to filter against, so the Agents menu leaves the toolbar. */
export const WeekOneAgent: Story = { args: { agents: STORY_AGENTS.slice(0, 1) } };

/** One day: its count, the routines that repeat, then the rest by hour. Each avatar opens its agent. */
export const Day: Story = { args: { initialView: "day" } };

/** October in whole weeks. The days of September and November only fill the first and last rows. */
export const Month: Story = { args: { initialView: "month" } };

/**
 * The clocks in Warsaw go back on Sunday. The morning brief stays at 7:00 AM on both sides of
 * the change, although its UTC time moves by one hour.
 */
export const ClockChangeWeek: Story = {
  args: { now: NOW_BEFORE_CLOCK_CHANGE, runs: runsFor(ROUTINES, NOW_BEFORE_CLOCK_CHANGE, WARSAW) },
};

/** A viewer in New York sees the Warsaw routines at New York times, on New York days. */
export const OtherTimeZone: Story = { args: { timeZone: "America/New_York" } };

/** Forty routines: routines at the same hour share one row, which opens them. */
export const ManyRoutines: Story = {
  args: { routines: MANY_ROUTINES, runs: runsFor(MANY_ROUTINES, NOW, WARSAW) },
};

export const ManyRoutinesDay: Story = {
  args: { ...ManyRoutines.args, initialView: "day" },
};

/** A month day shows three routines and a count. */
export const ManyRoutinesMonth: Story = {
  args: { ...ManyRoutines.args, initialView: "month" },
};

/**
 * A week as a person with many routines sees it: hourly routines, routines with the same name, a
 * channel with eight agents, and failures. A repeating routine is one row, and a row opens its runs.
 */
export const Crowded: Story = crowdedStory("week");

export const CrowdedDay: Story = crowdedStory("day");

export const CrowdedMonth: Story = crowdedStory("month");

/** Routines exist, but none of them runs in this range. */
export const NoRunsThisWeek: Story = { args: { runs: [] } };

/** No routine yet: sample runs land on a faint month and write what they did. Create Routine asks for the agent. */
export const Empty: Story = { args: { routines: [], runs: [] } };

/** With one agent, Create Routine opens that agent at once. */
export const EmptyOneAgent: Story = { args: { routines: [], runs: [], agents: STORY_AGENTS.slice(0, 1) } };

export const Loading: Story = { args: { state: "loading" } };

export const LoadError: Story = { args: { state: "error" } };

/** A phone or a side panel: the week grid scrolls sideways, and the next runs move below it. */
export const Narrow: Story = {
  render: (args) => (
    <main style={{ width: "390px", padding: "var(--openbot-space-4)" }}>
      <RoutineCalendar {...args} />
    </main>
  ),
};

/** The month becomes a list of its own days. */
export const NarrowMonth: Story = { ...Narrow, args: { initialView: "month" } };

/** The pitch comes first; the sample runs land in rows below it. */
export const EmptyNarrow: Story = { ...Narrow, args: { routines: [], runs: [] } };
