// node --test tools/meta-ads/meta-ads-mcp.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createMetaAdsTools, GRAPH_VERSION, redact } from "./meta-ads-mcp.mjs";

const TOKEN = "EAABsbCS1iHgBOfakeTokenForTestsOnly1234567890";

/** Um fetch falso com estado: objetos por id, para ver antes e depois. */
function fakeFetch(objects = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, init });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    const method = init.method ?? "GET";
    const id = u.pathname.split("/")[2];
    if (method === "POST" && u.pathname.endsWith("/campaigns")) return reply(200, { id: "999001" });
    if (method === "POST") {
      const patch = JSON.parse(init.body);
      objects[id] = { ...objects[id], ...patch };
      return reply(200, { success: true });
    }
    if (u.pathname.endsWith("/adsets")) return reply(200, { data: objects.sets ?? [] });
    if (u.pathname.endsWith("/adaccounts"))
      return reply(200, {
        data: [{ id: "act_1001", name: "Loja", currency: "BRL", account_status: 1, amount_spent: "12345" }],
      });
    if (u.pathname.startsWith("/" + GRAPH_VERSION + "/act_") && u.searchParams.get("fields") === "currency")
      return reply(200, { currency: "BRL" });
    if (u.pathname.endsWith("/insights"))
      return reply(200, { data: [{ spend: "10.5", clicks: "3", date_start: "a", date_stop: "b" }] });
    if (objects[id]) return reply(200, { id, account_id: "1", ...objects[id] });
    return reply(404, { error: { message: `nope ${TOKEN}`, code: 100 } });
  };
  fn.calls = calls;
  return fn;
}

const text = (r) => r.content[0].text;
const env = (extra = {}) => ({ META_ACCESS_TOKEN: TOKEN, ...extra });

test("o token vai só no cabeçalho Authorization, nunca na URL ou no corpo", async () => {
  const fetch = fakeFetch();
  const meta = createMetaAdsTools({ fetch, env: env() });
  await meta.callTool("meta_listar_contas", {});
  await meta.callTool("meta_insights", { id: "act_1001", periodo: "last_30d" });
  for (const call of fetch.calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!call.url.includes(TOKEN) && !call.url.includes("access_token"));
    assert.ok(call.url.includes(`/${GRAPH_VERSION}/`));
  }
});

test("sem token as ferramentas explicam e não chamam a rede", async () => {
  const fetch = fakeFetch();
  const meta = createMetaAdsTools({ fetch, env: {} });
  assert.equal((await meta.callTool("meta_listar_contas", {})).isError, true);
  assert.equal(fetch.calls.length, 0);
});

test("erros nunca mostram o token", async () => {
  const meta = createMetaAdsTools({ fetch: fakeFetch(), env: env() });
  const out = text(await meta.callTool("meta_listar_campanhas", { conta: "act_999999" }));
  assert.doesNotMatch(out, /EAAB/);
  assert.doesNotMatch(redact(`Bearer ${TOKEN}`), /EAAB/);
});

test("somente leitura por padrão: ferramentas de alteração nem aparecem e recusam", async () => {
  const fetch = fakeFetch({ 111: { name: "C", status: "ACTIVE", daily_budget: "1000" } });
  const meta = createMetaAdsTools({ fetch, env: env() });
  assert.ok(!meta.toolList().some((tool) => tool.name === "meta_pausar"));
  const result = await meta.callTool("meta_pausar", { id: "111" });
  assert.equal(result.isError, true);
  assert.ok(fetch.calls.every((call) => !call.init.method || call.init.method === "GET"));
});

test("alterações sem teto ficam bloqueadas; com PERMITIR=nao também", async () => {
  const noCap = createMetaAdsTools({ fetch: fakeFetch(), env: env({ META_PERMITIR_ALTERACOES: "sim" }) });
  assert.match(text(await noCap.callTool("meta_pausar", { id: "111" })), /teto/);
  const off = createMetaAdsTools({
    fetch: fakeFetch(),
    env: env({ META_PERMITIR_ALTERACOES: "nao", META_LIMITE_ORCAMENTO_DIARIO: "100" }),
  });
  assert.equal(off.changesAllowed, false);
});

