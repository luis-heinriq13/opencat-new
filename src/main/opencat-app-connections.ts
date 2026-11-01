// OpenCat: which agent answers for an app. WhatsApp (not official) keeps this in opencat-ponte.json in
// its data folder. The WhatsApp bridge reads the same file, so this module changes only the fields it
// owns (agentId, enabled, reply) and keeps every other field as it found it, also one it does not know.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AppConnectionChange, type AppConnectionStatus, NO_APP_CONNECTION } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";

export const BRIDGE_CONFIG_NAME = "opencat-ponte.json";

/** The folder the WhatsApp scripts use: WHATSCAT_DATA_DIR, or the default under Application Support. */
export function whatsappDataDirectory(): string {
  return process.env.WHATSCAT_DATA_DIR || join(homedir(), "Library", "Application Support", "OpenCat-WhatsCat");
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").length : 0;
}

function statusOf(config: DynamicRecord | null): AppConnectionStatus {
  if (!config) return NO_APP_CONNECTION;
  const agentId = typeof config.agentId === "string" && config.agentId.length > 0 ? config.agentId : null;
  return {
    app: "whatsapp",
    configured: true,
    agentId,
    enabled: config.enabled === true,
    reply: config.reply === "pause" ? "pause" : "auto",
    scope: config.mode === "all" ? "all" : "selected",
    chatCount: countOf(config.chats),
    groupCount: countOf(config.groups),
    excludedCount: countOf(config.excludes),
  };
}

/** The saved object, null when there is no file. A file that is not a JSON object throws. */
async function readDynamicRecord(file: string): Promise<DynamicRecord | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!isDynamicRecord(parsed)) throw new Error("The WhatsApp connection file is not a JSON object.");
  return { ...parsed };
}

/** Writes next to the file and renames over it, so the bridge never reads half a file. Mode 0600. */
async function writeDynamicRecordAtomically(file: string, config: DynamicRecord): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Reads the connection. A missing file, or one that cannot be read, is "no agent". */
export async function readAppConnection(dataDirectory: string): Promise<AppConnectionStatus> {
  try {
    return statusOf(await readDynamicRecord(join(dataDirectory, BRIDGE_CONFIG_NAME)));
  } catch {
    return NO_APP_CONNECTION;
  }
}

function apply(config: DynamicRecord, change: AppConnectionChange): DynamicRecord {
  switch (change.action) {
    case "set-agent":
      return { ...config, agentId: change.agentId, enabled: true, reply: "auto" };
    case "turn-on":
      if (typeof config.agentId !== "string" || config.agentId.length === 0) {
        throw new Error("Pick an agent before turning the connection on.");
      }
      return { ...config, enabled: true, reply: "auto" };
    case "pause":
      return { ...config, reply: "pause" };
    case "disconnect": {
      const { agentId: _removed, ...rest } = config;
      return { ...rest, enabled: false };
    }
  }
}

// One write at a time, so two quick clicks never read the same file and lose a change.
let queue: Promise<unknown> = Promise.resolve();

/** Applies one change and answers with the status after it. A file that cannot be read is never replaced. */
export function changeAppConnection(dataDirectory: string, change: AppConnectionChange): Promise<AppConnectionStatus> {
  const run = async (): Promise<AppConnectionStatus> => {
    const file = join(dataDirectory, BRIDGE_CONFIG_NAME);
    const current = await readDynamicRecord(file);
    if (current === null && change.action !== "set-agent") return NO_APP_CONNECTION;
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const next = apply(current ?? { mode: "selected", chats: [], groups: [], excludes: [] }, change);
    await writeDynamicRecordAtomically(file, next);
    return statusOf(next);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
