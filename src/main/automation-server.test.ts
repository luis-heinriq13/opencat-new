import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTask, DEFAULT_AGENT_DEFAULTS, type QueuedMessageReceipt } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTOMATION_TOKEN_FILE, AUTOMATION_URL_FILE } from "../backend/automation-command";
import { AutomationServer, type AutomationServerOptions } from "./automation-server";

const receipt = (id: string): QueuedMessageReceipt => ({
  messageId: "m",
  deliveries: [{ id, recipientAgentId: "agent-1", status: "queued", position: null }],
});

const unused = () => Effect.die(new Error("not used by these tests"));

const task = (id: string, title: string, state: AgentTask["state"] = "idle"): AgentTask => ({
  id,
  agentId: "agent-1",
  threadId: `thread-${id}`,
  origin: "user",
  title,
  state,
  outcome: null,
  hold: null,
  activeTurnId: null,
  progress: null,
  error: null,
  queuedMessages: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
});

describe("automation server tasks route", () => {
  let root: string;
  let server: AutomationServer;
  let tasks: AgentTask[];
  const sent: Array<{ taskId?: string; text: string; clientMessageId?: string }> = [];
  const started: Array<{ title: string; text: string }> = [];
  const closed: string[] = [];
  let base = "";
  let token = "";

  const options = (): AutomationServerOptions => ({
    root,
    runRoutine: unused,
    getLocalAttention: () => ({ prompts: [], approvals: [], browserTakeovers: [] }),
    respondToLocalAttention: unused,
    updateAgent: unused,
    clearAgentContext: unused,
    listAgents: () => [
      {
        id: "agent-1",
        name: "A",
        allowAutomation: true,
        access: "workspace",
        provider: "claude",
        model: "claude-sonnet-5-5",
        reasoningEffort: "high",
      },
    ],
    agentDefaults: () => DEFAULT_AGENT_DEFAULTS,
    listModels: () => [],
    listRoutines: () => [],
    sendMessage: (input: { taskId?: string; text: string; clientMessageId?: string }) => {
      sent.push(input);
      return Effect.succeed(receipt("d-1"));
    },
    listTasks: () => ({ agentId: "agent-1", tasks, limit: 2 }),
    startTask: (input: { title: string; text: string }) => {
      started.push(input);
      const created = task(`t${tasks.length + 1}`, input.title);
      tasks = [...tasks, created];
      return Effect.succeed({ task: created, receipt: receipt("d-new") });
    },
    closeTask: (input: { taskId: string }) => {
      closed.push(input.taskId);
      tasks = tasks.map((item) => (item.id === input.taskId ? { ...item, state: "closed" as const } : item));
      return Effect.void;
    },
    delivery: (id: string) =>
      id === "d-1"
        ? { recipientAgentId: "agent-1", status: "completed", turnId: "turn", error: null, taskId: "t1" }
        : null,
    turnAnswer: (_agent: string, _turn: string, taskId?: string | null) => (taskId ? `answer:${taskId}` : "main"),
  });

  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "automation-tasks-"));
    tasks = [];
    sent.length = 0;
    started.length = 0;
    closed.length = 0;
    server = new AutomationServer(options());
    await Effect.runPromise(server.sync());
    base = (await readFile(join(root, AUTOMATION_URL_FILE), "utf8")).trim();
    token = (await readFile(join(root, AUTOMATION_TOKEN_FILE), "utf8")).trim();
  });

  afterEach(async () => {
    await Effect.runPromise(server.stop());
    await rm(root, { recursive: true, force: true });
  });

  it("starts one task per key, then sends to the same task", async () => {
    const first = await call("/v1/agents/agent-1/tasks", { key: "WhatsApp #abc", text: "hi", clientMessageId: "a" });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ taskId: "t1", created: true });
    const second = await call("/v1/agents/agent-1/tasks", {
      key: "WhatsApp #abc",
      text: "again",
      clientMessageId: "b",
    });
    expect(await second.json()).toMatchObject({ taskId: "t1", created: false });
    expect(started).toHaveLength(1);
    expect(sent[0]).toMatchObject({ taskId: "t1", clientMessageId: "automation:b" });
  });

  it("keeps two keys in two tasks, and does not start two for parallel calls", async () => {
    const calls = await Promise.all([
      call("/v1/agents/agent-1/tasks", { key: "WhatsApp #one", text: "x", clientMessageId: "1" }),
      call("/v1/agents/agent-1/tasks", { key: "WhatsApp #one", text: "y", clientMessageId: "2" }),
      call("/v1/agents/agent-1/tasks", { key: "WhatsApp #two", text: "z", clientMessageId: "3" }),
    ]);
    expect(calls.map((response) => response.status)).toEqual([202, 202, 202]);
    expect(started.map((item) => item.title).sort()).toEqual(["WhatsApp #one", "WhatsApp #two"]);
  });

  it("refuses the 51st open task with 409 and a bad key with 400", async () => {
    tasks = Array.from({ length: 50 }, (_, index) => task(`t${index}`, `Other ${index}`));
    const full = await call("/v1/agents/agent-1/tasks", { key: "WhatsApp #new", text: "x", clientMessageId: "1" });
    expect(full.status).toBe(409);
    const bad = await call("/v1/agents/agent-1/tasks", { key: "../x\n", text: "x", clientMessageId: "1" });
    expect(bad.status).toBe(400);
  });

  it("applies the same auth and origin rules as the other routes", async () => {
    const body = { key: "WhatsApp #abc", text: "hi", clientMessageId: "a" };
    expect((await call("/v1/agents/agent-1/tasks", body, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("/v1/agents/agent-1/tasks", body, { origin: "http://evil.example" })).status).toBe(403);
    expect(started).toHaveLength(0);
  });

  it("closes a task, and reads the answer of a task delivery from the task thread", async () => {
    tasks = [task("t1", "WhatsApp #abc")];
    expect((await call("/v1/agents/agent-1/tasks/t1/close", {})).status).toBe(200);
    expect(closed).toEqual(["t1"]);
    expect((await call("/v1/agents/agent-1/tasks/nope/close", {})).status).toBe(404);
    const delivery = await (await call("/v1/agents/agent-1/deliveries/d-1")).json();
    expect(delivery).toMatchObject({ status: "completed", answer: "answer:t1", taskId: "t1" });
  });
});
