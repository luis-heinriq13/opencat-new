#!/usr/bin/env node
// WhatsCat: WhatsApp por QR code para os agentes do OpenCat, por um motor local não oficial.
// Este processo liga o motor, repassa as ferramentas e aplica os limites de envio.
// `--panel` abre só o painel local: QR code, conversas liberadas e permissão de envio.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createSendLimiter, serveMcp, toolText } from "./mcp-stdio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = process.env.WHATSCAT_SERVICE_BIN || join(here, "bin", "localwhatsappmcp");
const ENGINE = process.env.WHATSCAT_ENGINE_BIN || join(here, "bin", "wacli");
const DATA_DIR = process.env.WHATSCAT_DATA_DIR || join(homedir(), "Library", "Application Support", "OpenCat-WhatsCat");
const LISTEN = process.env.WHATSCAT_LISTEN || "127.0.0.1:32197";
const CONNECTION_FILE = join(DATA_DIR, "opencat-conexao.json");
const CONNECTION_NAME = "OpenCat";

/** Conservador de propósito: reduz o risco, mas nenhum limite garante que a conta não seja banida. */
const limiter = createSendLimiter({
  file: join(DATA_DIR, "opencat-limites.json"),
  minGapMs: 20_000,
  jitterMs: 20_000,
  perHour: 30,
  perDay: 150,
});

let child = null;

function control(method, path, body) {
  return new Promise((resolve, reject) => {
    const process_ = execFile(
      SERVICE,
      ["control", "--data-dir", DATA_DIR, "--method", method, "--path", path],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const text = stdout?.trim() ?? "";
        let value = null;
        try {
          value = text ? JSON.parse(text) : null;
        } catch {
          // A resposta que não é JSON cai no erro abaixo.
        }
        if (value?.error) reject(new Error(String(value.error)));
        else if (error) reject(new Error("O motor do WhatsCat não respondeu."));
        else resolve(value);
      },
    );
    process_.stdin?.end(body === undefined ? "" : JSON.stringify(body));
  });
}

async function ensureService() {
  try {
    return await control("GET", "/state");
  } catch {
    // Não está de pé: este processo o inicia logo abaixo.
  }
  if (!existsSync(SERVICE) || !existsSync(ENGINE)) throw new Error("O motor do WhatsCat não está instalado neste computador.");
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!child || child.exitCode !== null) {
    child = spawn(SERVICE, ["serve", "--owner-stdin", "--data-dir", DATA_DIR, "--wacli", ENGINE, "--listen", LISTEN], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {
      child = null;
    });
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      return await control("GET", "/state");
    } catch {
      // O motor ainda está subindo.
    }
  }
  throw new Error("O motor do WhatsCat não iniciou.");
}

/** A conexão dos agentes, criada uma vez. O envio começa desligado e só o painel o liga. */
let cachedConnection = null;

async function connection() {
  await ensureService();
  if (cachedConnection) return cachedConnection;
  try {
    const saved = JSON.parse(readFileSync(CONNECTION_FILE, "utf8"));
    if (typeof saved.id === "string") {
      const credentials = await control("GET", `/agents/${encodeURIComponent(saved.id)}/credentials`);
      if (credentials?.access_token) {
        cachedConnection = { id: saved.id, url: credentials.url, token: credentials.access_token };
        return cachedConnection;
      }
    }
  } catch {
    // Sem conexão salva, ou ela foi removida: cria outra.
  }
  const created = await control("POST", "/agents/manual", { name: CONNECTION_NAME });
  writeFileSync(CONNECTION_FILE, JSON.stringify({ id: created.id }), { mode: 0o600 });
  cachedConnection = { id: created.id, url: created.url, token: created.access_token };
  return cachedConnection;
}

let session = null;
let rpcId = 0;

