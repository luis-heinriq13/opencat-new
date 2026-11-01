// Checks that Gemini's spent model quota moves an agent to its backup model. Antigravity reports the
// quota as answer text and ends the turn as a success. Runs the real agent service, the real
// Antigravity driver and ACP client on a temporary profile, with a stand-in server that has the
// `model` and `thinking_level` options of Antigravity 1.4.5 and refuses a model it does not offer.
// Checks:
//   1. An agent with no backup model fails with the quota message.
//   2. An agent with a backup model runs the message again on the backup, with no error.
//   3. Each effort reaches the server as the value of its `thinking_level` option.
// `bun scripts/antigravity-quota-failover-e2e.ts`. Writes .openbot-build/antigravity-quota-failover-e2e/report.json.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-quota-failover-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-antigravity-quota-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const server = join(root, "runtime/bin/agy_acp_server.par");
const turnLog = join(root, "turns.jsonl");
const FLASH = "gemini-3.8-flash";
const BACKUP = "claude-sonnet-4-6";

// Before the service modules load: the stores and the CLI search read these.
process.env.HOME = home;
process.env.OPENBOT_ANTIGRAVITY_PATH = server;
process.env.GEMINI_HOME = join(home, ".gemini");
process.env.FAKE_AGY_TURNS = turnLog;
mkdirSync(join(root, "runtime/bin"), { recursive: true });
mkdirSync(join(home, ".gemini"), { recursive: true });
writeFileSync(join(root, "runtime/antigravity-package.json"), JSON.stringify({ version: "1.4.5" }));

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const NL = String.fromCharCode(10);
const MODELS = [
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
];
const LISTED = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6"];
const sessions = new Map();
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + NL);
function setup(id) {
  const session = sessions.get(id);
  const flash = session.model === "gemini-3.8-flash";
  const select = (option, category, name, currentValue, options) => ({ id: option, category, name, type: "select", currentValue, options });
  return {
    configOptions: [
      select("model", "model", "Model", session.model, MODELS.map(([value, name]) => ({ value, name }))),
      ...(flash ? [select("thinking_level", "thought_level", "Thinking", session.level, ["low", "medium", "high"].map((value) => ({ value, name: value })))] : []),
    ],
    models: {
      currentModelId: flash ? "gemini-3.8-flash-" + session.level : session.model,
      availableModels: LISTED.map((modelId) => ({ modelId, name: modelId })),
    },
  };
}
function handle(message) {
  if (message.id === undefined) return;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
    case "session/new": {
      const sessionId = "s-" + process.pid + "-" + message.id;
      sessions.set(sessionId, { model: "gemini-3.8-flash", level: "high" });
      return write({ id: message.id, result: { sessionId, ...setup(sessionId) } });
    }
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (params.configId === "model") {
        if (!MODELS.some(([value]) => value === params.value))
          return write({ id: message.id, error: { code: -32602, message: "Model '" + params.value + "' is not available for the current authentication method." } });
        session.model = params.value;
      } else if (params.configId === "thinking_level") session.level = params.value;
      return write({ id: message.id, result: { configOptions: setup(params.sessionId).configOptions } });
    }
    case "session/prompt": {
      const session = sessions.get(params.sessionId);
      const input = (params.prompt ?? []).map((part) => part.text ?? "").join(" ");
      const limited = session.model === "gemini-3.8-flash" && input.includes("spend-quota");
      fs.appendFileSync(process.env.FAKE_AGY_TURNS, JSON.stringify({ model: session.model, level: session.level, input, limited }) + NL);
      const text = limited ? "Usage Limit Reached" + NL + NL + "Your quota will reset after 5h0m0s." : "ok";
      write({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      return write({ id: message.id, result: { stopReason: "end_turn" } });
    }
    default:
      return write({ id: message.id, result: {} });
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;
writeFileSync(server, STAND_IN, { mode: 0o755 });
appendFileSync(turnLog, "");

const unused = () => {
  throw new Error("This check uses no browser.");
};
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

const report: { checks: { name: string; detail: unknown }[]; passed: boolean; error?: string; checkedAt?: string } = {
  checks: [],
  passed: false,
};
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const events: AgentEvent[] = [];
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "antigravity",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "antigravity"),
});
service.on("event", (event) => events.push(event));

