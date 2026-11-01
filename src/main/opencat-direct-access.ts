// OpenCat: reaches this computer's Team API with no account service. A direct invitation needs an
// address that another computer can reach, and the Team API listens on the loopback interface only,
// because it trusts what comes from there. So a member never reaches it directly: a small gateway
// lets through only the member routes, and a tunnel, or an address the owner configures, reaches the
// gateway. Nothing listens or leaves this computer until the first direct invitation.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";

/** The release that the app downloads when `cloudflared` is not on this computer. Notarized by Cloudflare. */
const CLOUDFLARED_VERSION = "2026.10.7";
const CLOUDFLARED_DARWIN_ARM64_SHA256 = "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd";
const CLOUDFLARED_DARWIN_ARM64_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`;

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/u;
const TUNNEL_START_TIMEOUT_MS = 45_000;
const TUNNEL_WATCH_MS = 30_000;
const DEFAULT_GATEWAY_PORT = 47823;
const TUNNEL_REACHABLE_TIMEOUT_MS = 40_000;
const MAX_HEADER_BYTES = 64 * 1024;

/** The routes that hand this computer's screen or browser to the caller. A joined member needs none of them. */
const DIRECT_ACCESS_BLOCKED = [
  "/v1/remote-screen",
  "/v1/remote-desktop",
  "/v1/browser",
  "/v1/browser-view",
  "/v1/browser-takeovers",
];

/**
 * Whether a request may pass the gateway. Everything else on the Team API either belongs to this
 * computer or to a WebRTC session that this host opened: the remote screen and the browser view
 * decide by the session in their path, so they do not open to the internet.
 */
export function directAccessAllows(pathname: string): boolean {
  if (!pathname.startsWith("/v1/")) return false;
  if (DIRECT_ACCESS_BLOCKED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false;
  return !pathname.split("/").some((part) => part === ".." || part === "." || /%2e|%2f|%5c/iu.test(part));
}

/** The headers that only this host's own WebRTC peer may set, and the hop-by-hop ones. */
function forwardedHeaders(request: IncomingMessage, apiPort: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith("x-openbot-webrtc") || lower.startsWith("x-forwarded-") || lower === "forwarded") continue;
    headers[lower] = value;
  }
  headers.host = `127.0.0.1:${apiPort}`;
  return headers;
}

/** A valid and unique member name from what the person typed. A second join never takes the first one's name. */
export function directMemberUsername(displayName: string | undefined, suffix = randomBytes(2).toString("hex")): string {
  const base = (displayName ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "")
    .slice(0, 24)
    .replace(/[^a-z0-9]+$/u, "");
  return `${base.length >= 2 ? base : "membro"}-${suffix}`;
}

export function isDirectAccessPublicUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "" && !url.username;
  } catch {
    return false;
  }
}

/** The gateway in front of the Team API. Returns its loopback port. */
export function startDirectAccessGateway(
  apiPort: () => number | null,
  preferredPort = 0,
): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const target = apiPort();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (target === null || !directAccessAllows(pathname)) {
      response.writeHead(target === null ? 503 : 404).end();
      return;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: target,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request, target),
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.maxHeadersCount = 100;
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = apiPort();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (target === null || pathname !== TEAM_API_ROUTES.events) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream: Socket = connect(target, "127.0.0.1", () => {
      const headers = forwardedHeaders(request, target);
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
      );
      const head0 = `${request.method} ${request.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
      if (Buffer.byteLength(head0) > MAX_HEADER_BYTES) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      upstream.write(head0);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The direct access gateway has no port."));
        return;
      }
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

function configDirectory(): string {
  return join(homedir(), ".opencat");
}

/** `{ "publicUrl": "https://…", "gatewayPort": 47823 }` for an address that stays the same across restarts. */
async function readConfig(): Promise<{ publicUrl: string | null; gatewayPort: number }> {
  const text = await readFile(join(configDirectory(), "direct-access.json"), "utf8").catch(() => null);
  if (text === null) return { publicUrl: null, gatewayPort: 0 };
  try {
    const value: { publicUrl?: unknown; gatewayPort?: unknown } = JSON.parse(text);
    const port = value.gatewayPort;
    return {
      publicUrl: isDirectAccessPublicUrl(value.publicUrl) ? new URL(value.publicUrl).origin : null,
      gatewayPort: typeof port === "number" && Number.isInteger(port) && port > 1023 && port < 65536 ? port : 0,
    };
  } catch {
    return { publicUrl: null, gatewayPort: 0 };
  }
}

