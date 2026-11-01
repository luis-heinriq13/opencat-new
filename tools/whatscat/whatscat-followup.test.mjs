// Fila de follow-up, com ferramentas falsas e pasta temporária: nada aqui fala com o WhatsApp nem com os dados reais.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBridge, createDispatcher, readBridgeSettings, saveBridgeSettings } from "./whatscat-bridge.mjs";
import {
  appendDoNotContact,
  approvalIsValid,
  approvalKeyFile,
  approveItems,
  callFollowUpTool,
  csvField,
  editItemText,
  FOLLOW_UP_MIN_GAP_MS,
  followUpRequestId,
  handleFollowUpRoute,
  normalizeNumber,
  readApprovalKey,
  readDoNotContact,
  readFollowUpQueue,
  rejectItem,
  widenEngineScope,
} from "./whatscat-followup.mjs";

// Uma terça-feira às 10:00, no relógio local de quem roda o teste.
const T0 = new Date(2026, 2, 10, 10, 0, 0).getTime();
const NUM = "5511911112222";
const CHAT = `${NUM}@s.whatsapp.net`;
const NUM2 = "5511933334444";
const CHAT2 = `${NUM2}@s.whatsapp.net`;
const TEXT = "Olá, vi que vocês atendem na região. Faz sentido conversarmos dez minutos sobre o WhatsApp da recepção?";

let dir;
let csv;
let queueFile;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatscat-followup-"));
  csv = join(dir, "nao-contatar.csv");
  queueFile = join(dir, "opencat-ponte-followup.json");
  writeFileSync(csv, "telefone,empresa,data,motivo\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const followUp = (extra = {}) => ({
  ativo: true,
  limiteDia: 5,
  inicio: "09:00",
  fim: "18:00",
  naoContatarArquivo: csv,
  ...extra,
});
const writeConfig = (extra = {}) =>
  writeFileSync(
    join(dir, "opencat-ponte.json"),
    JSON.stringify({
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: ["5511900000000@s.whatsapp.net"],
      followUp: followUp(),
      ...extra,
    }),
  );
const context = (clock = { value: T0 }) => ({
  queueFile,
  stateFile: join(dir, "opencat-ponte-estado.json"),
  readSettings: () => readBridgeSettings(join(dir, "opencat-ponte.json")),
  saveSettings: (patch) => saveBridgeSettings(join(dir, "opencat-ponte.json"), patch),
  now: () => clock.value,
});
const propose = (args = {}) => {
  const { texto, erro } = callFollowUpTool(
    "propor_follow_up",
    { numero: NUM, nome: "Clínica A", nicho: "odonto", texto: TEXT, motivo: "Recepção cheia", ...args },
    context(),
  );
  return { ...JSON.parse(texto), erro };
};
const blocks = () => ({ doNotContact: new Set(), stopped: [], excludes: [], internalContacts: [] });
const approveAll = () =>
  approveItems(
    queueFile,
    readFollowUpQueue(queueFile)
      .itens.filter((item) => item.status === "proposta")
      .map((item) => ({ id: item.id })),
    { blocks: blocks(), now: () => T0 },
  );
const queue = () => readFollowUpQueue(queueFile);

function readHistory() {
  const folder = join(dir, "contatos");
  return readdirSync(folder).flatMap((name) => JSON.parse(readFileSync(join(folder, name), "utf8")).mensagens);
}

function build({ clock = { value: T0 }, config = {}, deps = {}, inbox = [] } = {}) {
  const sent = [];
  const order = [];
  const pending = [...inbox];
  const bridge = createBridge({
    dir,
    now: () => clock.value,
    config: {
      enabled: true,
      agentId: "agente",
      reply: "auto",
      mode: "selected",
      chats: ["5511900000000@s.whatsapp.net"],
      groups: [],
      groupConfigs: [],
      excludes: [],
      internalContacts: [],
      groupSeconds: 0,
      minGapSeconds: 0,
      maxRepliesPerHour: 10,
      stopWords: ["pare"],
      quietHours: { enabled: false },
      aceitoAcessoTotal: false,
      followUp: followUp(),
      ...config,
    },
    deps: {
      readMessages: async ({ chatId }) => {
        const mine = pending.filter((item) => item.chat_id === chatId);
        for (const item of mine) pending.splice(pending.indexOf(item), 1);
        return mine;
      },
      postToAgent: async () => ({ deliveryId: "d1" }),
      getDelivery: async () => ({ status: "completed", answer: "Claro, pode falar." }),
      agentAccess: async () => "workspace",
      sleep: async () => undefined,
      random: () => 0,
      typing: async () => {
        order.push("typing");
      },
      scopeAdd: async () => {
        order.push("scope");
        return { added: false };
      },
      scopeRemove: async () => {
        order.push("unscope");
      },
      addChat: async (chatId) => {
        order.push(`chat:${chatId}`);
      },
      send: async (request) => {
        sent.push(request);
        order.push("send");
        // No momento do envio a marca já está gravada: uma queda aqui nunca reenvia.
        assert.equal(queue().itens.find((item) => item.chatId === request.chatId).status, "enviada");
      },
      ...deps,
    },
  });
  return { bridge, sent, order, clock };
}
const audit = (bridge) => (existsSync(bridge.files.audit) ? readFileSync(bridge.files.audit, "utf8") : "");
const metrics = (bridge) => (existsSync(bridge.files.metrics) ? readFileSync(bridge.files.metrics, "utf8") : "");

