import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalUpdateInfo } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("local-update");

/**
 * The manifest that `scripts/opencat-preparar-atualizacao.sh` writes after it builds this fork.
 * Every field is checked: the file sits in the user's home, so it is untrusted input.
 */
export interface LocalUpdateManifest extends LocalUpdateInfo {
  schema: 1;
  version: string;
  appPath: string;
}

export interface LocalUpdateSourcePaths {
  /** `~/OpenCat-updates` */
  updatesDirectory: string;
  /** The only build path that may be installed. */
  expectedAppPath: string;
}

export function defaultLocalUpdatePaths(): LocalUpdateSourcePaths {
  return {
    updatesDirectory: join(homedir(), "OpenCat-updates"),
    expectedAppPath: join(homedir(), "Downloads", "openbot", "dist", "mac-arm64", "OpenBot.app"),
  };
}

export type CodesignResult = { valid: boolean; teamId: string | null };

export interface LocalUpdateDependencies {
  paths: LocalUpdateSourcePaths;
  /** The uid that must own the files. */
  uid: number;
  /** The Team ID of the running app. A build with another Team ID is never offered. */
  ownTeamId: () => Promise<string | null>;
  codesign: (appPath: string) => Promise<CodesignResult>;
}

export type LocalUpdateResult = { ok: true; update: LocalUpdateManifest } | { ok: false; reason: string };

const MAX_MANIFEST_BYTES = 64 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:-dirty-[0-9a-f]{8})?$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const MANIFEST_KEYS = ["appPath", "builtAt", "changes", "commit", "schema", "version"];
const MAX_CHANGES = 50;
const MAX_CHANGE_LENGTH = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the check rejects control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the manifest when every field is valid, or the reason it is not. */
export function parseLocalUpdateManifest(text: string, expectedAppPath: string): LocalUpdateResult {
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "pending.json is not JSON" };
  }
  if (!isRecord(value)) return { ok: false, reason: "pending.json is not an object" };
  if (Object.keys(value).sort().join() !== MANIFEST_KEYS.join()) return { ok: false, reason: "unexpected fields" };
  const { schema, commit, version, builtAt, appPath, changes } = value;
  if (schema !== 1) return { ok: false, reason: "unknown schema" };
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) return { ok: false, reason: "invalid commit" };
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return { ok: false, reason: "invalid version" };
  if (typeof builtAt !== "string" || builtAt.length > 40 || Number.isNaN(Date.parse(builtAt))) {
    return { ok: false, reason: "invalid builtAt" };
  }
  if (appPath !== expectedAppPath) return { ok: false, reason: "appPath is not the expected build path" };
  const lines = Array.isArray(changes) ? changes.filter((line): line is string => typeof line === "string") : [];
  if (
    !Array.isArray(changes) ||
    lines.length !== changes.length ||
    lines.length < 1 ||
    lines.length > MAX_CHANGES ||
    !lines.every((line) => line.length > 0 && line.length <= MAX_CHANGE_LENGTH && !CONTROL_CHARACTERS.test(line))
  ) {
    return { ok: false, reason: "invalid changes" };
  }
  return { ok: true, update: { schema, commit, version, builtAt, appPath, changes: lines } };
}

async function checkOwnedEntry(
  path: string,
  kind: "directory" | "file",
  uid: number,
  maxBytes?: number,
): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return `${path} is missing`;
  }
  if (info.isSymbolicLink()) return `${path} is a symbolic link`;
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return `${path} is not a ${kind}`;
  if (info.uid !== uid) return `${path} is owned by another user`;
  if ((Number(info.mode) & 0o022) !== 0) return `${path} is writable by other users`;
  if (maxBytes !== undefined && info.size > maxBytes) return `${path} is too large`;
  return null;
}

