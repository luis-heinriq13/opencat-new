import type { AgentTask, HostAnalytics, RoutineCalendar } from "@openbot/contracts/ipc";
import { analyticsTokens } from "@openbot/contracts/ipc";

export interface BulletinInput {
  analytics: HostAnalytics | null;
  calendar: RoutineCalendar | null;
  tasks: readonly AgentTask[];
  /** The agents that wait for an approval, in the order the sidebar has them. */
  approvalAgentIds: readonly string[];
  agentName: (agentId: string) => string;
  /** The first instant of the period. */
  since: number;
  now: number;
}

export type BulletinAlert =
  | { kind: "approval"; agentId: string; agentName: string }
  | { kind: "routine"; agentId: string | null; agentName: string; title: string; at: string }
  | { kind: "task"; agentId: string; agentName: string; title: string; at: string; error: string | null };

export interface Bulletin {
  tokens: number;
  costUsd: number | null;
  turns: number;
  topAgents: { agentId: string; name: string; tokens: number }[];
  routines: { succeeded: number; failed: number; running: number; next: { name: string; at: string }[] };
  tasks: { running: number; queued: number; completed: number; failed: number };
  alerts: BulletinAlert[];
}

const TOP_AGENTS = 5;
const NEXT_ROUTINES = 5;

const FAILED_RUN = new Set(["failed", "interrupted", "needs-attention"]);

/** What happened on a server in a period, from the reports the host already keeps. It adds no new counter. */
export function summarizeBulletin(input: BulletinInput): Bulletin {
  const routines = new Map((input.calendar?.routines ?? []).map((routine) => [routine.id, routine]));
  const runs = (input.calendar?.runs ?? []).filter((run) => routines.has(run.routineId));
  const started = runs.filter((run) => {
    const at = Date.parse(run.at);
    return run.status !== "scheduled" && at >= input.since && at <= input.now;
  });

  const alerts: BulletinAlert[] = input.approvalAgentIds.map((agentId) => ({
    kind: "approval",
    agentId,
    agentName: input.agentName(agentId),
  }));

  const dated: Extract<BulletinAlert, { at: string }>[] = [];
  for (const run of started) {
    if (!FAILED_RUN.has(run.status)) continue;
    const routine = routines.get(run.routineId);
    if (!routine) continue;
    const agentId = routine.owner.kind === "agent" ? routine.owner.agentId : null;
    dated.push({
      kind: "routine",
      agentId,
      agentName: agentId ? input.agentName(agentId) : "",
      title: routine.name,
      at: run.at,
    });
  }

  const tasksInPeriod = input.tasks.filter((task) => Date.parse(task.updatedAt) >= input.since);
  for (const task of tasksInPeriod) {
    // A closed task was dealt with, so only an open failure asks for the user.
    if (task.outcome !== "failed" || task.state === "closed") continue;
    dated.push({
      kind: "task",
      agentId: task.agentId,
      agentName: input.agentName(task.agentId),
      title: task.title,
      at: task.updatedAt,
      error: task.error,
    });
  }
  dated.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  alerts.push(...dated);

  const next = runs
    .filter((run) => run.status === "scheduled" && Date.parse(run.at) > input.now)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(0, NEXT_ROUTINES)
    .map((run) => ({ name: routines.get(run.routineId)?.name ?? "", at: run.at }));

  const totals = input.analytics?.totals;
  return {
    tokens: totals ? analyticsTokens(totals) : 0,
    costUsd: totals?.estimatedCostUsd ?? null,
    turns: totals?.turns ?? 0,
    topAgents: (input.analytics?.agents ?? [])
      .map((agent) => ({
        agentId: agent.agentId,
        name: input.agentName(agent.agentId),
        tokens: analyticsTokens(agent),
      }))
      .filter((agent) => agent.tokens > 0)
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, TOP_AGENTS),
    routines: {
      succeeded: started.filter((run) => run.status === "succeeded").length,
      failed: started.filter((run) => FAILED_RUN.has(run.status)).length,
      running: started.filter((run) => run.status === "running" || run.status === "queued").length,
      next,
    },
    tasks: {
      running: input.tasks.filter((task) => task.state === "running").length,
      queued: input.tasks.filter((task) => task.state === "queued").length,
      completed: tasksInPeriod.filter((task) => task.outcome === "completed").length,
      failed: tasksInPeriod.filter((task) => task.outcome === "failed").length,
    },
    alerts,
  };
}