test("desligado por padrão: sem a chave na configuração nada sai, nem com item aprovado", async () => {
  writeConfig({ followUp: { naoContatarArquivo: csv } });
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.ativo, false);
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.limiteDia, 5);
  propose();
  approveAll();
  const run = build({ config: { followUp: followUp({ ativo: false }) } });
  rmSync(join(dir, "opencat-ponte.json"));
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(queue().itens[0].status, "aprovada");
});

test("a proposta só acrescenta: arquivo 0600, nada aprovado, nada enviado, e o agente não aprova", () => {
  writeConfig();
  const answer = propose();
  assert.equal(answer.ok, true);
  assert.equal(queue().itens[0].status, "proposta");
  assert.equal(queue().itens[0].chatId, CHAT);
  assert.equal(statSync(queueFile).mode & 0o777, 0o600);
  // A lista do agente não leva nome, texto nem número inteiro.
  const { texto } = callFollowUpTool("listar_follow_up", {}, context());
  assert.equal(JSON.parse(texto).contagem.proposta, 1);
  assert.ok(!texto.includes(NUM) && !texto.includes("Clínica") && !texto.includes(TEXT));
});

test("a proposta recusa número barrado, duplicado, grupo, inválido e texto ruim", () => {
  writeConfig();
  writeFileSync(csv, "telefone,empresa,data,motivo\n(11) 91111-2222,X,2026-01-01,y\n");
  // Na lista, com máscara e com ou sem o nono dígito.
  assert.equal(propose().motivo, "nao_contatar");
  assert.equal(propose({ numero: "551111112222" }).motivo, "nao_contatar");
  assert.equal(propose({ numero: "120363000000000001@g.us" }).motivo, "grupo");
  assert.equal(propose({ numero: "123" }).motivo, "numero_invalido");
  assert.equal(propose({ numero: "+1 415" }).motivo, "numero_invalido");
  assert.equal(propose({ numero: `${NUM}@lid` }).motivo, "numero_invalido");
  const ok = { numero: NUM2 };
  assert.equal(propose({ ...ok, texto: "  " }).motivo, "texto_vazio");
  assert.equal(propose({ ...ok, texto: "a".repeat(601) }).motivo, "texto_longo");
  assert.equal(propose({ ...ok, texto: "Fale com @@HUMANO@@" }).motivo, "marcador_humano");
  assert.equal(propose({ ...ok, texto: "Veja /Users/luis/segredo" }).motivo, "texto_barrado");
  assert.equal(propose({ ...ok, texto: "Ligue para +55 11 98888-7777" }).motivo, "texto_barrado");
  assert.equal(propose({ ...ok, motivo: " " }).motivo, "motivo_vazio");
  assert.equal(propose(ok).ok, true);
  // Duplicado em qualquer estado, inclusive com o outro formato do mesmo número.
  rejectItem(queueFile, queue().itens[0].id);
  assert.equal(propose(ok).motivo, "duplicado");
  assert.equal(propose({ numero: "551133334444" }).motivo, "duplicado");
  assert.equal(queue().itens.length, 1);
});

test("contato parado, excluído ou da equipe é recusado, e sem a lista nada é proposto", () => {
  writeConfig({ excludes: [CHAT2], internalContacts: ["5511955556666@s.whatsapp.net"] });
  writeFileSync(join(dir, "opencat-ponte-estado.json"), JSON.stringify({ stopped: [CHAT] }));
  assert.equal(propose().motivo, "nao_contatar");
  assert.equal(propose({ numero: NUM2 }).motivo, "nao_contatar");
  assert.equal(propose({ numero: "5511955556666" }).motivo, "contato_interno");
  rmSync(csv);
  assert.equal(propose({ numero: "5511977778888" }).motivo, "lista_nao_contatar_indisponivel");
});

test("o nono dígito nunca é inventado", () => {
  assert.equal(normalizeNumber("11 91111-2222").numero, NUM);
  const without = normalizeNumber("11 1111-2222");
  assert.equal(without.numero, "551111112222");
  const mobile = normalizeNumber("11 9111-2222");
  assert.equal(mobile.numero, "551191112222");
  assert.equal(mobile.aviso, "sem_nono_digito");
});

test("o painel: edição passa pelo filtro, aprovar só muda proposta e item enviado não volta", () => {
  writeConfig();
  propose();
  const { id } = queue().itens[0];
  assert.equal(editItemText(queueFile, { id, texto: "Ligue +55 11 98888-7777" }).motivo, "texto_barrado");
  assert.equal(queue().itens[0].texto, TEXT);
  assert.equal(editItemText(queueFile, { id, texto: "Texto novo e curto." }).ok, true);
  const refused = handleFollowUpRoute(
    "POST",
    "/follow-up/aprovar",
    { itens: [{ id, texto: "@@HUMANO@@" }] },
    context(),
  );
  assert.equal(refused.status, 400);
  assert.equal(queue().itens[0].status, "proposta");
  const done = handleFollowUpRoute("POST", "/follow-up/aprovar", { itens: [{ id }] }, context());
  assert.equal(done.status, 200);
  assert.equal(queue().itens[0].status, "aprovada");
  const view = handleFollowUpRoute("GET", "/follow-up", {}, context()).value;
  assert.equal(view.ativo, true);
  assert.equal(view.itens[0].nome, "Clínica A");
  assert.equal(view.itens[0].motivo, "Recepção cheia");
  assert.equal(view.itens[0].texto, "Texto novo e curto.");
  // Limite e horário são corrigidos ou recusados, e o caminho da lista não muda pelo painel.
  const config = handleFollowUpRoute(
    "POST",
    "/follow-up/config",
    { ativo: true, limiteDia: 99, inicio: "10:00", fim: "11:00" },
    context(),
  );
  assert.equal(config.value.limiteDia, 20);
  assert.equal(
    handleFollowUpRoute("POST", "/follow-up/config", { inicio: "18:00", fim: "09:00" }, context()).status,
    400,
  );
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.naoContatarArquivo, csv);
});