/** Reads and validates the local update. Never throws. */
export async function readLocalUpdate(deps: LocalUpdateDependencies): Promise<LocalUpdateResult> {
  const { paths, uid } = deps;
  const directoryProblem = await checkOwnedEntry(paths.updatesDirectory, "directory", uid);
  if (directoryProblem) return { ok: false, reason: directoryProblem };
  const pendingPath = join(paths.updatesDirectory, "pending.json");
  const pendingProblem = await checkOwnedEntry(pendingPath, "file", uid, MAX_MANIFEST_BYTES);
  if (pendingProblem) return { ok: false, reason: pendingProblem };
  let text: string;
  try {
    text = await readFile(pendingPath, "utf8");
  } catch {
    return { ok: false, reason: "pending.json cannot be read" };
  }
  const parsed = parseLocalUpdateManifest(text, paths.expectedAppPath);
  if (!parsed.ok) return parsed;

  const installedPath = join(paths.updatesDirectory, "installed.json");
  const installedProblem = await checkOwnedEntry(installedPath, "file", uid, MAX_MANIFEST_BYTES);
  if (installedProblem === null) {
    try {
      const installed: JsonValue = JSON.parse(await readFile(installedPath, "utf8"));
      if (isRecord(installed) && installed.commit === parsed.update.commit) {
        return { ok: false, reason: "this commit is already installed" };
      }
    } catch {
      return { ok: false, reason: "installed.json cannot be read" };
    }
  }

  const appProblem = await checkOwnedEntry(paths.expectedAppPath, "directory", uid);
  if (appProblem) return { ok: false, reason: appProblem };
  const ownTeamId = await deps.ownTeamId();
  if (ownTeamId === null) return { ok: false, reason: "the running app has no Team ID" };
  const signature = await deps.codesign(paths.expectedAppPath);
  if (!signature.valid) return { ok: false, reason: "the signature of the build is not valid" };
  if (signature.teamId !== ownTeamId) return { ok: false, reason: "the Team ID of the build is different" };
  return parsed;
}

export function codesignWithSystemTool(appPath: string): Promise<CodesignResult> {
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 60_000 }, (verifyError) => {
      if (verifyError) {
        resolve({ valid: false, teamId: null });
        return;
      }
      execFile("/usr/bin/codesign", ["-dv", "--verbose=2", appPath], { timeout: 30_000 }, (_error, stdout, stderr) => {
        const match = /TeamIdentifier=(\S+)/u.exec(`${stderr}${stdout}`);
        resolve({ valid: true, teamId: match && match[1] !== "not" ? (match[1] ?? null) : null });
      });
    });
  });
}

/** Where the running app's bundle is, for example `/Applications/OpenCat.app`. */
export function bundlePathFromExecutable(executablePath: string): string | null {
  const index = executablePath.indexOf(".app/Contents/MacOS/");
  return index < 0 ? null : executablePath.slice(0, index + ".app".length);
}

export interface LocalUpdateSourceOptions {
  dependencies: LocalUpdateDependencies;
  onUpdate: (update: LocalUpdateManifest | null) => void;
  initialDelayMs?: number;
  intervalMs?: number;
}

/** Reads `pending.json` at startup and every 15 minutes. An invalid file is logged and ignored. */
export class LocalUpdateSource {
  readonly #options: LocalUpdateSourceOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #lastReason: string | null = null;

  constructor(options: LocalUpdateSourceOptions) {
    this.#options = options;
  }

  start(): void {
    this.#schedule(this.#options.initialDelayMs ?? 15_000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async checkNow(): Promise<void> {
    const result = await readLocalUpdate(this.#options.dependencies);
    if (this.#stopped) return;
    if (result.ok) {
      this.#lastReason = null;
      this.#options.onUpdate(result.update);
      return;
    }
    // Absent files are the normal case, and the same reason twice in a row adds no information.
    if (this.#lastReason !== result.reason) logger.info(`No local update offered: ${result.reason}`);
    this.#lastReason = result.reason;
    this.#options.onUpdate(null);
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.checkNow()
        .catch((error: unknown) => logger.warn(`The local update check failed: ${String(error)}`))
        .finally(() => this.#schedule(this.#options.intervalMs ?? 15 * 60 * 1_000));
    }, delayMs);
    this.#timer.unref();
  }
}

/**
 * Starts the installer script, detached, so it survives the quit of this app. The script is copied
 * out of the app bundle first, because the installer replaces that bundle.
 */
export async function spawnLocalInstaller(input: {
  resourcesPath: string;
  updatesDirectory: string;
  commit: string;
  bundlePath: string;
}): Promise<void> {
  const runDirectory = join(input.updatesDirectory, "run");
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const script = join(runDirectory, "opencat-instalar-atualizacao.py");
  await copyFile(join(input.resourcesPath, "opencat", "opencat-instalar-atualizacao.py"), script);
  const child = spawn(
    "/usr/bin/python3",
    ["-I", script, "--commit", input.commit, "--atual", input.bundlePath, "--wait-pid", String(process.pid)],
    { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir() } },
  );
  child.unref();
}
