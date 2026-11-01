#!/usr/bin/env node
// WhatsApp (não oficial): WhatsApp por QR code para os agentes do OpenCat, por um motor local não oficial.
// Este processo liga o motor, repassa as ferramentas e aplica os limites de envio.
// `--panel` abre só o painel local: QR code, conversas liberadas e permissão de envio.
// `--bridge` roda só a ponte, sem janela: o aplicativo a inicia enquanto está aberto e ela lê os mesmos arquivos.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createSendLimiter, serveMcp, toolText } from "./mcp-stdio.mjs";
import {
  acquireBridgeLock,
  bridgeRunning,
  chatDisplayName,
  createAgentApi,
  createBridge,
  createDispatcher,
  createEngineReader,
  formatChatId,
  isGroupChat,
  loadBridgeConfig,
  readBridgeSettings,
  releaseBridgeLock,
  saveBridgeSettings,
  shortHash,
  writeBridgeHeartbeat,
} from "./whatscat-bridge.mjs";

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
        else if (error) reject(new Error("O motor do WhatsApp (não oficial) não respondeu."));
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
  if (!existsSync(SERVICE) || !existsSync(ENGINE))
    throw new Error("O motor do WhatsApp (não oficial) não está instalado neste computador.");
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
  throw new Error("O motor do WhatsApp (não oficial) não iniciou.");
}

/** A conexão dos agentes, criada uma vez. O envio começa desligado e só o painel o liga. */
let cachedConnection = null;