async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const turns = (): { model: string; level: string; input: string; limited: boolean }[] =>
  readFileSync(turnLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function send(agentId: string, text: string) {
  const receipt = await runCauseEffect(service.sendMessage({ agentId, text, attachmentDraftIds: [] }));
  const deliveryId = receipt.deliveries[0]?.id;
  assert.ok(deliveryId, "The message has a delivery.");
  const status = await waitFor(`"${text}" to end`, () => {
    const value = mailbox.getDelivery(deliveryId)?.delivery.status;
    return value === "completed" || value === "failed" ? value : null;
  });
  return { status, error: mailbox.getDelivery(deliveryId)?.delivery.error ?? null };
}

const create = async (name: string) => {
  const agent = await runCauseEffect(
    service.createAgent({
      name,
      description: "Checks a spent Gemini quota.",
      avatarSeed: name.toLowerCase(),
      avatarHue: null,
      initialMessage: "Hello.",
      provider: "antigravity",
      model: FLASH,
    }),
  );
  await waitFor(
    `${name} to finish its first turn`,
    () =>
      !service
        .listQueue(agent.id)
        .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status)),
  );
  return agent;
};
const modelOf = (agentId: string) => store.list().find((agent) => agent.id === agentId)?.model;
const errorsFor = (agentId: string, since: number) =>
  events.slice(since).filter((event) => event.type === "error" && event.agentId === agentId);

try {
  await runCauseEffect(service.initialize());
  const stayer = await create("Stayer");
  const mover = await create("Mover");
  await runCauseEffect(
    service.updateAgent({
      agentId: mover.id,
      backupModels: { automatic: true, order: [{ provider: "antigravity", model: BACKUP }] },
    }),
  );

  const stay = await send(stayer.id, "spend-quota alone");
  assert.equal(stay.status, "failed", "With no backup, the turn fails.");
  assert.match(stay.error ?? "", /Gemini usage limit is reached/u);
  assert.equal(modelOf(stayer.id), FLASH, "The agent stays on its own model.");
  report.checks.push({ name: "no backup: the quota message shows", detail: stay });

  const since = events.length;
  const before = turns().length;
  const move = await send(mover.id, "spend-quota backup");
  assert.equal(move.status, "completed", `The message completes on the backup: ${move.error}`);
  const ran = turns().slice(before);
  assert.deepEqual(
    ran.map((turn) => turn.model),
    [FLASH, BACKUP],
    "The message ran on the own model, then on the backup.",
  );
  assert.equal(modelOf(mover.id), BACKUP, "The agent is on the backup model.");
  assert.deepEqual(errorsFor(mover.id, since), [], "No error shows for the moved turn.");
  report.checks.push({ name: "a spent quota moves the agent to its backup", detail: ran });

  const levels: Record<string, string> = {};
  for (const effort of ["low", "medium", "high"] as const) {
    const start = turns().length;
    await runCauseEffect(service.updateAgent({ agentId: stayer.id, reasoningEffort: effort }));
    const outcome = await send(stayer.id, `effort ${effort}`);
    assert.equal(outcome.status, "completed", outcome.error ?? "The turn completes.");
    const turn = turns()
      .slice(start)
      .find((entry) => entry.input.includes(`effort ${effort}`));
    assert.equal(turn?.level, effort, `Effort ${effort} reaches the server.`);
    levels[effort] = turn?.level ?? "";
  }
  report.checks.push({ name: "each effort reaches thinking_level", detail: levels });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  report.checkedAt = new Date().toISOString();
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
  process.exit();
}
