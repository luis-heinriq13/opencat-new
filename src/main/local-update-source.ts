import { execFile, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
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
  /** The version stays that of the package; the build tells two builds of it apart. */
  build?: LocalUpdateBuild;
}

/** `number` is `git rev-list --count HEAD`; `commit` is the short commit of that build. */
export interface LocalUpdateBuild {
  number: number;
  commit: string;
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
  /** Clock for the age of the installation markers. Tests set it. */
  now?: () => number;
  /** The Team ID of the running app. A build with another Team ID is never offered. */
  ownTeamId: () => Promise<string | null>;
  codesign: (appPath: string) => Promise<CodesignResult>;
}

/** What the updater holds for a local update: the public fields, the version and the build. */
export type LocalUpdateOffer = LocalUpdateInfo & { version: string; build?: LocalUpdateBuild };

export type LocalUpdateResult = { ok: true; update: LocalUpdateManifest } | { ok: false; reason: string };

const MAX_MANIFEST_BYTES = 64 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:-dirty-[0-9a-f]{8})?$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const MANIFEST_KEYS = ["appPath", "builtAt", "changes", "commit", "schema", "version"];
const BUILD_COMMIT_PATTERN = /^[0-9a-f]{7,12}$/u;
const MAX_BUILD_NUMBER = 10_000_000;
/**
 * The installer holds `instalacao.lock` for the whole install and parks `pending.json` as
 * `pending.instalando.json` before it opens the new app. While either exists nothing is offered, or
 * the new app would offer the update it is part of. A marker an interrupted installer left behind
 * stops counting after this long.
 */
const INSTALL_MARKERS = ["instalacao.lock", "pending.instalando.json"];
const INSTALL_MARKER_MAX_AGE_MS = 45 * 60 * 1000;
const MAX_CHANGES = 50;
const MAX_CHANGE_LENGTH = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the check rejects control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBuild(value: JsonValue | undefined): LocalUpdateBuild | null {
  if (value === undefined || !isRecord(value)) return null;
  if (Object.keys(value).sort().join() !== "commit,number") return null;
  const { number, commit } = value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > MAX_BUILD_NUMBER) return null;
  if (typeof commit !== "string" || !BUILD_COMMIT_PATTERN.test(commit)) return null;
  return { number, commit };
}

/** "0.57.0 (build 2841 · 5ffe2bc)", or the bare version when the build is unknown. */
export function formatVersionLabel(version: string, build: LocalUpdateBuild | null | undefined): string {
  return build ? `${version} (build ${build.number} \u00b7 ${build.commit})` : version;
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
  const expectedKeys = "build" in value ? [...MANIFEST_KEYS, "build"].sort() : MANIFEST_KEYS;
  if (Object.keys(value).sort().join() !== expectedKeys.join()) return { ok: false, reason: "unexpected fields" };
  const { schema, commit, version, builtAt, appPath, changes } = value;
  const build = "build" in value ? parseBuild(value.build) : undefined;
  if (build === null) return { ok: false, reason: "invalid build" };
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
  return {
    ok: true,
    update: { schema, commit, version, builtAt, appPath, changes: lines, ...(build ? { build } : {}) },
  };
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

async function installationInProgress(deps: LocalUpdateDependencies): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  for (const name of INSTALL_MARKERS) {
    try {
      const info = await lstat(join(deps.paths.updatesDirectory, name));
      if (now - info.mtimeMs <= INSTALL_MARKER_MAX_AGE_MS) return name;
    } catch {
      // Absent is the normal case.
    }
  }
  return null;
}

/**
 * The manifest checks that need no signature: the folder, the installation markers, `pending.json`
 * and `installed.json`. Cheap enough for the click on "Update". Never throws.
 */
