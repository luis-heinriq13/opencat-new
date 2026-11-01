import type { AgentTask, HostAnalytics, RoutineCalendar } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { summarizeBulletin } from "./bulletin-model";

const now = Date.parse("2026-11-01T12:00:00Z");
const since = Date.parse("2026-11-01T00:00:00Z");

function task(overrides: Partial<AgentTask>): AgentTask {
  const base: AgentTask = {
    id: "t",
    agentId: "agent-a",
    threadId: "th",
    origin: "user",
    title: "Tarefa",
    state: "idle",
    outcome: null,
    hold: null,
    activeTurnId: null,
    progress: null,
    error: null,
    queuedMessages: [],
    createdAt: "2026-11-01T01:00:00Z",
    updatedAt: "2026-11-01T02:00:00Z",
    closedAt: null,
  };
  return { ...base, ...overrides };
}

const calendar: RoutineCalendar = {
  routines: [
    {
      id: "r1",
      name: "Monitor",
      owner: { kind: "agent", agentId: "agent-a" },
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    },
  ],
  runs: [
    { id: "1", routineId: "r1", at: "2026-11-01T09:00:00Z", status: "succeeded" },
    { id: "2", routineId: "r1", at: "2026-11-01T10:00:00Z", status: "failed" },
    { id: "3", routineId: "r1", at: "2026-10-30T10:00:00Z", status: "failed" },
    { id: "4", routineId: "r1", at: "2026-11-01T15:00:00Z", status: "scheduled" },
    { id: "5", routineId: "gone", at: "2026-11-01T10:00:00Z", status: "failed" },
  ],
};

const base = {
  analytics: null,
  calendar: null,
  tasks: [],
  approvalAgentIds: [],
  agentName: (id: string) => `nome-${id}`,
  since,
  now,
};

describe("summarizeBulletin", () => {
  it("counts only the routine runs of the period and lists the next ones", () => {
    const { routines } = summarizeBulletin({ ...base, calendar });
    expect(routines.succeeded).toBe(1);
    expect(routines.failed).toBe(1);
    expect(routines.next).toEqual([{ name: "Monitor", at: "2026-11-01T15:00:00Z" }]);
  });

  it("puts approvals first, then the newest failures", () => {
    const { alerts } = summarizeBulletin({
      ...base,
      calendar,
      approvalAgentIds: ["agent-b"],
      tasks: [task({ outcome: "failed", updatedAt: "2026-11-01T11:00:00Z", error: "boom" })],
    });
    expect(alerts.map((alert) => alert.kind)).toEqual(["approval", "task", "routine"]);
    expect(alerts[0]).toMatchObject({ agentName: "nome-agent-b" });
  });

  it("does not ask about a failed task that is closed or older than the period", () => {
    const { alerts, tasks } = summarizeBulletin({
      ...base,
      tasks: [
        task({ outcome: "failed", state: "closed" }),
        task({ outcome: "failed", updatedAt: "2026-10-20T00:00:00Z" }),
        task({ outcome: "completed" }),
        task({ state: "running" }),
      ],
    });
    expect(alerts).toEqual([]);
    expect(tasks).toEqual({ running: 1, queued: 0, completed: 1, failed: 1 });
  });

  it("reads tokens without cache reads and ranks the agents", () => {
    const row = {
      processedTokens: 100,
      cachedInput: 40,
      uncachedInput: 0,
      cacheCreation: 0,
      output: 0,
      estimatedCostUsd: 1.5,
      sessions: 1,
      userMessages: 1,
      assistantMessages: 1,
      turns: 2,
      missingUsageTurns: 0,
      unpricedRecords: 0,
      incompleteRecords: 0,
    };
    const analytics: HostAnalytics = {
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      timeZone: "UTC",
      collectionStartedAt: "2026-01-01T00:00:00Z",
      updatedAt: null,
      totals: row,
      daily: [],
      models: [],
      providerDaily: [],
      agents: [
        { ...row, agentId: "agent-a", processedTokens: 50, cachedInput: 0, share: 0.3 },
        { ...row, agentId: "agent-b", processedTokens: 90, cachedInput: 0, share: 0.7 },
        { ...row, agentId: "agent-c", processedTokens: 0, cachedInput: 0, share: 0 },
      ],
    };
    const bulletin = summarizeBulletin({ ...base, analytics });
    expect(bulletin.tokens).toBe(60);
    expect(bulletin.costUsd).toBe(1.5);
    expect(bulletin.topAgents.map((agent) => agent.agentId)).toEqual(["agent-b", "agent-a"]);
  });
});
