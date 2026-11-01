import type { RoutineCalendarRun, RoutineCalendarStatus } from "./RoutineCalendar";

interface GroupableEntry {
  run: Pick<RoutineCalendarRun, "routineId" | "at" | "status">;
}

/** The runs of one routine in one day, in time order. It has at least one run. */
export interface RoutineRunGroup<Entry extends GroupableEntry> {
  routineId: string;
  first: Entry;
  last: Entry;
  entries: Entry[];
  failed: number;
  status: RoutineCalendarStatus;
}

/** The routines that run once in a day, at the same hour. */
export interface RoutineRunBlock<Entry extends GroupableEntry> {
  hour: number;
  groups: RoutineRunGroup<Entry>[];
  failed: number;
  status: RoutineCalendarStatus;
}

export interface RoutineDayPlan<Entry extends GroupableEntry> {
  runs: number;
  failed: number;
  /** Every routine of the day, by its first run. */
  groups: RoutineRunGroup<Entry>[];
  /** The routines with more than one run. An hour cannot hold them, so they show once for the day. */
  repeating: RoutineRunGroup<Entry>[];
  /** The routines with one run, by hour. */
  blocks: RoutineRunBlock<Entry>[];
}

/** A failure shows first. After that, what can still happen shows before what has happened. */
function combinedStatus(failed: number, entries: readonly GroupableEntry[]): RoutineCalendarStatus {
  if (failed > 0) return "failed";
  if (entries.some((entry) => entry.run.status === "active")) return "active";
  if (entries.some((entry) => entry.run.status === "paused")) return "paused";
  return "completed";
}

function failedCount(entries: readonly GroupableEntry[]): number {
  return entries.filter((entry) => entry.run.status === "failed").length;
}

/** The plan of one day. `entries` are the runs of that day, in time order. */
export function routineDayPlan<Entry extends GroupableEntry>(
  entries: readonly Entry[],
  hourOf: (at: string) => number,
): RoutineDayPlan<Entry> {
  const byRoutine = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = byRoutine.get(entry.run.routineId);
    if (list) list.push(entry);
    else byRoutine.set(entry.run.routineId, [entry]);
  }

  const groups: RoutineRunGroup<Entry>[] = [];
  for (const [routineId, list] of byRoutine) {
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) continue;
    const failed = failedCount(list);
    groups.push({ routineId, first, last, entries: list, failed, status: combinedStatus(failed, list) });
  }

  const byHour = new Map<number, RoutineRunGroup<Entry>[]>();
  for (const group of groups) {
    if (group.entries.length > 1) continue;
    const hour = hourOf(group.first.run.at);
    const list = byHour.get(hour);
    if (list) list.push(group);
    else byHour.set(hour, [group]);
  }
  const blocks = [...byHour]
    .sort(([left], [right]) => left - right)
    .map(([hour, hourGroups]) => {
      const failed = hourGroups.reduce((total, group) => total + group.failed, 0);
      return {
        hour,
        groups: hourGroups,
        failed,
        status: combinedStatus(
          failed,
          hourGroups.flatMap((group) => group.entries),
        ),
      };
    });

  return {
    runs: entries.length,
    failed: failedCount(entries),
    groups,
    repeating: groups.filter((group) => group.entries.length > 1),
    blocks,
  };
}

/** The first of the runs of each routine. `entries` are in time order. */
export function nextRunOfEachRoutine<Entry extends GroupableEntry>(entries: readonly Entry[]): Entry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.run.routineId)) return false;
    seen.add(entry.run.routineId);
    return true;
  });
}