export async function readPendingManifest(deps: LocalUpdateDependencies): Promise<LocalUpdateResult> {
  const { paths, uid } = deps;
  const directoryProblem = await checkOwnedEntry(paths.updatesDirectory, "directory", uid);
  if (directoryProblem) return { ok: false, reason: directoryProblem };
  const marker = await installationInProgress(deps);
  if (marker) return { ok: false, reason: `an installation is in progress (${marker})` };
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
  return parsed;
}

/** Reads and validates the local update. Never throws. */
export async function readLocalUpdate(deps: LocalUpdateDependencies): Promise<LocalUpdateResult> {
  const parsed = await readPendingManifest(deps);
  if (!parsed.ok) return parsed;
  const { paths, uid } = deps;
  const appProblem = await checkOwnedEntry(paths.expectedAppPath, "directory", uid);
  if (appProblem) return { ok: false, reason: appProblem };
  const ownTeamId = await deps.ownTeamId();
  if (ownTeamId === null) return { ok: false, reason: "the running app has no Team ID" };
  const signature = await deps.codesign(paths.expectedAppPath);
  if (!signature.valid) return { ok: false, reason: "the signature of the build is not valid" };
  if (signature.teamId !== ownTeamId) return { ok: false, reason: "the Team ID of the build is different" };
  return parsed;
}

/**
 * Asked on the click on "Update", before and after the question: the manifest must still exist, be
 * new and be the one that was offered. False means the offer is stale and must not quit the app.
 */
export async function localUpdateStillOffered(deps: LocalUpdateDependencies, commit: string): Promise<boolean> {
  const result = await readPendingManifest(deps);
  return result.ok && result.update.commit === commit;
}

/** The build of the installed app, from `installed.json`. Null when it is missing or has none. Never throws. */
export async function readInstalledBuild(
  updatesDirectory: string,
  uid: number,
): Promise<{ version: string | null; build: LocalUpdateBuild } | null> {
  const path = join(updatesDirectory, "installed.json");
  if ((await checkOwnedEntry(path, "file", uid, MAX_MANIFEST_BYTES)) !== null) return null;
  try {
    const installed: JsonValue = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(installed)) return null;
    const build = parseBuild(installed.build);
    if (!build) return null;
    const version =
      typeof installed.version === "string" && VERSION_PATTERN.test(installed.version) ? installed.version : null;
    return { version, build };
  } catch {
    return null;
  }
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

/** Reads `pending.json` at startup, whenever the updates folder changes, and every minute. An invalid file is logged and ignored. */
export class LocalUpdateSource {
  readonly #options: LocalUpdateSourceOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #lastReason: string | null = null;
  #watcher: FSWatcher | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LocalUpdateSourceOptions) {
    this.#options = options;
  }

  start(): void {
    this.#schedule(this.#options.initialDelayMs ?? 2_000);
    this.#watchFolder();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  /** A new build shows at once. The folder can be missing or unwatchable: the timer still finds it. */
  #watchFolder(): void {
    try {
      this.#watcher = watch(this.#options.dependencies.paths.updatesDirectory, () => {
        if (this.#debounce) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => {
          void this.checkNow().catch((error: unknown) =>
            logger.warn(`The local update check failed: ${String(error)}`),
          );
        }, 1_000);
        this.#debounce.unref();
      });
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = null;
      });
      this.#watcher.unref();
    } catch {
      this.#watcher = null;
    }
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
        .finally(() => this.#schedule(this.#options.intervalMs ?? 60_000));
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
  // A atualização do fork tem um único destino. Uma cópia de recuperação aberta pelo
  // Dock antigo não pode virar o novo destino, ou cada instalação passa a atualizar
  // uma cópia diferente e /Applications/OpenCat.app fica parado numa versão velha.
  const targetBundlePath = process.platform === "darwin" ? "/Applications/OpenCat.app" : input.bundlePath;
  const child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      script,
      "--commit",
      input.commit,
      "--atual",
      targetBundlePath,
      "--source-bundle",
      input.bundlePath,
      "--wait-pid",
      String(process.pid),
    ],
    { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir() } },
  );
  child.unref();
}