test("envia um por rodada, na ordem certa, com intervalo gravado e limite do dia", async () => {
  writeConfig();
  propose();
  propose({ numero: NUM2 });
  propose({ numero: "5511955556666" });
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const run = build({ config: { followUp: followUp({ limiteDia: 2 }) } });
  await run.bridge.poll();
  assert.equal(run.sent.length, 1);
  assert.deepEqual(run.order, ["scope", "typing", "send", "scope", `chat:${CHAT}`]);
  assert.equal(run.sent[0].requestId, followUpRequestId(queue().itens[0].id));
  assert.match(run.sent[0].requestId, /^wc-fu-[0-9a-f]+$/);
  // Enviada, com o histórico para o agente saber o que disse.
  const item = queue().itens[0];
  assert.equal(item.status, "enviada");
  assert.equal(item.confirmada, true);
  const history = readHistory();
  assert.ok(history.some((entry) => entry.de === "voce" && entry.texto === TEXT));
  // Reiniciar não solta outra: o intervalo está no arquivo, e o relógio ainda não chegou lá.
  run.clock.value += FOLLOW_UP_MIN_GAP_MS - 1000;
  const restarted = build({ clock: run.clock, config: { followUp: followUp({ limiteDia: 2 }) } });
  await restarted.bridge.poll();
  assert.equal(restarted.sent.length, 0);
  run.clock.value += 2000;
  await restarted.bridge.poll();
  assert.equal(restarted.sent.length, 1);
  // O limite do dia para a terceira.
  run.clock.value += FOLLOW_UP_MIN_GAP_MS * 3;
  await restarted.bridge.poll();
  assert.equal(restarted.sent.length, 1);
  assert.equal(queue().itens[2].status, "aprovada");
  // Métrica e auditoria sem número e sem texto.
  const logged = audit(run.bridge) + metrics(run.bridge);
  assert.match(metrics(run.bridge), /follow_up_enviado/);
  assert.ok(!logged.includes(NUM) && !logged.includes(TEXT));
});

test("fora do horário, no fim de semana e no silêncio nada sai", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  for (const when of [
    new Date(2026, 2, 10, 8, 59).getTime(),
    new Date(2026, 2, 10, 18, 0).getTime(),
    new Date(2026, 2, 14, 10, 0).getTime(),
    new Date(2026, 2, 15, 10, 0).getTime(),
  ]) {
    const run = build({ clock: { value: when } });
    await run.bridge.poll();
    assert.equal(run.sent.length, 0);
  }
  const quiet = build({ config: { quietHours: { enabled: true, start: "09:30", end: "11:00" } } });
  await quiet.bridge.poll();
  assert.equal(quiet.sent.length, 0);
  assert.equal(queue().itens[0].status, "aprovada");
});

test("logo antes do envio: nao-contatar e pausa geral barram mesmo depois de digitar", async () => {
  writeConfig();
  propose();
  approveAll();
  // A lista muda durante o "digitando": a segunda conferência pega.
  let run = build({
    deps: {
      typing: async () => writeFileSync(csv, `telefone,empresa,data,motivo\n${NUM},X,2026-01-01,y\n`),
    },
  });
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  // Na rodada seguinte o item fica recusado de vez.
  await run.bridge.poll();
  assert.equal(queue().itens[0].status, "recusada");
  // A pausa geral muda durante o "digitando".
  writeFileSync(csv, "telefone,empresa,data,motivo\n");
  propose({ numero: NUM2 });
  approveAll();
  run = build({ deps: { typing: async () => writeConfig({ reply: "pause" }) } });
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(queue().itens[1].status, "aprovada");
  // Sem a lista, nada sai.
  writeConfig();
  rmSync(csv);
  run = build();
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(queue().itens[1].status, "aprovada");
});

test("contato que parou depois de aprovado é recusado na hora do envio", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  writeFileSync(join(dir, "opencat-ponte-estado.json"), JSON.stringify({ stopped: [CHAT] }));
  const run = build();
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(queue().itens[0].status, "recusada");
  assert.equal(queue().itens[0].motivoRecusa, "nao_contatar");
});

test("envio que o motor recusa: escopo somado é desfeito e o item não volta nem pelo painel", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  const removed = [];
  const run = build({
    clock,
    deps: {
      scopeAdd: async () => ({ added: true }),
      scopeRemove: async (chatId) => removed.push(chatId),
      send: async () => ({ structuredContent: { status: "failed" } }),
    },
  });
  await run.bridge.poll();
  clock.value += 30_000;
  await run.bridge.poll();
  const { id, status } = queue().itens[0];
  assert.equal(status, "falhou");
  assert.deepEqual(removed, [CHAT]);
  assert.equal(editItemText(queueFile, { id, texto: "Outro texto." }).motivo, "ja_processado");
  assert.equal(rejectItem(queueFile, id).motivo, "ja_processado");
  assert.equal(approveItems(queueFile, [{ id }], { blocks: blocks() }).resultados[0].motivo, "ja_processado");
});

