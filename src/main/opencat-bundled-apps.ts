// OpenCat: the WhatsApp servers that ship with the app. A store listing names a command in the home
// folder, because a listing cannot know where the app is installed, so startup copies them there.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";

/** The address the store's panel button asks for. `openUrl` opens the panel instead of a browser. */
export const WHATSCAT_PANEL_URL = "https://opencat.invalid/whatscat-panel";

const INSTALL_DIRECTORY = join(homedir(), ".opencat", "whatscat");
const PANEL_START_TIMEOUT_MS = 30_000;

export async function installBundledApps(): Promise<void> {
  const source = join(process.resourcesPath, "whatscat");
  if (!app.isPackaged || !existsSync(source)) return;
  const stamp = join(INSTALL_DIRECTORY, ".versao");
  const installed = await readFile(stamp, "utf8").catch(() => null);
  if (installed === app.getVersion() && existsSync(join(INSTALL_DIRECTORY, "whatscat-mcp.mjs"))) return;
  await mkdir(INSTALL_DIRECTORY, { recursive: true, mode: 0o700 });
  await cp(source, INSTALL_DIRECTORY, { recursive: true, force: true });
  await Promise.all(
    ["whatscat-mcp.mjs", "whatsapp-oficial-mcp.mjs", "bin/localwhatsappmcp", "bin/wacli"].map((file) =>
      chmod(join(INSTALL_DIRECTORY, file), 0o755).catch(() => undefined),
    ),
  );
  await writeFile(stamp, app.getVersion());
}

let panelWindow: BrowserWindow | null = null;

function startPanel(): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(INSTALL_DIRECTORY, "whatscat-mcp.mjs"), "--panel"], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("O painel do WhatsCat não abriu a tempo."));
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
      reject(new Error("O painel do WhatsCat fechou ao iniciar. Confira se o Node.js está instalado."));
    });
  });
}

/** A window of this app, with no access to the app's own bridge. It closes with the panel process. */
export async function openWhatsCatPanel(): Promise<void> {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.focus();
    return;
  }
  const { url, child } = await startPanel();
  const window = new BrowserWindow({
    width: 560,
    height: 760,
    title: "WhatsCat",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  panelWindow = window;
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://")) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });
  window.on("closed", () => {
    panelWindow = null;
    child.kill();
  });
  await window.loadURL(url);
}