async function installCloudflared(): Promise<string> {
  const candidates = [
    join(configDirectory(), "bin", "cloudflared"),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Install cloudflared on this computer, or set publicUrl in ~/.opencat/direct-access.json.");
  const response = await fetch(CLOUDFLARED_DARWIN_ARM64_URL);
  if (!response.ok) throw new Error(`The tunnel program could not be downloaded (${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== CLOUDFLARED_DARWIN_ARM64_SHA256)
    throw new Error("The downloaded tunnel program failed its checksum.");
  const work = await mkdtemp(join(tmpdir(), "opencat-cloudflared-"));
  try {
    const path = join(work, "cloudflared.tgz");
    await writeFile(path, archive);
    await new Promise<void>((resolve, reject) =>
      execFile("/usr/bin/tar", ["-xzf", path, "-C", work, "cloudflared"], (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const directory = join(configDirectory(), "bin");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, "cloudflared");
    await chmod(join(work, "cloudflared"), 0o755);
    await rename(join(work, "cloudflared"), target).catch(async () => {
      await writeFile(target, await readFile(join(work, "cloudflared")), { mode: 0o755 });
    });
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * A new tunnel's name takes a few seconds to reach the DNS. A link that goes out before that fails
 * for the person who opens it. It still goes out after the wait: this computer's DNS can lag others.
 */
async function waitUntilReachable(address: string): Promise<void> {
  const deadline = Date.now() + TUNNEL_REACHABLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const answer = await fetch(`${address}${TEAM_API_ROUTES.compatibility}`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (answer?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function isCloudflaredRunning(pid: number): Promise<boolean> {
  return new Promise((resolve) =>
    execFile("/bin/ps", ["-o", "comm=", "-p", String(pid)], (error, stdout) =>
      resolve(!error && stdout.includes("cloudflared")),
    ),
  );
}

async function readTunnelState(): Promise<TunnelState | null> {
  const text = await readFile(tunnelStatePath(), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const value: { pid?: unknown; url?: unknown; port?: unknown } = JSON.parse(text);
    return typeof value.pid === "number" && typeof value.port === "number" && isDirectAccessPublicUrl(`${value.url}/`)
      ? { pid: value.pid, url: `${value.url}`, port: value.port }
      : null;
  } catch {
    return null;
  }
}

function tunnelStatePath(): string {
  return join(configDirectory(), "direct-tunnel.json");
}

interface TunnelState {
  pid: number;
  url: string;
  port: number;
}

/**
 * The gateway and the tunnel of this computer's direct invitations. The tunnel runs on its own, so its
 * address survives a restart of OpenCat. While OpenCat is closed the gateway is too, and the tunnel
 * reaches nothing. Only restarting the computer or losing the tunnel changes the address.
 */
export class DirectAccess {
  readonly #apiPort: () => number | null;
  #gateway: { port: number; close: () => void } | null = null;
  #tunnelPid: number | null = null;
  #publicUrl: string | null = null;
  #wanted = false;
  #starting: Promise<string> | null = null;
  #watch: NodeJS.Timeout | null = null;

  constructor(apiPort: () => number | null) {
    this.#apiPort = apiPort;
  }

  /** The address for an invitation. Starts the gateway and the tunnel when they are not running. */
  ensure(): Promise<string> {
    this.#wanted = true;
    if (this.#publicUrl && this.#gateway) return Promise.resolve(this.#publicUrl);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** Nobody needs the direct address any more, so the tunnel ends too. */
  async stop(): Promise<void> {
    this.release();
    const state = await readTunnelState();
    const pid = this.#tunnelPid ?? state?.pid ?? null;
    this.#tunnelPid = null;
    if (pid !== null && (await isCloudflaredRunning(pid))) process.kill(pid);
    await rm(tunnelStatePath(), { force: true });
  }

  /** OpenCat is closing. The tunnel stays, so the members keep the address when it opens again. */
  release(): void {
    this.#wanted = false;
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    this.#gateway?.close();
    this.#gateway = null;
    this.#publicUrl = null;
  }

  async #start(): Promise<string> {
    const config = await readConfig();
    this.#gateway ??= await startDirectAccessGateway(this.#apiPort, config.gatewayPort || DEFAULT_GATEWAY_PORT).catch(
      () => startDirectAccessGateway(this.#apiPort, 0),
    );
    if (config.publicUrl) {
      this.#publicUrl = config.publicUrl;
      return config.publicUrl;
    }
    const address = (await this.#reuseTunnel()) ?? (await this.#startTunnel(await installCloudflared()));
    this.#watchTunnel();
    return address;
  }

  async #reuseTunnel(): Promise<string | null> {
    const state = await readTunnelState();
    if (!state || state.port !== this.#gateway?.port || !(await isCloudflaredRunning(state.pid))) return null;
    this.#tunnelPid = state.pid;
    this.#publicUrl = state.url;
    return state.url;
  }

  async #startTunnel(binary: string): Promise<string> {
    const gateway = this.#gateway;
    if (!gateway) throw new Error("The direct access gateway is not running.");
    const previous = await readTunnelState();
    if (previous && (await isCloudflaredRunning(previous.pid))) process.kill(previous.pid);
    await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
    const logPath = join(configDirectory(), "direct-tunnel.log");
    const log = openSync(logPath, "w", 0o600);
    const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${gateway.port}`], {
      // The tunnel needs none of the secrets in this process's environment.
      env: { HOME: homedir(), PATH: "/usr/bin:/bin" },
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("The tunnel did not start.");
    const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const found = (await readFile(logPath, "utf8").catch(() => "")).match(TUNNEL_URL_PATTERN)?.[0];
      if (found) {
        this.#tunnelPid = pid;
        this.#publicUrl = found;
        const state: TunnelState = { pid, url: found, port: gateway.port };
        await writeFile(tunnelStatePath(), JSON.stringify(state), { mode: 0o600 });
        await waitUntilReachable(found);
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (await isCloudflaredRunning(pid)) process.kill(pid);
    throw new Error("The tunnel did not start in time. Check the internet connection and try again.");
  }

  /** A tunnel that ends gets a new one, with a new address. */
  #watchTunnel(): void {
    if (this.#watch) return;
    this.#watch = setInterval(() => {
      const pid = this.#tunnelPid;
      if (pid === null || !this.#wanted) return;
      void isCloudflaredRunning(pid).then((running) => {
        if (running || !this.#wanted || this.#tunnelPid !== pid) return;
        this.#tunnelPid = null;
        this.#publicUrl = null;
        void this.ensure().catch(() => undefined);
      });
    }, TUNNEL_WATCH_MS);
    this.#watch.unref();
  }
}