test("reply pause e porta de permissões seguram o envio", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  let run = build({ config: { reply: "pause" } });
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  run = build({ deps: { agentAccess: async () => "full" } });
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  run = build({ deps: { sendCapacity: () => false } });
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(queue().itens[0].status, "aprovada");
  assert.equal(queue().itens[0].enviadaEm, null);
});

test("queda no meio do envio nunca reenvia: fica incerto, com o escopo e o atendimento para ler um pare", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  class Crash extends Error {}
  let added = false;
  const scope = {
    scopeAdd: async () => {
      added = !added;
      return { added };
    },
    scopeRemove: async () => {
      added = false;
    },
  };
  // A primeira rodada só soma o escopo e espera a sessão do motor voltar.
  const first = build({ clock, deps: scope });
  await first.bridge.poll();
  assert.equal(first.sent.length, 0);
  assert.equal(queue().itens[0].escopoAdicionado, true);
  clock.value += 10_000;
  await first.bridge.poll();
  assert.equal(first.sent.length, 0);
  clock.value += 30_000;
  // Simula a queda: o processo morre com a marca gravada, antes de saber o resultado.
  let snapshot = null;
  const crash = build({
    clock,
    deps: {
      ...scope,
      send: async () => {
        snapshot = readFileSync(queueFile, "utf8");
        throw new Crash("conexão caiu");
      },
    },
  });
  await crash.bridge.poll();
  assert.ok(JSON.parse(snapshot).itens[0].emEnvio);
  writeFileSync(queueFile, snapshot);
  clock.value += FOLLOW_UP_MIN_GAP_MS * 3;
  const after = build({ clock, deps: { scopeAdd: scope.scopeAdd, scopeRemove: scope.scopeRemove } });
  await after.bridge.poll();
  await after.bridge.poll();
  assert.equal(after.sent.length, 0);
  const item = queue().itens[0];
  assert.equal(item.status, "enviada");
  assert.equal(item.incerto, true);
  assert.notEqual(item.confirmada, true);
  assert.equal(added, true);
  assert.ok(after.order.includes(`chat:${CHAT}`));
  assert.equal(item.atendimentoLigado, true);
  assert.ok(readHistory().some((entry) => entry.de === "voce" && entry.texto === TEXT));
});

test("resposta do motor: failed não repete, uncertain fica incerto, limite volta para aprovada", async () => {
  writeConfig();
  propose();
  propose({ numero: NUM2 });
  propose({ numero: "5511955556666" });
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  const statusOf = (status) => async () => ({ structuredContent: { status } });
  const base = {};
  // Limitador: o item volta e não conta no dia.
  let run = build({
    clock,
    deps: {
      ...base,
      send: async () => {
        throw new Error("Limite de 30 mensagens por hora atingido. Nada foi enviado.");
      },
    },
  });
  await run.bridge.poll();
  assert.equal(queue().itens[0].status, "aprovada");
  assert.equal(queue().itens[0].enviadaEm, null);
  clock.value += FOLLOW_UP_MIN_GAP_MS * 3;
  // O motor diz que falhou, sem isError: nada foi enviado, e sem retentativa.
  run = build({ clock, deps: { ...base, scopeAdd: async () => ({ added: false }), send: statusOf("failed") } });
  await run.bridge.poll();
  assert.equal(queue().itens[0].status, "falhou");
  assert.ok(!run.order.some((step) => step.startsWith("chat:")));
  clock.value += FOLLOW_UP_MIN_GAP_MS * 3;
  // Incerto: pode ter saído, então não volta para a fila, e o atendimento liga para ler a resposta.
  run = build({ clock, deps: { ...base, send: statusOf("uncertain") } });
  await run.bridge.poll();
  assert.equal(queue().itens[1].status, "enviada");
  assert.equal(queue().itens[1].incerto, true);
  assert.ok(run.order.includes(`chat:${CHAT2}`));
  clock.value += FOLLOW_UP_MIN_GAP_MS * 3;
  // Aceito: o atendimento liga.
  run = build({ clock, deps: { ...base, send: statusOf("accepted") } });
  await run.bridge.poll();
  assert.equal(queue().itens[2].confirmada, true);
  assert.ok(run.order.includes("chat:5511955556666@s.whatsapp.net"));
});

test("a primeira resposta marca respondeu, segue o atendimento normal e o envio próprio não vira dono assumindo", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  await build({ clock }).bridge.poll();
  assert.equal(queue().itens[0].status, "enviada");
  // A ponte recarrega a configuração a cada rodada: aqui o contato já está em "chats".
  clock.value += 5000;
  const at = new Date(clock.value).toISOString();
  const inbox = [
    { message_id: "own", chat_id: CHAT, text: TEXT, from_me: true, timestamp: at },
    { message_id: "r1", chat_id: CHAT, text: "Oi, tenho interesse", from_me: false, timestamp: at },
  ];
  const run = build({ clock, inbox, config: { chats: [CHAT] } });
  await run.bridge.poll();
  assert.equal(queue().itens[0].status, "respondeu");
  assert.match(metrics(run.bridge), /follow_up_respondeu/);
  assert.ok(!audit(run.bridge).includes("dono_assumiu"));
  // A resposta do agente saiu pela ponte normal.
  clock.value += 5000;
  await run.bridge.poll();
  assert.ok(run.sent.some((request) => request.text === "Claro, pode falar."));
});

