#!/usr/bin/env node
// Cakto: leitura local da API pública. Produção expõe somente quatro consultas; não há ferramenta
// de pagamento, reembolso, cancelamento, criação nem endpoint de escrita neste processo.
import { createInterface } from "node:readline";

const API = "https://api.cakto.com.br";
const TIMEOUT_MS = 25_000;
const READ_PATHS = {
  cakto_listar_produtos: "/public_api/products/",
  cakto_listar_ofertas: "/public_api/offers/",
  cakto_listar_pedidos: "/public_api/orders/",
  cakto_listar_assinaturas: "/public_api/subscriptions/",
};

export function redact(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) if (secret && secret.length >= 8) text = text.split(secret).join("[removido]");
  return text.replace(/Bearer\s+[\w.~+/=-]{12,}/gi, "Bearer [removido]");
}

export function createCaktoTools({ fetch: fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const clientId = String(env.CAKTO_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.CAKTO_CLIENT_SECRET ?? "").trim();
  const clean = (value) => redact(value, [clientId, clientSecret]);
  let token = null;

  async function accessToken() {
    if (!clientId || !clientSecret)
      throw Object.assign(new Error("A Cakto ainda não está conectada."), { kind: "not-connected" });
    if (token && token.expiresAt > now() + 30_000) return token.value;
    const response = await fetchImpl(`${API}/public_api/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body?.access_token !== "string") {
      const kind =
        response.status === 401 || response.status === 403
          ? "permission"
          : response.status === 429
            ? "rate"
            : "unknown";
      throw Object.assign(new Error("A Cakto recusou as credenciais."), { kind });
    }
    token = { value: body.access_token, expiresAt: now() + Math.max(60, Number(body.expires_in) || 300) * 1000 };
    return token.value;
  }

  async function get(path, query = {}) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const kind =
        response.status === 401 || response.status === 403
          ? "permission"
          : response.status === 429
            ? "rate"
            : "unknown";
      throw Object.assign(new Error("A Cakto não respondeu à consulta."), { kind });
    }
    return body;
  }

  async function callTool(name, args = {}) {
    const path = READ_PATHS[name];
    if (!path) return { isError: true, content: [{ type: "text", text: "Esta instalação Cakto é somente leitura." }] };
    try {
      const body = await get(path, {
        limit: Math.min(100, Math.max(1, Number(args.limite) || 50)),
        currency: args.moeda,
      });
      return { content: [{ type: "text", text: clean(JSON.stringify(body)) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: clean(error instanceof Error ? error.message : "Erro ao consultar Cakto.") }],
      };
    }
  }

  return { hasCredentials: Boolean(clientId && clientSecret), get, callTool, toolList: () => Object.keys(READ_PATHS) };
}

function serve() {
  const tools = createCaktoTools();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  input.on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.method === "initialize")
      return send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cakto", version: "1.0.0" },
        },
      });
    if (request.method === "tools/list")
      return send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: tools.toolList().map((name) => ({
            name,
            description: "Consulta somente leitura da Cakto.",
            inputSchema: { type: "object", properties: { limite: { type: "integer" }, moeda: { type: "string" } } },
          })),
        },
      });
    if (request.method === "tools/call")
      return send({
        jsonrpc: "2.0",
        id: request.id,
        result: await tools.callTool(request.params?.name, request.params?.arguments),
      });
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serve();
