// OpenCat: the WhatsApp servers that ship with the app. A store listing names a command in the home
// folder, because a listing cannot know where the app is installed, so startup copies them there.
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { isPanelCloseUrl, isPanelUrlAllowed } from "./whatscat-panel-navigation";

/** The address the store's panel button asks for. `openUrl` opens the panel instead of a browser. */
export const WHATSCAT_PANEL_URL = "https://opencat.invalid/whatscat-panel";

const INSTALL_DIRECTORY = join(homedir(), ".opencat", "whatscat");
/** The scripts whose content decides whether the installed copy is current. */
const BUNDLE_FILES = ["whatscat-mcp.mjs", "whatsapp-oficial-mcp.mjs", "whatscat-panel.html"];
const PANEL_START_TIMEOUT_MS = 30_000;
/** Same folder the scripts use: WHATSCAT_DATA_DIR, or the default under Application Support. */
const DATA_DIRECTORY =
  process.env.WHATSCAT_DATA_DIR || join(homedir(), "Library", "Application Support", "OpenCat-WhatsCat");
const BRIDGE_CHECK_MS = 30_000;
const BRIDGE_RESTART_MIN_MS = 2_000;
const BRIDGE_RESTART_MAX_MS = 60_000;
const BRIDGE_HEALTHY_MS = 60_000;

export async function installBundledApps(): Promise<void> {
  const source = join(process.resourcesPath, "whatscat");
  if (!app.isPackaged || !existsSync(source)) return;
  const stamp = join(INSTALL_DIRECTORY, ".versao");
  // A hash of the files, not a number to remember: a build with a changed script always refreshes the copy.
  const hash = createHash("sha256");
  for (const file of BUNDLE_FILES) hash.update(await readFile(join(source, file)));
  const wanted = `${app.getVersion()}+${hash.digest("hex")}`;
  const installed = await readFile(stamp, "utf8").catch(() => null);
  if (installed === wanted && existsSync(join(INSTALL_DIRECTORY, "whatscat-mcp.mjs"))) return;
  await mkdir(INSTALL_DIRECTORY, { recursive: true, mode: 0o700 });
  await cp(source, INSTALL_DIRECTORY, { recursive: true, force: true });
  await Promise.all(
    ["whatscat-mcp.mjs", "whatsapp-oficial-mcp.mjs", "bin/localwhatsappmcp", "bin/wacli"].map((file) =>
      chmod(join(INSTALL_DIRECTORY, file), 0o755).catch(() => undefined),
    ),
  );
  await writeFile(stamp, wanted);
}

let panelWindow: BrowserWindow | null = null;
let panelOpening: Promise<void> | null = null;

/**
 * The scripts run under plain Node. For voice notes, the bridge starts the app's own speech recognition host
 * (an unpacked file of the app) against the runtime it ships, so it needs to know where they are.
 */
function voiceEnvironment(): NodeJS.ProcessEnv {
  if (!app.isPackaged) return {};
  const host = join(process.resourcesPath, "app.asar.unpacked", "out", "main", "voice-transcription-host.js");
  const runtime = join(process.resourcesPath, "voice", "runtime");
  return existsSync(host) && existsSync(runtime) ? { OPENCAT_VOICE_HOST: host, OPENCAT_VOICE_RUNTIME: runtime } : {};
}

function scriptEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, ...voiceEnvironment(), PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
}

function startPanel(): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(INSTALL_DIRECTORY, "whatscat-mcp.mjs"), "--panel"], {
      env: scriptEnvironment(),
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("O painel do WhatsApp (não oficial) não abriu a tempo."));
    }, PANEL_START_TIMEOUT_MS);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/PANEL_URL=(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve({ url: match[1], child });
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("O painel do WhatsApp (não oficial) fechou ao iniciar. Confira se o Node.js está instalado."));
    });
  });
}

/** Whether the user turned the bridge on in opencat-ponte.json. Any doubt means off. */
function bridgeEnabled(): boolean {
  try {
    const config = JSON.parse(readFileSync(join(DATA_DIRECTORY, "opencat-ponte.json"), "utf8"));
    return config?.enabled === true && typeof config.agentId === "string" && config.agentId.length > 0;
  } catch {
    return false;
  }
}