test("palavra de parada: exclui, grava em nao-contatar sem injeção, e só com o recurso em uso", async () => {
  writeConfig();
  propose({ nome: '=HYPERLINK("http://mal"),\nsegunda' });
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  await build({ clock }).bridge.poll();
  clock.value += 5000;
  const at = new Date(clock.value).toISOString();
  const excluded = [];
  const run = build({
    clock,
    inbox: [{ message_id: "s1", chat_id: CHAT, text: "pare", from_me: false, timestamp: at }],
    config: { chats: [CHAT] },
    deps: { addExclude: (chatId) => excluded.push(chatId) },
  });
  await run.bridge.poll();
  assert.deepEqual(excluded, [CHAT]);
  const lines = readFileSync(csv, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith(`${NUM},"'=HYPERLINK`));
  assert.ok(lines[1].endsWith(",pediu_para_parar"));
  assert.equal(csvField("+SOMA(1)"), "'+SOMA(1)");
  assert.equal(csvField("-1"), "'-1");
  // Não duplica, nem quando a lista perdeu a quebra de linha no fim.
  writeFileSync(csv, "telefone,empresa,data,motivo");
  const off = build({
    clock,
    inbox: [{ message_id: "s2", chat_id: CHAT2, text: "pare", from_me: false, timestamp: at }],
    config: { chats: [CHAT2], followUp: followUp({ ativo: false }) },
  });
  await off.bridge.poll();
  // Desligado e sem item na fila: a parada é só a de sempre.
  assert.equal(readFileSync(csv, "utf8"), "telefone,empresa,data,motivo");
  const on = build({
    clock,
    inbox: [{ message_id: "s3", chat_id: "5511977778888@s.whatsapp.net", text: "pare", from_me: false, timestamp: at }],
    config: { chats: ["5511977778888@s.whatsapp.net"] },
  });
  await on.bridge.poll();
  assert.equal(readFileSync(csv, "utf8"), "telefone,empresa,data,motivo\n5511977778888,,2026-03-10,pediu_para_parar\n");
});

test("escopo do motor: mantém os que existem, nunca vira all, e all já cobre", async () => {
  const calls = [];
  const engine = (scope) => async (method, _path, body) => {
    calls.push({ method, body });
    return { scope };
  };
  assert.deepEqual(await widenEngineScope(engine({ mode: "selected", chat_ids: ["a@s.whatsapp.net"] }), CHAT), {
    added: true,
  });
  assert.deepEqual(calls.at(-1).body, { mode: "selected", chat_ids: ["a@s.whatsapp.net", CHAT] });
  calls.length = 0;
  assert.deepEqual(await widenEngineScope(engine({ mode: "selected", chat_ids: [CHAT] }), CHAT), { added: false });
  assert.deepEqual(await widenEngineScope(engine({ mode: "all", chat_ids: [] }), CHAT), { added: false });
  assert.ok(calls.every((call) => call.method === "GET"));
  await assert.rejects(widenEngineScope(engine({ mode: "initial" }), CHAT));
  await assert.rejects(widenEngineScope(engine({ mode: "selected", chat_ids: [] }), "1@g.us"));
});

test("uma fila corrompida não é regravada e nada sai", async () => {
  writeConfig();
  writeFileSync(queueFile, "{quebrado");
  const run = build();
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(readFileSync(queueFile, "utf8"), "{quebrado");
});

test("nao-contatar: `;` do Excel, coluna por cabeçalho, linhas antigas e lista ilegível sem envio", async () => {
  writeFileSync(csv, `﻿sep=;\nEmpresa;Número;Motivo\n"Clínica; A";(11) 91111-2222;x\n;;\n`);
  assert.ok(readDoNotContact(csv).has("551111112222"));
  writeFileSync(csv, `empresa;telefone\nA, LTDA;${NUM}\n${NUM2},,2026-01-01,pediu\n`);
  assert.deepEqual([...readDoNotContact(csv)], ["551111112222", "551133334444"]);
  // A parada acrescenta no mesmo formato, e a linha nova se lê de volta.
  appendDoNotContact(csv, { numero: "5511977778888", empresa: "B; C", motivo: "m", at: "2026-01-02" });
  assert.ok(readFileSync(csv, "utf8").trim().endsWith(`"B; C";5511977778888;2026-01-02;m`));
  assert.ok(readDoNotContact(csv).has("551177778888"));
  for (const broken of [
    "nome,cidade\nA,B\n",
    "telefone;nome\nsem número;A\n",
    "telefone;nome\n5,51191E+12;A\n",
    "t\0e",
  ]) {
    writeFileSync(csv, broken);
    assert.throws(() => readDoNotContact(csv));
  }
  // Com a lista ilegível, nem o item já aprovado sai.
  writeFileSync(csv, "telefone\n");
  writeConfig();
  propose();
  approveAll();
  writeFileSync(csv, "telefone;nome\nsem número;A\n");
  const run = build();
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
  assert.equal(queue().itens[0].status, "aprovada");
});