async function remote(method, params, retried = false) {
  const { url, token } = await connection();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (!session && method !== "initialize") {
    const started = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencat-whatscat", version: "1.0.0" } },
      }),
    });
    session = started.headers.get("mcp-session-id");
    await started.text();
    await fetch(url, {
      method: "POST",
      headers: { ...headers, ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if ((response.status === 404 || response.status === 400) && !retried) {
    session = null;
    return remote(method, params, true);
  }
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1)
    : text;
  const parsed = JSON.parse(payload || "{}");
  if (parsed.error) throw new Error(parsed.error.message ?? "O motor recusou o pedido.");
  return parsed.result;
}

/** As ferramentas do motor que mandam algo ao WhatsApp. Todas passam pelos limites. */
export function isSendTool(name) {
  return /send|reply|forward|react/i.test(String(name));
}

const STATUS_TOOL = {
  name: "whatscat_status",
  description: "Mostra se o WhatsApp está conectado, se o envio está liberado e quanto dos limites já foi usado.",
  inputSchema: { type: "object", properties: {} },
};

function publicState(state) {
  const whatsapp = state?.whatsapp ?? {};
  return {
    conectado: Boolean(whatsapp.linked),
    situacao: whatsapp.status ?? "desconhecida",
    conversasEscolhidas: state?.scope?.mode !== "initial",
    limites: limiter.usage(),
    ...(whatsapp.linked && state?.scope?.mode !== "initial"
      ? {}
      : { proximoPasso: "Abra o painel do WhatsCat na loja do OpenCat para ler o QR code e escolher as conversas." }),
  };
}

async function callTool(name, args) {
  if (name === STATUS_TOOL.name) return toolText(JSON.stringify(publicState(await ensureService())));
  if (!isSendTool(name)) return remote("tools/call", { name, arguments: args });
  const wait = limiter.check();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const result = await remote("tools/call", { name, arguments: args });
  if (!result?.isError) limiter.record();
  return result;
}

const PANEL_HTML = readFileSync(join(here, "whatscat-panel.html"), "utf8");

async function startPanel() {
  const secret = randomBytes(24).toString("hex");
  const readBody = (request) =>
    new Promise((resolve, reject) => {
      let text = "";
      request.on("data", (chunk) => {
        text += chunk;
        if (text.length > 1_000_000) reject(new Error("Pedido grande demais."));
      });
      request.on("end", () => resolve(text ? JSON.parse(text) : {}));
      request.on("error", reject);
    });
  const reply = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const host = request.headers.host ?? "";
    // Só este computador, e só quem recebeu o endereço com o segredo.
    if (!host.startsWith("127.0.0.1:") || !url.pathname.startsWith(`/${secret}`)) return reply(response, 403, { error: "Sem acesso." });
    const path = url.pathname.slice(secret.length + 1) || "/";
    try {
      if (request.method === "GET" && path === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
        });
        return response.end(PANEL_HTML);
      }
      if (request.method === "GET" && path === "/estado") {
        const fresh = await ensureService();
        const whatsapp = fresh?.whatsapp ?? {};
        const qr = whatsapp.qr ? await QRCode.toString(whatsapp.qr, { type: "svg", margin: 1 }) : null;
        // Antes de escolher as conversas o motor não aceita conexão de agente.
        const id = fresh?.scope?.mode === "initial" ? null : (await connection()).id;
        const grant = (fresh?.agents ?? []).find((item) => item.id === id);
        return reply(response, 200, {
          conectado: Boolean(whatsapp.linked),
          situacao: whatsapp.status ?? "desconhecida",
          detalhe: whatsapp.detail ?? "",
          qr,
          escopo: fresh?.scope?.mode ?? "initial",
          envio: Boolean(grant?.send_enabled),
          limites: limiter.usage(),
        });
      }
      if (request.method === "GET" && path === "/conversas") return reply(response, 200, await control("GET", "/catalog"));
      if (request.method !== "POST") return reply(response, 404, { error: "Não encontrado." });
      const body = await readBody(request);
      if (path === "/conectar") return reply(response, 200, await control("POST", "/whatsapp/connect", {}));
      if (path === "/desconectar") return reply(response, 200, await control("POST", "/whatsapp/disconnect", {}));
      if (path === "/escopo-todas") return reply(response, 200, await control("PUT", "/scope", { mode: "all", chat_ids: [] }));
      if (path === "/escopo-escolhidas") {
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
        if (!ids.length) return reply(response, 400, { error: "Escolha ao menos uma conversa." });
        return reply(response, 200, await control("PUT", "/scope", { mode: "selected", chat_ids: ids }));
      }
      if (path === "/envio") {
        const { id } = await connection();
        return reply(response, 200, await control("PATCH", `/agents/${encodeURIComponent(id)}`, { send_enabled: body.ligado === true }));
      }
      return reply(response, 404, { error: "Não encontrado." });
    } catch (error) {
      return reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.stdout.write(`PANEL_URL=http://127.0.0.1:${server.address().port}/${secret}/\n`);
}

if (process.argv.includes("--panel")) {
  await ensureService();
  await startPanel();
  // O painel termina com o processo que o abriu.
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else {
  serveMcp({
    name: "whatscat",
    version: "1.0.0",
    listTools: async () => {
      const state = await ensureService();
      // Sem WhatsApp conectado e conversas escolhidas, só o status existe: ele indica o painel.
      if (state?.scope?.mode === "initial") return [STATUS_TOOL];
      const tools = (await remote("tools/list", {})).tools ?? [];
      return [STATUS_TOOL, ...tools];
    },
    callTool,
  }).on("close", () => process.exit(0));
}