let bridgeChild: ChildProcess | null = null;
let bridgeTimer: ReturnType<typeof setInterval> | null = null;
let bridgeRestart: ReturnType<typeof setTimeout> | null = null;
let bridgeFailures = 0;
let bridgeStopping = false;

function launchBridge(): void {
  const script = join(INSTALL_DIRECTORY, "whatscat-mcp.mjs");
  if (bridgeStopping || bridgeChild || bridgeRestart || !existsSync(script)) return;
  const startedAt = Date.now();
  // The child has no window. Its stdin is the lifeline: it exits when this process closes the pipe.
  const child = spawn("node", [script, "--bridge"], { env: scriptEnvironment(), stdio: ["pipe", "ignore", "ignore"] });
  bridgeChild = child;
  const ended = () => {
    if (bridgeChild !== child) return;
    bridgeChild = null;
    if (bridgeStopping || !bridgeEnabled()) return;
    bridgeFailures = Date.now() - startedAt > BRIDGE_HEALTHY_MS ? 0 : bridgeFailures + 1;
    const wait = Math.min(BRIDGE_RESTART_MAX_MS, BRIDGE_RESTART_MIN_MS * 2 ** Math.min(bridgeFailures, 6));
    bridgeRestart = setTimeout(() => {
      bridgeRestart = null;
      if (bridgeEnabled()) launchBridge();
    }, wait);
  };
  child.on("error", ended);
  child.on("exit", ended);
}

function checkBridge(): void {
  if (bridgeStopping) return;
  if (bridgeEnabled()) launchBridge();
  else stopBridgeProcess();
}

function stopBridgeProcess(): void {
  if (bridgeRestart) clearTimeout(bridgeRestart);
  bridgeRestart = null;
  const child = bridgeChild;
  bridgeChild = null;
  child?.stdin?.end();
  child?.kill();
}

/**
 * Runs the WhatsApp bridge while the app is open, only when opencat-ponte.json has `enabled: true`.
 * One child process at a time, no window, restarted with a growing wait if it crashes, stopped when
 * the app quits or the file turns the bridge off. Safe to call again.
 */
export function startWhatsCatBridgeSupervisor(): void {
  if (bridgeTimer) return;
  bridgeStopping = false;
  checkBridge();
  bridgeTimer = setInterval(checkBridge, BRIDGE_CHECK_MS);
  app.once("before-quit", () => {
    bridgeStopping = true;
    if (bridgeTimer) clearInterval(bridgeTimer);
    bridgeTimer = null;
    stopBridgeProcess();
  });
}

/** Opens the panel as a modal of `parent`, or alone when there is no window to hold it. One panel at a time. */
export function openWhatsCatPanel(parent: BrowserWindow | null): Promise<void> {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isMinimized()) panelWindow.restore();
    panelWindow.show();
    panelWindow.focus();
    return Promise.resolve();
  }
  panelOpening ??= createPanel(parent).finally(() => {
    panelOpening = null;
  });
  return panelOpening;
}

async function createPanel(parent: BrowserWindow | null): Promise<void> {
  const { url, child } = await startPanel();
  const holder = parent && !parent.isDestroyed() ? parent : undefined;
  const window = new BrowserWindow({
    width: 680,
    height: 820,
    minWidth: 480,
    minHeight: 520,
    title: "WhatsApp (não oficial)",
    show: false,
    ...(holder ? { parent: holder, modal: true } : {}),
    minimizable: !holder,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  panelWindow = window;
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://")) void shell.openExternal(target);
    return { action: "deny" };
  });
  const block = (event: { preventDefault: () => void }, target: string) => {
    if (isPanelCloseUrl(url, target)) {
      event.preventDefault();
      if (!window.isDestroyed()) window.close();
      return;
    }
    if (!isPanelUrlAllowed(url, target)) event.preventDefault();
  };
  window.webContents.on("will-navigate", block);
  window.webContents.on("will-redirect", block);
  // The modal has no title bar: Escape closes it even when the page does not answer.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      if (!window.isDestroyed()) window.close();
    }
  });
  window.on("closed", () => {
    panelWindow = null;
    child.kill();
  });
  try {
    await window.loadURL(url);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}