test("envio real do despachante: incerto vem antes do erro, e failed sem isError é falha", async () => {
  const limiter = { check: () => 0, record: () => limiter.count++, count: 0 };
  const dispatch = (result) =>
    createDispatcher({ limiter, callEngine: async () => result })({ chatId: CHAT, text: "x", requestId: "r" });
  await assert.rejects(dispatch({ structuredContent: { status: "failed" } }));
  await assert.rejects(dispatch({ isError: true }));
  assert.equal(limiter.count, 0);
  const uncertain = await dispatch({ isError: true, structuredContent: { status: "uncertain" } });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(limiter.count, 1);
});

test("resposta comum com status failed não conta como enviada e tenta de novo", async () => {
  const clock = { value: T0 };
  const limiter = { check: () => 0, record: () => undefined };
  let result = { structuredContent: { status: "failed" } };
  const texts = [];
  const send = async (request) => {
    const out = await createDispatcher({ limiter, callEngine: async () => result })(request);
    texts.push(request.text);
    return out;
  };
  const at = new Date(T0).toISOString();
  const inbox = [{ message_id: "m1", chat_id: CHAT, text: "Oi", from_me: false, timestamp: at }];
  const run = build({ clock, inbox, config: { chats: [CHAT] }, deps: { send } });
  await run.bridge.poll();
  clock.value += 5000;
  await run.bridge.poll();
  await run.bridge.poll();
  assert.deepEqual(texts, []);
  result = { structuredContent: { status: "accepted" } };
  clock.value += 60_000;
  await run.bridge.poll();
  assert.deepEqual(texts, ["Claro, pode falar."]);
});

test("escopo: gravado antes do PUT, desfeito em espera, depois de uma queda e sem travar com edição no painel", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  const removed = [];
  const scopeRemove = async (chatId) => removed.push(chatId);
  // A queda logo depois do PUT: a marca já está no arquivo.
  const crashed = build({
    clock,
    deps: {
      scopeRemove,
      scopeAdd: async (_chatId, beforePut) => {
        beforePut();
        throw new Error("queda depois do PUT");
      },
    },
  });
  await crashed.bridge.poll();
  assert.equal(queue().itens[0].escopoAdicionado, true);
  // Fora do horário, em espera: a conversa sai do escopo.
  const held = build({ clock: { value: new Date(2026, 2, 10, 19, 0).getTime() }, deps: { scopeRemove } });
  await held.bridge.poll();
  assert.deepEqual(removed, [CHAT]);
  assert.equal(queue().itens[0].escopoAdicionado, false);
  assert.equal(queue().itens[0].escopoEm, null);
  // Só entra no momento do envio, e na pausa geral sai.
  const added = { scopeAdd: async () => ({ added: true }), scopeRemove };
  await build({ clock, deps: added }).bridge.poll();
  assert.equal(queue().itens[0].escopoAdicionado, true);
  await build({ clock, config: { reply: "pause" }, deps: added }).bridge.poll();
  assert.equal(removed.length, 2);
  // O painel tirou a conversa do escopo: o item não fica preso, confere de novo e envia.
  const allowed = { value: false };
  const checks = { calls: 0 };
  const edited = build({
    clock,
    deps: {
      scopeAdd: async () => {
        checks.calls += 1;
        allowed.value = true;
        return { added: false };
      },
      scopeRemove,
      engineReady: async () => allowed.value,
    },
  });
  writeFileSync(
    queueFile,
    JSON.stringify({ ...queue(), itens: [{ ...queue().itens[0], escopoEm: clock.value, escopoAdicionado: false }] }),
  );
  await edited.bridge.poll();
  assert.equal(edited.sent.length, 0);
  assert.equal(queue().itens[0].escopoEm, null);
  await edited.bridge.poll();
  assert.equal(checks.calls >= 1, true);
  assert.equal(edited.sent.length, 1);
});

test("escopo de item aprovado expira mesmo sem o item ser o próximo", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  const removed = [];
  const deps = {
    scopeAdd: async () => ({ added: true }),
    scopeRemove: async (chatId) => removed.push(chatId),
    engineReady: async () => true,
  };
  await build({ clock, deps }).bridge.poll();
  clock.value += 300_000;
  await build({ clock, deps }).bridge.poll();
  assert.deepEqual(removed, [CHAT]);
});

test("falhou abre nova proposta com outro request_id; incerto, recusado e enviado não", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  await build({ clock, deps: { send: async () => ({ structuredContent: { status: "failed" } }) } }).bridge.poll();
  const first = queue().itens[0];
  assert.equal(first.status, "falhou");
  writeConfig();
  const again = propose({ numero: "551111112222" });
  assert.equal(again.ok, true);
  assert.equal(queue().itens.length, 1);
  assert.equal(queue().itens[0].status, "proposta");
  assert.notEqual(followUpRequestId(again.id), followUpRequestId(first.id));
  // Falhar de novo abre uma terceira tentativa, com outro ID.
  writeFileSync(queueFile, JSON.stringify({ ...queue(), itens: [{ ...queue().itens[0], status: "falhou" }] }));
  const third = propose({ numero: "551111112222" });
  assert.notEqual(third.id, again.id);
  // Com qualquer dúvida o item fica.
  writeFileSync(
    queueFile,
    JSON.stringify({ ...queue(), itens: [{ ...queue().itens[0], status: "falhou", incerto: true }] }),
  );
  assert.equal(propose().motivo, "duplicado");
  writeFileSync(
    queueFile,
    JSON.stringify({ ...queue(), itens: [{ ...queue().itens[0], status: "enviada", incerto: true }] }),
  );
  assert.equal(propose().motivo, "duplicado");
});