test("criar campanha sempre PAUSED, recusa objetivo ruim e orçamento acima do teto", async () => {
  const fetch = fakeFetch();
  const meta = createMetaAdsTools({
    fetch,
    env: env({ META_PERMITIR_ALTERACOES: "sim", META_LIMITE_ORCAMENTO_DIARIO: "100" }),
  });
  assert.equal(
    (await meta.callTool("meta_criar_campanha", { conta: "act_1001", nome: "X", objetivo: "FOO" })).isError,
    true,
  );
  assert.equal(
    (
      await meta.callTool("meta_criar_campanha", {
        conta: "act_1001",
        nome: "X",
        objetivo: "OUTCOME_TRAFFIC",
        orcamento_diario: 500,
      })
    ).isError,
    true,
  );
  const out = text(
    await meta.callTool("meta_criar_campanha", {
      conta: "act_1001",
      nome: "Teste",
      objetivo: "OUTCOME_TRAFFIC",
      orcamento_diario: 50,
    }),
  );
  assert.match(out, /PAUSADA/);
  const post = fetch.calls.find((call) => call.init.method === "POST");
  const body = JSON.parse(post.init.body);
  assert.equal(body.status, "PAUSED");
  assert.equal(body.daily_budget, "5000");
});

test("pausar e retomar mostram antes e depois; retomar acima do teto é recusado", async () => {
  const objects = {
    111: { name: "Barata", status: "PAUSED", effective_status: "PAUSED", daily_budget: "5000" },
    222: { name: "Cara", status: "PAUSED", effective_status: "PAUSED", daily_budget: "50000" },
  };
  const meta = createMetaAdsTools({
    fetch: fakeFetch(objects),
    env: env({ META_PERMITIR_ALTERACOES: "sim", META_LIMITE_ORCAMENTO_DIARIO: "100" }),
  });
  const resumed = text(await meta.callTool("meta_retomar", { id: "111" }));
  assert.match(resumed, /ANTES:[\s\S]*PAUSED[\s\S]*DEPOIS:[\s\S]*ACTIVE/);
  const paused = text(await meta.callTool("meta_pausar", { id: "111" }));
  assert.match(paused, /DEPOIS:[\s\S]*PAUSED/);
  const refused = await meta.callTool("meta_retomar", { id: "222" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /teto/);
  assert.equal(objects[222].status, "PAUSED");
});

test("alterar orçamento: antes e depois, recusa acima do teto, limite por hora", async () => {
  const objects = { 111: { name: "C", status: "ACTIVE", daily_budget: "5000" } };
  let time = 1_000;
  const meta = createMetaAdsTools({
    fetch: fakeFetch(objects),
    env: env({ META_PERMITIR_ALTERACOES: "sim", META_LIMITE_ORCAMENTO_DIARIO: "100" }),
    now: () => time,
  });
  assert.equal((await meta.callTool("meta_alterar_orcamento", { id: "111", orcamento_diario: 101 })).isError, true);
  assert.equal(objects[111].daily_budget, "5000");
  const out = text(await meta.callTool("meta_alterar_orcamento", { id: "111", orcamento_diario: 80 }));
  assert.match(out, /ANTES:[\s\S]*50 BRL[\s\S]*DEPOIS:[\s\S]*80 BRL/);
  for (let i = 0; i < 9; i += 1) await meta.callTool("meta_alterar_orcamento", { id: "111", orcamento_diario: 60 });
  const blocked = await meta.callTool("meta_alterar_orcamento", { id: "111", orcamento_diario: 60 });
  assert.match(text(blocked), /Limite/);
  time += 3_600_001;
  assert.ok(!(await meta.callTool("meta_alterar_orcamento", { id: "111", orcamento_diario: 60 })).isError);
});

test("nomes de terceiros são embrulhados e ids são validados", async () => {
  const meta = createMetaAdsTools({ fetch: fakeFetch(), env: env() });
  const out = text(await meta.callTool("meta_listar_contas", {}));
  assert.match(out, /META_TEXTO_NAO_CONFIAVEL/);
  assert.equal((await meta.callTool("meta_listar_campanhas", { conta: "../me" })).isError, true);
});
