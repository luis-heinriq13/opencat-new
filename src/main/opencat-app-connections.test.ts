import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAppConnectionChange } from "./ipc/app-connection-inputs";
import { BRIDGE_CONFIG_NAME, changeAppConnection, readAppConnection } from "./opencat-app-connections";

function folder(): string {
  return mkdtempSync(join(tmpdir(), "conexao-app-"));
}

function save(dir: string, value: unknown): void {
  writeFileSync(join(dir, BRIDGE_CONFIG_NAME), typeof value === "string" ? value : JSON.stringify(value));
}

function load(dir: string) {
  return JSON.parse(readFileSync(join(dir, BRIDGE_CONFIG_NAME), "utf8"));
}

const WHATSAPP = "whatsapp" as const;

describe("app connection file", () => {
  it("reports no agent when the file is missing or unreadable", async () => {
    const dir = folder();
    expect(await readAppConnection(dir)).toMatchObject({ configured: false, agentId: null, enabled: false });
    save(dir, "{ not json");
    expect(await readAppConnection(dir)).toMatchObject({ configured: false, agentId: null });
  });

  it("reads the agent, the reply mode and counts only", async () => {
    const dir = folder();
    save(dir, {
      enabled: true,
      agentId: "agent-1",
      mode: "all",
      reply: "pause",
      chats: ["5511999999999@s.whatsapp.net", "5511888888888@s.whatsapp.net", 7],
      groups: ["1@g.us"],
      excludes: [],
    });
    const status = await readAppConnection(dir);
    expect(status).toEqual({
      app: WHATSAPP,
      configured: true,
      agentId: "agent-1",
      enabled: true,
      reply: "pause",
      scope: "all",
      chatCount: 2,
      groupCount: 1,
      excludedCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain("5511");
  });

  it("sets an agent, keeps every other field and writes a private file", async () => {
    const dir = folder();
    save(dir, { enabled: false, agentId: "old", chats: ["a@s.whatsapp.net"], pollSeconds: 15, futureField: { x: 1 } });
    const status = await changeAppConnection(dir, { app: WHATSAPP, action: "set-agent", agentId: "new" });
    expect(status).toMatchObject({ agentId: "new", enabled: true, reply: "auto", chatCount: 1 });
    expect(load(dir)).toEqual({
      enabled: true,
      agentId: "new",
      reply: "auto",
      chats: ["a@s.whatsapp.net"],
      pollSeconds: 15,
      futureField: { x: 1 },
    });
    expect(statSync(join(dir, BRIDGE_CONFIG_NAME)).mode & 0o777).toBe(0o600);
  });

  it("creates the file with no chats when the first agent is picked", async () => {
    const dir = join(folder(), "novo");
    const status = await changeAppConnection(dir, { app: WHATSAPP, action: "set-agent", agentId: "agent-1" });
    expect(status).toMatchObject({ configured: true, agentId: "agent-1", enabled: true, chatCount: 0 });
    expect(statSync(join(dir, BRIDGE_CONFIG_NAME)).mode & 0o777).toBe(0o600);
  });

  it("pauses and resumes without touching the agent", async () => {
    const dir = folder();
    save(dir, { enabled: true, agentId: "agent-1", extra: true });
    expect(await changeAppConnection(dir, { app: WHATSAPP, action: "pause" })).toMatchObject({
      agentId: "agent-1",
      reply: "pause",
    });
    expect(load(dir)).toMatchObject({ agentId: "agent-1", reply: "pause", extra: true });
    expect(await changeAppConnection(dir, { app: WHATSAPP, action: "turn-on" })).toMatchObject({
      agentId: "agent-1",
      enabled: true,
      reply: "auto",
    });
  });

  it("refuses to turn on without an agent", async () => {
    const dir = folder();
    save(dir, { enabled: false });
    await expect(changeAppConnection(dir, { app: WHATSAPP, action: "turn-on" })).rejects.toThrow();
    expect(load(dir)).toEqual({ enabled: false });
  });

  it("disconnects the agent and keeps the allowed chats", async () => {
    const dir = folder();
    save(dir, { enabled: true, agentId: "agent-1", chats: ["a@s.whatsapp.net"], reply: "auto" });
    const status = await changeAppConnection(dir, { app: WHATSAPP, action: "disconnect" });
    expect(status).toMatchObject({ agentId: null, enabled: false, chatCount: 1 });
    expect(load(dir)).toEqual({ enabled: false, chats: ["a@s.whatsapp.net"], reply: "auto" });
  });

  it("does nothing for pause or disconnect when there is no file", async () => {
    const dir = folder();
    expect(await changeAppConnection(dir, { app: WHATSAPP, action: "pause" })).toMatchObject({ configured: false });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never replaces a file it cannot read", async () => {
    const dir = folder();
    save(dir, "{ not json");
    await expect(
      changeAppConnection(dir, { app: WHATSAPP, action: "set-agent", agentId: "agent-1" }),
    ).rejects.toThrow();
    expect(readFileSync(join(dir, BRIDGE_CONFIG_NAME), "utf8")).toBe("{ not json");
    expect(readdirSync(dir)).toEqual([BRIDGE_CONFIG_NAME]);
  });

  it("leaves no temporary file and keeps quick changes in order", async () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    save(dir, { enabled: true, agentId: "agent-1", keep: 1 });
    await Promise.all([
      changeAppConnection(dir, { app: WHATSAPP, action: "pause" }),
      changeAppConnection(dir, { app: WHATSAPP, action: "turn-on" }),
      changeAppConnection(dir, { app: WHATSAPP, action: "pause" }),
    ]);
    expect(load(dir)).toMatchObject({ reply: "pause", keep: 1 });
    expect(readdirSync(dir)).toEqual([BRIDGE_CONFIG_NAME]);
  });
});

describe("app connection input", () => {
  it("accepts the four actions and rejects anything else", () => {
    expect(parseAppConnectionChange({ app: WHATSAPP, action: "set-agent", agentId: "a" })).toEqual({
      app: WHATSAPP,
      action: "set-agent",
      agentId: "a",
    });
    expect(parseAppConnectionChange({ app: WHATSAPP, action: "pause" })).toEqual({ app: WHATSAPP, action: "pause" });
    expect(() => parseAppConnectionChange({ app: WHATSAPP, action: "set-agent" })).toThrow();
    expect(() => parseAppConnectionChange({ app: "other", action: "pause" })).toThrow();
    expect(() => parseAppConnectionChange({ app: WHATSAPP, action: "wipe" })).toThrow();
    expect(() => parseAppConnectionChange(null)).toThrow();
  });
});