test("selo: arquivo editado não envia, nem no último instante, e a edição do painel renova o selo", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const { id } = queue().itens[0];
  const key = readApprovalKey(approvalKeyFile(queueFile));
  assert.equal(statSync(approvalKeyFile(queueFile)).mode & 0o777, 0o600);
  assert.ok(approvalIsValid(key, queue().itens[0]));
  assert.ok(!readFileSync(queueFile, "utf8").includes(key));
  // O dono edita pelo painel: continua valendo, com o texto novo.
  assert.equal(editItemText(queueFile, { id, texto: "Texto do dono." }).ok, true);
  assert.ok(approvalIsValid(key, queue().itens[0]));
  const tamper = (change) =>
    writeFileSync(queueFile, JSON.stringify({ ...queue(), itens: [{ ...queue().itens[0], ...change }] }));
  // Edição durante o "digitando": a conferência dentro da trava pega.
  const late = build({ deps: { typing: async () => tamper({ texto: "Outro texto." }) } });
  await late.bridge.poll();
  assert.equal(late.sent.length, 0);
  assert.equal(queue().itens[0].status, "recusada");
  assert.equal(queue().itens[0].motivoRecusa, "aprovacao_invalida");
  // Sem selo, com outro destino ou sem a chave também não sai.
  for (const change of [{ selo: undefined }, { chatId: CHAT2, numero: NUM2 }]) {
    tamper({ status: "aprovada", enviadaEm: null, texto: "Texto do dono.", selo: queue().itens[0].selo, ...change });
    const run = build();
    await run.bridge.poll();
    assert.equal(run.sent.length, 0);
    assert.equal(queue().itens[0].motivoRecusa, "aprovacao_invalida");
  }
  tamper({ status: "aprovada", chatId: CHAT, numero: NUM, motivoRecusa: undefined });
  approveItems(queueFile, [], { blocks: blocks() });
  rmSync(approvalKeyFile(queueFile));
  const run = build();
  await run.bridge.poll();
  assert.equal(run.sent.length, 0);
});

test("modo automático: só o painel liga, com confirmação; passa nos filtros, um por vez, e respeita os limites", async () => {
  writeConfig();
  const ctx = context();
  const route = (body) => handleFollowUpRoute("POST", "/follow-up/autonomia", body, ctx);
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.autonomia, "aprovar");
  assert.equal(route({ autonomia: "auto" }).status, 400);
  assert.equal(route({ autonomia: "tudo", confirmo: true }).status, 400);
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.autonomia, "aprovar");
  assert.equal(route({ autonomia: "auto", confirmo: true }).status, 200);
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.autonomia, "auto");
  // Salvar os outros campos não muda o modo, e nenhuma ferramenta do agente muda.
  handleFollowUpRoute("POST", "/follow-up/config", { ativo: true, limiteDia: 1, inicio: "09:00", fim: "18:00" }, ctx);
  assert.equal(readBridgeSettings(join(dir, "opencat-ponte.json")).followUp.autonomia, "auto");
  assert.equal(route({ autonomia: "aprovar" }).status, 200);
  writeConfig({ followUp: followUp({ autonomia: "auto" }) });
  propose();
  propose({ numero: NUM2 });
  propose({ numero: "1191112222" });
  const clock = { value: T0 };
  // Desligado: nada é aprovado sozinho.
  writeConfig({ followUp: followUp({ autonomia: "auto", ativo: false }) });
  await build({ clock }).bridge.poll();
  assert.equal(queue().itens[0].status, "proposta");
  // Ligado: a mais antiga sai com selo e a outra espera o intervalo.
  writeConfig({ followUp: followUp({ autonomia: "auto" }) });
  const run = build({ clock });
  await run.bridge.poll();
  assert.equal(run.sent.length, 1);
  assert.equal(queue().itens[0].aprovadaPor, "auto");
  assert.ok(approvalIsValid(readApprovalKey(approvalKeyFile(queueFile)), queue().itens[0]));
  assert.equal(queue().itens[1].status, "proposta");
  const view = handleFollowUpRoute("GET", "/follow-up", {}, context(clock)).value;
  assert.equal(view.autonomia, "auto");
  assert.equal(view.ultimasEnviadas[0].automatica, true);
  assert.equal(view.ultimasEnviadas[0].texto, TEXT);
  // Número que entrou em nao-contatar: recusado, sem envio, e o limite do dia vale.
  writeFileSync(csv, `telefone,empresa,data,motivo\n${NUM2},X,2026-01-01,y\n`);
  clock.value += FOLLOW_UP_MIN_GAP_MS * 3;
  await run.bridge.poll();
  assert.equal(queue().itens[1].status, "recusada");
  assert.equal(queue().itens[1].motivoRecusa, "nao_contatar");
  // Sem o nono dígito espera o dono.
  assert.equal(queue().itens[2].status, "proposta");
});