async function connection() {
  await ensureService();
  if (cachedConnection) return cachedConnection;
  // O painel e os agentes são processos separados e precisam da mesma conexão: o envio é por conexão.
  const lock = `${CONNECTION_FILE}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (attempt >= 40) rmSync(lock, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await savedOrNewConnection();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function savedOrNewConnection() {
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
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "opencat-whatscat", version: "1.0.0" },
        },
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
      : {
          proximoPasso:
            "Abra o painel do WhatsApp (não oficial) na loja do OpenCat para ler o QR code e escolher as conversas.",
        }),
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

const BRIDGE_CONFIG_FILE = join(DATA_DIR, "opencat-ponte.json");
/** Código de saída de quem encontra outra ponte viva: o aplicativo espera antes de tentar de novo. */
const EXIT_ALREADY_RUNNING = 75;

/** As dependências da ponte. O painel só as usa para aprovar um rascunho; o processo da ponte, para tudo. */
function bridgeDeps(config) {
  const callEngine = (name, args) => remote("tools/call", { name, arguments: args });
  return {
    readMessages: createEngineReader(callEngine),
    listChats: async () =>
      ((await control("GET", "/catalog"))?.chats ?? []).map((chat) => chat.id).filter((id) => typeof id === "string"),
    ...createAgentApi(),
    send: createDispatcher({ limiter, callEngine, sendTool: config.sendTool }),
  };
}

/** A ponte da configuração de agora, ou null se ela estiver desligada. Lida de novo a cada pedido. */
function currentBridge() {
  const config = loadBridgeConfig(BRIDGE_CONFIG_FILE);
  return config.enabled ? createBridge({ config, dir: DATA_DIR, deps: bridgeDeps(config) }) : null;
}

/** No modo "todos", contato novo precisa estar no escopo do motor para a ponte lê-lo. Só soma, nunca tira. */
async function extendScope(state, config) {
  const scope = state?.scope;
  if (config.mode !== "all" || scope?.mode !== "selected" || !Array.isArray(scope.chat_ids)) return;
  const listed = (await control("GET", "/catalog"))?.chats ?? [];
  const missing = listed
    .map((chat) => chat.id)
    .filter(
      (id) =>
        typeof id === "string" &&
        !isGroupChat(id) &&
        /@(s\.whatsapp\.net|lid)$/.test(id) &&
        !config.excludes.includes(id) &&
        !scope.chat_ids.includes(id),
    );
  if (missing.length) await control("PUT", "/scope", { mode: "selected", chat_ids: [...scope.chat_ids, ...missing] });
}

/** `--bridge`: a ponte sem janela. Uma por pasta de dados; fecha quando o aplicativo que a iniciou fecha. */
async function runBridgeProcess() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!acquireBridgeLock(DATA_DIR)) process.exit(EXIT_ALREADY_RUNNING);
  const leave = () => releaseBridgeLock(DATA_DIR);
  process.on("exit", leave);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
  // O aplicativo fecha esta entrada ao sair, e então a ponte também sai.
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  const beat = () => {
    try {
      writeBridgeHeartbeat(DATA_DIR);
    } catch {
      // Sem o coração o painel só mostra "parada"; a ponte segue.
    }
  };
  beat();
  setInterval(beat, 10_000);
  let lastRun = 0;
  let busy = false;
  const tick = async () => {
    // Ponte desligada continua desligada: sem "enabled": true nada é lido nem entregue.
    const config = loadBridgeConfig(BRIDGE_CONFIG_FILE);
    if (busy || !config.enabled || Date.now() - lastRun < config.pollSeconds * 1000) return;
    busy = true;
    lastRun = Date.now();
    try {
      const state = await ensureService();
      await extendScope(state, config).catch(() => undefined);
      await createBridge({ config, dir: DATA_DIR, deps: bridgeDeps(config) }).poll();
    } catch {
      // Falhas de leitura já ficam no registro de auditoria da ponte.
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 2000);
  void tick();
}

const PANEL_HTML = readFileSync(join(here, "whatscat-panel.html"), "utf8");

const isGroupId = isGroupChat;

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
    if (!host.startsWith("127.0.0.1:") || !url.pathname.startsWith(`/${secret}`))
      return reply(response, 403, { error: "Sem acesso." });
    const path = url.pathname.slice(secret.length + 1) || "/";
    try {
      if (request.method === "GET" && path === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
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
      if (request.method === "GET" && path === "/conversas") {
        const catalog = await control("GET", "/catalog");
        return reply(response, 200, {
          chats: (catalog?.chats ?? [])
            .filter((chat) => typeof chat?.id === "string")
            .map((chat) => ({ id: chat.id, grupo: isGroupId(chat.id), ...chatDisplayName(chat) })),
        });
      }
      if (request.method === "GET" && path === "/ponte") {
        const settings = readBridgeSettings(BRIDGE_CONFIG_FILE);
        const bridge = currentBridge();
        const chats = new Map(
          ((await control("GET", "/catalog").catch(() => null))?.chats ?? []).map((chat) => [chat.id, chat]),
        );
        return reply(response, 200, {
          ativa: Boolean(bridge),
          configurada: settings.configurada,
          rodando: bridgeRunning(DATA_DIR),
          modo: settings.mode,
          escolhidas: settings.chats,
          grupos: settings.groups,
          excluidos: settings.excludes,
          rascunhos: (bridge?.drafts() ?? []).map((draft) => ({
            id: draft.id,
            status: draft.status,
            texto: draft.text,
            conversa: chats.has(draft.chatId)
              ? chatDisplayName(chats.get(draft.chatId)).nome
              : (formatChatId(draft.chatId) ?? `conversa ${shortHash(draft.chatId)}`),
            criadoEm: draft.createdAt,
          })),
        });
      }
      if (request.method !== "POST") return reply(response, 404, { error: "Não encontrado." });
      const body = await readBody(request);
      if (path === "/ponte/aprovar" || path === "/ponte/descartar") {
        const bridge = currentBridge();
        if (!bridge || typeof body.id !== "string") return reply(response, 400, { error: "A ponte está desligada." });
        // Aprovar é o único caminho de envio da ponte, e passa pelos limites.
        const done = path === "/ponte/aprovar" ? await bridge.approve(body.id) : bridge.discard(body.id);
        return reply(response, 200, { status: done.status });
      }
      if (path === "/ponte/atendimento") {
        // Só o modo e as listas. Ligar a ponte continua sendo uma edição de "enabled" em opencat-ponte.json.
        if (body.modo !== "all" && body.modo !== "selected") return reply(response, 400, { error: "Modo inválido." });
        const saved = saveBridgeSettings(BRIDGE_CONFIG_FILE, {
          mode: body.modo,
          chats: body.escolhidas,
          groups: body.grupos,
          excludes: body.excluidos,
        });
        return reply(response, 200, { modo: saved.mode });
      }
      if (path === "/conectar") return reply(response, 200, await control("POST", "/whatsapp/connect", {}));
      if (path === "/desconectar") return reply(response, 200, await control("POST", "/whatsapp/disconnect", {}));
      if (path === "/escopo-todas") {
        // Por padrão "todas" não inclui grupos: o modo "all" do motor os incluiria, então lista as conversas.
        if (body.incluirGrupos === true)
          return reply(response, 200, await control("PUT", "/scope", { mode: "all", chat_ids: [] }));
        const ids = ((await control("GET", "/catalog"))?.chats ?? [])
          .map((chat) => chat.id)
          .filter((id) => typeof id === "string" && !isGroupId(id));
        if (!ids.length)
          return reply(response, 400, {
            error: "Nenhuma conversa individual apareceu ainda. Aguarde a sincronização.",
          });
        return reply(response, 200, await control("PUT", "/scope", { mode: "selected", chat_ids: ids }));
      }
      if (path === "/escopo-escolhidas") {
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
        if (!ids.length) return reply(response, 400, { error: "Escolha ao menos uma conversa." });
        return reply(response, 200, await control("PUT", "/scope", { mode: "selected", chat_ids: ids }));
      }
      if (path === "/envio") {
        const { id } = await connection();
        return reply(
          response,
          200,
          await control("PATCH", `/agents/${encodeURIComponent(id)}`, { send_enabled: body.ligado === true }),
        );
      }
      return reply(response, 404, { error: "Não encontrado." });
    } catch (error) {
      return reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.stdout.write(`PANEL_URL=http://127.0.0.1:${server.address().port}/${secret}/\n`);
}

if (process.argv.includes("--bridge")) {
  await runBridgeProcess();
} else if (process.argv.includes("--panel")) {
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
