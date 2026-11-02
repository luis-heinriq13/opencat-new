// node --test tools/cakto/cakto-mcp.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createCaktoTools, redact } from "./cakto-mcp.mjs";

const CLIENT_ID = "ck_test_client_id_12345678";
const CLIENT_SECRET = "cs_test_client_secret_87654321";

function fakeFetch(replies = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, init });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.pathname === "/public_api/token/") {
      return reply(200, { access_token: "mock_jwt_token_for_cakto", expires_in: 3600 });
    }
    const handler = replies[u.pathname];
    if (handler) return reply(200, typeof handler === "function" ? handler(u) : handler);
    return reply(404, { error: `Not found: ${u.pathname}` });
  };
  fn.calls = calls;
  return fn;
}

test("redact: remove client_id, client_secret e tokens Bearer", () => {
  const secret = "segredoSuperSecreto123";
  const text = `Erro ao chamar com ${secret} e Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz`;
  const clean = redact(text, [secret]);
  assert.ok(!clean.includes(secret));
  assert.ok(!clean.includes("eyJhbGciOiJIUzI1Ni"));
  assert.ok(clean.includes("[removido]"));
});

test("createCaktoTools: falha graciosa sem credenciais", async () => {
  const tools = createCaktoTools({ env: {} });
  assert.equal(tools.hasCredentials, false);
  const result = await tools.callTool("cakto_listar_pedidos");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ainda não está conectada/);
});

test("createCaktoTools: lista somente leitura e recusa ferramentas de escrita", async () => {
  const tools = createCaktoTools({
    env: { CAKTO_CLIENT_ID: CLIENT_ID, CAKTO_CLIENT_SECRET: CLIENT_SECRET },
  });
  const list = tools.toolList();
  assert.deepEqual(list, [
    "cakto_listar_produtos",
    "cakto_listar_ofertas",
    "cakto_listar_pedidos",
    "cakto_listar_assinaturas",
  ]);
  const writeAttempt = await tools.callTool("cakto_criar_cobranca");
  assert.equal(writeAttempt.isError, true);
  assert.match(writeAttempt.content[0].text, /somente leitura/);
});

test("createCaktoTools: consulta pedidos e produtos com token Bearer", async () => {
  const fetchMock = fakeFetch({
    "/public_api/orders/": { results: [{ id: "ord_1", status: "paid", amount: 150.0 }] },
    "/public_api/products/": { results: [{ id: "prd_1", name: "Curso Online" }] },
  });
  const tools = createCaktoTools({
    fetch: fetchMock,
    env: { CAKTO_CLIENT_ID: CLIENT_ID, CAKTO_CLIENT_SECRET: CLIENT_SECRET },
  });
  const orders = await tools.callTool("cakto_listar_pedidos", { limite: 10 });
  assert.equal(orders.isError, undefined);
  const parsedOrders = JSON.parse(orders.content[0].text);
  assert.equal(parsedOrders.results[0].id, "ord_1");
  assert.equal(fetchMock.calls[0].path, "/public_api/token/");
  assert.equal(fetchMock.calls[1].path, "/public_api/orders/");
});