test("listar_follow_up diz ao agente, em palavras simples, o que ele pode fazer agora", () => {
  const ask = (extra) => {
    writeConfig({ followUp: followUp(extra) });
    return JSON.parse(callFollowUpTool("listar_follow_up", {}, context()).texto);
  };
  const off = ask({ ativo: false });
  assert.equal(off.situacao, "desligado");
  assert.match(off.mensagem, /desligado/);
  propose();
  const approval = ask({ limiteDia: 3 });
  assert.equal(approval.situacao, "precisa_aprovacao");
  assert.equal(approval.restamHoje, 3);
  assert.match(approval.mensagem, /1 aguardando aprovação/);
  assert.match(approval.mensagem, /Restam 3 de 3/);
  const auto = ask({ autonomia: "auto" });
  assert.equal(auto.situacao, "automatico");
  assert.match(auto.mensagem, /Automático/);
  assert.ok(!JSON.stringify(auto).includes(NUM) && !JSON.stringify(auto).includes(TEXT));
});

test("resposta por @lid que traz o número: marca o item, lê o pare e grava nao-contatar", async () => {
  writeConfig();
  propose();
  approveAll();
  rmSync(join(dir, "opencat-ponte.json"));
  const clock = { value: T0 };
  await build({ clock }).bridge.poll();
  clock.value += 5000;
  const at = new Date(clock.value).toISOString();
  const lid = "99887766@lid";
  const excluded = [];
  const stop = { message_id: "l1", chat_id: lid, sender_pn: CHAT, text: "pare", from_me: false, timestamp: at };
  const run = build({
    clock,
    config: { chats: [CHAT] },
    inbox: [],
    deps: {
      addExclude: (chatId) => excluded.push(chatId),
      updates: { usable: true, read: async () => ({ messages: [stop], cursor: "c1", firstRead: false }) },
    },
  });
  await run.bridge.poll();
  const item = queue().itens[0];
  assert.equal(item.status, "respondeu");
  assert.equal(item.lidChatId, lid);
  assert.deepEqual(excluded.sort(), [CHAT, lid].sort());
  assert.ok(readDoNotContact(csv).has("551111112222"));
  assert.ok(run.order.includes(`chat:${lid}`));
  // Sem o número, a conversa não é tocada.
  const other = build({
    clock,
    config: { chats: [CHAT2] },
    deps: {
      updates: {
        usable: true,
        read: async () => ({
          messages: [{ message_id: "l2", chat_id: "111@lid", text: "pare", from_me: false, timestamp: at }],
          cursor: "c2",
          firstRead: false,
        }),
      },
    },
  });
  await other.bridge.poll();
  assert.equal(queue().itens[0].lidChatId, lid);
});

/** O processo real, numa pasta temporária, com um motor falso: as ferramentas, as rotas e o segredo do painel. */
test("processo real com motor falso: ferramentas do agente e rotas do painel com o mesmo segredo", {
  timeout: 30_000,
}, async () => {
  writeConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const fake = join(dir, "motor-falso.sh");
  writeFileSync(
    fake,
    `#!/bin/sh\ncat >/dev/null\necho '{"whatsapp":{"linked":true,"status":"connected"},"scope":{"mode":"selected","chat_ids":[]}}'\n`,
  );
  chmodSync(fake, 0o755);
  const env = { ...process.env, WHATSCAT_DATA_DIR: dir, WHATSCAT_SERVICE_BIN: fake, WHATSCAT_ENGINE_BIN: fake };

  const mcp = spawn(process.execPath, [join(here, "whatscat-mcp.mjs")], { env, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  const rpc = async (id, method, params) => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return JSON.parse((await lines.next()).value).result;
  };
  const proposed = await rpc(1, "tools/call", {
    name: "propor_follow_up",
    arguments: { numero: NUM, nome: "A", nicho: "b", texto: TEXT, motivo: "c" },
  });
  assert.equal(JSON.parse(proposed.content[0].text).ok, true);
  assert.equal(queue().itens[0].status, "proposta");
  mcp.stdin.end();

  const panel = spawn(process.execPath, [join(here, "whatscat-mcp.mjs"), "--panel"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const url = (await createInterface({ input: panel.stdout })[Symbol.asyncIterator]().next()).value.replace(
    "PANEL_URL=",
    "",
  );
  try {
    const { origin } = new URL(url);
    const denied = await fetch(`${origin}/follow-up/aprovar`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 403);
    const view = await (await fetch(`${url}follow-up`)).json();
    assert.equal(view.itens[0].status, "proposta");
    const page = await (await fetch(url)).text();
    assert.ok(page.includes("Risco de banimento"));
    const approved = await fetch(`${url}follow-up/aprovar`, {
      method: "POST",
      body: JSON.stringify({ itens: [{ id: view.itens[0].id }] }),
    });
    assert.equal(approved.status, 200);
    assert.equal(queue().itens[0].status, "aprovada");
  } finally {
    // O painel termina sozinho quando a entrada fecha.
    panel.stdin.end();
  }
});

test("número de outro país só com + e fim de semana só se o dono escolher", async () => {
  const { normalizeNumber, insideFollowUpHours, followUpConfigOf } = await import("./whatscat-followup.mjs");
  assert.equal(normalizeNumber("+351912345678").numero, "351912345678");
  assert.equal(normalizeNumber("351912345678").ok, false);
  assert.equal(normalizeNumber("+123").ok, false);
  const sunday = new Date(2026, 10, 1, 10, 0).getTime();
  assert.equal(insideFollowUpHours(followUpConfigOf({}), sunday), false);
  assert.equal(insideFollowUpHours(followUpConfigOf({ todosOsDias: true }), sunday), true);
});
