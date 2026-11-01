// Ritmo da ponte: respostas em partes, janela adaptativa, leitura por get_updates e uma tarefa por contato.
// Tudo com dependências falsas e pastas temporárias: nada lê, envia ou toca dados de verdade.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createSendLimiter } from "./mcp-stdio.mjs";
import { createAgentApi, createBridge, createDispatcher, loadBridgeConfig } from "./whatscat-bridge.mjs";
import {
  adaptiveWindowMs,
  createPollPacer,
  createUpdatesReader,
  inspectEngineTools,
  partPauseMs,
  splitReply,
} from "./whatscat-reply.mjs";

const PERSON = "5500000000001@s.whatsapp.net";
const OTHER = "5500000000002@s.whatsapp.net";
const T0 = Date.parse("2026-01-01T00:00:10Z");
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whatscat-ritmo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const squash = (text) => text.replace(/\s+/g, " ").trim();
const msg = (id, chat_id = PERSON, text = "oi", extra = {}) => ({
  message_id: id,
  chat_id,
  text,
  from_me: false,
  timestamp: "2026-01-01T00:00:05Z",
  ...extra,
});

// ---------- divisão

test("resposta curta não é dividida", () => {
  assert.deepEqual(splitReply("Olá! Posso ajudar."), ["Olá! Posso ajudar."]);
  assert.deepEqual(splitReply("   "), []);
});

test("divide nas linhas em branco e depois nas frases, sem perder texto", () => {
  const paragraph = (n) =>
    `Frase número ${n} do atendimento aqui. Outra frase do mesmo parágrafo ${n} segue logo depois.`;
  const text = [1, 2, 3, 4, 5].map(paragraph).join("\n\n");
  const parts = splitReply(text, { maxChars: 200, maxParts: 4 });
  assert.ok(parts.length > 1 && parts.length <= 4);
  assert.equal(squash(parts.join(" ")), squash(text));
  const long = Array.from({ length: 12 }, (_, i) => `Esta é a frase ${i + 1} de uma resposta bem longa.`).join(" ");
  const sentences = splitReply(long, { maxChars: 150, maxParts: 6 });
  assert.ok(sentences.length > 1);
  for (const part of sentences) assert.ok(part.length <= 150, `parte com ${part.length}`);
  assert.equal(squash(sentences.join(" ")), squash(long));
});

test("nunca passa de maxPartes: o alvo cresce e nada se perde", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Parágrafo ${i} com algum texto de apoio para ocupar espaço.`).join(
    "\n\n",
  );
  const parts = splitReply(text, { maxChars: 100, maxParts: 4 });
  assert.equal(parts.length, 4);
  assert.equal(squash(parts.join(" ")), squash(text));
  assert.equal(splitReply(text, { maxChars: 100, maxParts: 1 }).length, 1);
});

test("link nunca é cortado e lista não é partida no meio de um item", () => {
  const url = "https://exemplo.com.br/produtos/caminho/muito/longo/que/passa/do/limite/da/parte?ref=abc&x=1";
  const text = `Veja os detalhes completos no nosso site agora mesmo: ${url}. Depois me diga se ficou alguma dúvida sobre isso.`;
  const parts = splitReply(text, { maxChars: 60, maxParts: 6 });
  assert.equal(parts.filter((part) => part.includes(url)).length, 1);
  const list = [
    "Itens do plano:",
    "- Primeiro item com uma descrição razoável",
    "- Segundo item com outra descrição razoável",
    "- Terceiro item fechando a lista toda",
  ].join("\n");
  const listed = splitReply(list, { maxChars: 90, maxParts: 4 });
  for (const item of list.split("\n").slice(1)) assert.equal(listed.filter((part) => part.includes(item)).length, 1);
  assert.equal(listed.join("\n").replace(/\s+/g, " "), list.replace(/\s+/g, " "));
});

test("abreviação e número com ponto não geram divisão", () => {
  const text = `Fale com o Sr. Silva sobre o valor de 3.5 mil. ${"Mais uma frase para passar do limite desta parte. ".repeat(6)}`;
  const parts = splitReply(text, { maxChars: 80, maxParts: 8 });
  assert.ok(parts[0].includes("Sr. Silva"));
  assert.ok(parts.every((part) => !/(^|\s)Sr\.$/.test(part)));
  assert.ok(parts.some((part) => part.includes("3.5 mil")));
});

test("a pausa entre partes é proporcional ao tamanho, entre 1,5 e 5 s", () => {
  assert.equal(partPauseMs("a"), 1512);
  assert.equal(partPauseMs("x".repeat(300)), 5000);
  assert.equal(partPauseMs("x".repeat(900)), 5000);
  assert.equal(partPauseMs("x".repeat(150), { minMs: 1000, maxMs: 3000, maxChars: 300 }), 2000);
});

// ---------- janela e ritmo

test("a janela adaptativa encurta no fim de frase e alonga na digitação rápida, com teto", () => {
  const entry = (texts, extra = {}) => ({ messages: texts.map((text) => ({ text })), firstAt: 0, lastAt: 0, ...extra });
  assert.equal(adaptiveWindowMs(entry(["bom dia"]), 6000, 15000), 6000);
  assert.equal(adaptiveWindowMs(entry(["Preciso de ajuda com meu pedido."]), 6000, 15000), 3000);
  assert.equal(adaptiveWindowMs(entry(["quero", "saber"], { prevAt: 0, lastAt: 1500 }), 6000, 15000), 8400);
  assert.equal(adaptiveWindowMs(entry(["quero", "saber"], { prevAt: 0, lastAt: 1500 }), 6000, 7000), 7000);
  assert.equal(adaptiveWindowMs({ messages: [{ text: "x", mediaType: "audio" }] }, 6000, 15000), 3000);
  assert.equal(adaptiveWindowMs(entry(["oi"]), 0, 15000), 0);
});

test("uma rajada fecha com 6 s de silêncio e nunca espera mais de 15 s", async () => {
  let clock = T0;
  const posted = [];
  const bridge = createBridge({
    dir,
    now: () => clock,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON],
      groups: [],
      excludes: [],
      groupSeconds: 6,
      minGapSeconds: 0,
    },
    deps: {
      readMessages: async () => [msg("A1", PERSON, "oi", { timestamp: new Date(T0 - 1000).toISOString() })],
      postToAgent: async (request) => {
        posted.push(request);
        return { deliveryId: "d1" };
      },
      getDelivery: async () => ({ status: "running" }),
      agentAccess: async () => "workspace",
      send: async () => {},
    },
  });
  await bridge.poll();
  assert.equal(posted.length, 0, "silêncio de 1 s: ainda junta");
  clock = T0 + 4000;
  await bridge.poll();
  assert.equal(posted.length, 0, "5 s de silêncio: ainda junta");
  clock = T0 + 6000;
  await bridge.poll();
  assert.equal(posted.length, 1, "6 s de silêncio: entrega");
});

test("o teto de 15 s fecha a rajada mesmo com mensagens chegando", async () => {
  let clock = T0;
  const inbox = [msg("B1", PERSON, "primeira", { timestamp: new Date(T0).toISOString() })];
  const posted = [];
  const bridge = createBridge({
    dir,
    now: () => clock,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON],
      groups: [],
      excludes: [],
      groupSeconds: 6,
      minGapSeconds: 0,
    },
    deps: {
      readMessages: async () => inbox.splice(0),
      postToAgent: async (request) => {
        posted.push(request);
        return { deliveryId: `d${posted.length}` };
      },
      getDelivery: async () => ({ status: "running" }),
      agentAccess: async () => "workspace",
      send: async () => {},
    },
  });
  await bridge.poll();
  for (const offset of [4000, 8000, 12000]) {
    clock = T0 + offset;
    inbox.push(msg(`B${offset}`, PERSON, "mais uma", { timestamp: new Date(clock).toISOString() }));
    await bridge.poll();
    assert.equal(posted.length, 0, `em ${offset} ms ainda junta`);
  }
  clock = T0 + 15000;
  await bridge.poll();
  assert.equal(posted.length, 1);
});

test("o ritmo da leitura é de 3 s e vai a 15 s depois de 5 minutos parado", () => {
  let clock = 0;
  const pacer = createPollPacer({ now: () => clock });
  const config = loadBridgeConfig(writeConfig({}));
  assert.equal(pacer.delayMs(config), 3000);
  clock = 4 * 60_000;
  assert.equal(pacer.delayMs(config), 3000);
  clock = 5 * 60_000 + 1;
  assert.equal(pacer.delayMs(config), 15000);
  pacer.activity();
  assert.equal(pacer.delayMs(config), 3000);
});

function writeConfig(extra) {
  const file = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ enabled: true, agentId: "a", chats: [PERSON], ...extra }));
  return file;
}

test("a config tem padrões novos e limites", () => {
  const config = loadBridgeConfig(writeConfig({}));
  assert.equal(config.maxPartes, 4);
  assert.equal(config.parteChars, 300);
  assert.equal(config.pausaMinSegundos, 1.5);
  assert.equal(config.pausaMaxSegundos, 5);
  assert.equal(config.pollIdleSeconds, 15);
  assert.equal(config.idleMinutes, 5);
  assert.equal(config.threadsPorContato, true);
  const custom = loadBridgeConfig(
    writeConfig({ maxPartes: 99, pausaMinSegundos: 9, pausaMaxSegundos: 2, pollSeconds: 0.2 }),
  );
  assert.equal(custom.maxPartes, 10);
  assert.equal(custom.pausaMaxSegundos, 9, "o máximo nunca fica abaixo do mínimo");
  assert.equal(custom.pollSeconds, 1);
});

// ---------- envio em partes

const LONG_ANSWER = [
  "Olá! Obrigado por entrar em contato com a nossa equipe de atendimento.",
  "Sobre o seu pedido: ele foi separado hoje cedo e deve sair para entrega ainda nesta tarde, com aviso por mensagem.",
  "Se quiser mudar o endereço ou o horário, é só me dizer aqui mesmo que eu ajusto com o time de entregas e confirmo.",
  "Posso ajudar com mais alguma coisa neste momento?",
].join("\n\n");

function setupParts({ answer = LONG_ANSWER, failTimes = 0, config = {}, readMessages } = {}) {
  const clock = { now: T0 };
  const sent = [];
  const sleeps = [];
  const typed = [];
  const posted = [];
  let failures = failTimes;
  const inbox = [msg("P1", PERSON, "oi", { timestamp: new Date(T0 - 1000).toISOString() })];
  const bridge = createBridge({
    dir,
    now: () => clock.now,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON],
      groups: [],
      excludes: [],
      groupSeconds: 0,
      minGapSeconds: 0,
      maxRepliesPerHour: 100,
      parteChars: 150,
      maxPartes: 4,
      threadsPorContato: false,
      ...config,
    },
    deps: {
      readMessages: readMessages ?? (async () => inbox.splice(0)),
      postToAgent: async (request) => {
        posted.push(request);
        return { deliveryId: `d${posted.length}` };
      },
      getDelivery: async () => ({ status: "completed", answer }),
      agentAccess: async () => "workspace",
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
      },
      typing: async (chatId) => typed.push(chatId),
      send: async (request) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("motor recusou o envio");
        }
        sent.push(request);
      },
    },
  });
  return { bridge, sent, sleeps, typed, posted, clock, inbox };
}

test("resposta longa sai em várias mensagens, na ordem, com pausa proporcional e request_id estável", async () => {
  const { bridge, sent, sleeps, typed } = setupParts();
  await bridge.poll();
  assert.ok(sent.length >= 2 && sent.length <= 4, `partes: ${sent.length}`);
  assert.equal(squash(sent.map((item) => item.text).join(" ")), squash(LONG_ANSWER));
  const ids = sent.map((item) => item.requestId);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(ids[0], /^wc-[0-9a-f]{10}$/);
  for (const [index, id] of ids.slice(1).entries()) assert.equal(id, `${ids[0]}-p${index + 2}`);
  assert.equal(sleeps.length, sent.length - 1, "pausa só entre as partes");
  for (const ms of sleeps) assert.ok(ms >= 1500 && ms <= 5000);
  assert.equal(sent[0].gapMs, undefined, "a primeira parte segue o limite normal");
  for (const item of sent.slice(1)) assert.ok(item.gapMs >= 1500 && item.gapMs <= 5000);
  assert.ok(typed.length >= sent.length, "o indicador vale ao entregar ao agente e antes de cada parte");
  const rows = readFileSync(bridge.files.metrics, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const answered = rows.filter((row) => row.evento === "respondida");
  assert.equal(answered.length, 1);
  assert.equal(answered[0].partes, sent.length);
  assert.ok("esperaMs" in answered[0] && "agenteMs" in answered[0] && "envioMs" in answered[0]);
});

test("o filtro de saída olha a resposta inteira antes de qualquer parte", async () => {
  const answer = `${LONG_ANSWER}\n\nO contato é 11 98765-4321 para qualquer dúvida.`;
  const { bridge, sent, posted } = setupParts({ answer });
  await bridge.poll();
  assert.equal(sent.length, 0);
  assert.ok(
    posted.some((request) => request.clientMessageId.startsWith("wc-aviso")),
    "o dono é avisado",
  );
  assert.ok(bridge.paused().length === 1);
});

test("parte que falha é repetida com o mesmo request_id e as seguintes esperam, sem duplicar", async () => {
  const { bridge, sent, clock } = setupParts({ failTimes: 1 });
  await bridge.poll();
  assert.equal(sent.length, 0, "a primeira falhou e as outras esperam por ela");
  clock.now += 31_000;
  await bridge.poll();
  const ids = sent.map((item) => item.requestId);
  assert.equal(new Set(ids).size, ids.length, "nenhum request_id repetido");
  assert.equal(squash(sent.map((item) => item.text).join(" ")), squash(LONG_ANSWER));
  assert.match(ids[0], /^wc-[0-9a-f]{10}$/);
  await bridge.poll();
  assert.equal(sent.length, ids.length, "nada novo na rodada seguinte");
});

test("mensagem nova durante o envio deixa as partes terminarem e é entregue depois", async () => {
  const inbox = [msg("N1", PERSON, "primeira", { timestamp: new Date(T0 - 1000).toISOString() })];
  const events = [];
  let injected = false;
  const clock = { now: T0 };
  const bridge = createBridge({
    dir,
    now: () => clock.now,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON],
      groups: [],
      excludes: [],
      groupSeconds: 0,
      minGapSeconds: 0,
      maxRepliesPerHour: 100,
      parteChars: 150,
      maxPartes: 4,
      threadsPorContato: false,
    },
    deps: {
      readMessages: async () => inbox.splice(0),
      postToAgent: async () => {
        events.push("post");
        return { deliveryId: `d${events.length}` };
      },
      getDelivery: async () => ({ status: "completed", answer: LONG_ANSWER }),
      agentAccess: async () => "workspace",
      sleep: async (ms) => {
        if (!injected) {
          injected = true;
          inbox.push(msg("N2", PERSON, "segunda", { timestamp: new Date(clock.now).toISOString() }));
        }
        clock.now += ms;
      },
      send: async () => events.push("send"),
    },
  });
  await bridge.poll();
  assert.ok(events.filter((event) => event === "send").length >= 2, "todas as partes saíram");
  assert.equal(events.filter((event) => event === "post").length, 1, "a nova ainda não foi entregue");
  await bridge.poll();
  assert.equal(events.filter((event) => event === "post").length, 2, "processada na rodada seguinte");
});

test("o limitador troca a pausa mínima pela da parte, mas mantém os tetos", async () => {
  const clock = { now: 1_000_000_000 };
  const limiter = createSendLimiter({
    file: join(dir, "lim.json"),
    minGapMs: 20_000,
    jitterMs: 0,
    perHour: 3,
    perDay: 10,
    now: () => clock.now,
  });
  const calls = [];
  const dispatch = createDispatcher({
    limiter,
    callEngine: async (tool, args) => {
      calls.push({ tool, args });
      return {};
    },
    sleep: async (ms) => {
      calls.push({ wait: ms });
      clock.now += ms;
    },
  });
  await dispatch({ chatId: PERSON, text: "um", requestId: "r1" });
  await dispatch({ chatId: PERSON, text: "dois", requestId: "r1-p2", gapMs: 2000 });
  assert.deepEqual(
    calls.filter((call) => "wait" in call),
    [{ wait: 2000 }],
  );
  await dispatch({ chatId: PERSON, text: "tres", requestId: "r1-p3", gapMs: 2000 });
  await assert.rejects(() => dispatch({ chatId: PERSON, text: "quatro", requestId: "r1-p4", gapMs: 2000 }), /por hora/);
  assert.equal(calls.filter((call) => call.tool).length, 3);
});

// ---------- get_updates e digitação, só pela lista de ferramentas

test("get_updates só vale com parâmetro de ponto de controle; digitação só pedindo chat_id", () => {
  const schema = (properties, required = []) => ({ type: "object", properties, required });
  assert.equal(inspectEngineTools([{ name: "read_messages", inputSchema: schema({ chat_id: {} }) }]).updates, null);
  assert.equal(inspectEngineTools([{ name: "get_updates", inputSchema: schema({ limit: {} }) }]).updates, null);
  assert.deepEqual(
    inspectEngineTools([{ name: "get_updates", inputSchema: schema({ cursor: {}, limit: {} }) }]).updates,
    { name: "get_updates", cursorParam: "cursor" },
  );
  assert.equal(
    inspectEngineTools([{ name: "get_updates", inputSchema: schema({ cursor: {}, account: {} }, ["account"]) }])
      .updates,
    null,
    "parâmetro obrigatório desconhecido",
  );
  assert.deepEqual(
    inspectEngineTools([{ name: "send_typing", inputSchema: schema({ chat_id: {} }, ["chat_id"]) }]).typing,
    { name: "send_typing" },
  );
  assert.equal(
    inspectEngineTools([{ name: "send_typing", inputSchema: schema({ chat_id: {}, state: {} }, ["chat_id", "state"]) }])
      .typing,
    null,
  );
  assert.deepEqual(inspectEngineTools(undefined), { updates: null, typing: null });
});

test("o leitor de get_updates confere o formato e desliga se ele não bate", async () => {
  const plan = { name: "get_updates", cursorParam: "cursor" };
  const answers = [
    { messages: [{ message_id: "u1" }], next_cursor: "c1" },
    { messages: [{ message_id: "u2" }], next_cursor: "c2" },
  ];
  const calls = [];
  const good = createUpdatesReader(async (_name, args) => {
    calls.push(args);
    return { structuredContent: answers[calls.length - 1] };
  }, plan);
  const first = await good.read({ cursor: "" });
  assert.deepEqual([first.cursor, first.firstRead], ["c1", true]);
  const second = await good.read({ cursor: "c1" });
  assert.equal(second.firstRead, false);
  assert.equal(calls[1].cursor, "c1");
  const bad = createUpdatesReader(async () => ({ structuredContent: { ok: true } }), plan);
  assert.equal((await bad.read({ cursor: "" })).unusable, true);
  assert.equal(bad.usable, false);
  assert.equal(createUpdatesReader(async () => ({}), null).usable, false);
});

test("com get_updates a ponte lê uma vez, guarda o ponto de controle e ignora o antigo e o que não é liberado", async () => {
  let reads = 0;
  let perChat = 0;
  const posted = [];
  const updates = {
    usable: true,
    async read({ cursor }) {
      reads += 1;
      return {
        firstRead: !cursor,
        cursor: `c${reads}`,
        messages: [
          msg("O1", PERSON, "antiga", { timestamp: "2025-12-31T23:00:00Z" }),
          msg("O2", OTHER, "de outra conversa não liberada", { timestamp: new Date(T0 + 500).toISOString() }),
          msg("O3", PERSON, "nova", { timestamp: new Date(T0 + 500).toISOString() }),
        ],
      };
    },
  };
  const bridge = createBridge({
    dir,
    now: () => T0,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON],
      groups: [],
      excludes: [],
      groupSeconds: 0,
      minGapSeconds: 0,
      threadsPorContato: false,
    },
    deps: {
      updates,
      readMessages: async () => {
        perChat += 1;
        return [];
      },
      postToAgent: async (request) => {
        posted.push(request);
        return { deliveryId: "d1" };
      },
      getDelivery: async () => ({ status: "running" }),
      agentAccess: async () => "workspace",
      send: async () => {},
    },
  });
  const first = await bridge.poll();
  assert.equal(perChat, 0, "sem leitura por conversa");
  assert.equal(posted.length, 1);
  assert.ok(posted[0].text.includes("nova") && !posted[0].text.includes("antiga") && !posted[0].text.includes("outra"));
  assert.equal(first.activity, true);
  assert.equal(JSON.parse(readFileSync(bridge.files.state, "utf8")).updatesCursor, "c1");
});

test("get_updates com formato errado volta a read_messages", async () => {
  let perChat = 0;
  const bridge = createBridge({
    dir,
    now: () => T0,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON],
      groups: [],
      excludes: [],
      groupSeconds: 0,
      threadsPorContato: false,
    },
    deps: {
      updates: createUpdatesReader(async () => ({ structuredContent: { surpresa: 1 } }), {
        name: "get_updates",
        cursorParam: "cursor",
      }),
      readMessages: async () => {
        perChat += 1;
        return [msg("F1", PERSON, "oi", { timestamp: new Date(T0 - 100).toISOString() })];
      },
      postToAgent: async () => ({ deliveryId: "d1" }),
      getDelivery: async () => ({ status: "running" }),
      agentAccess: async () => "workspace",
      send: async () => {},
    },
  });
  await bridge.poll();
  assert.equal(perChat, 1);
  assert.match(readFileSync(bridge.files.audit, "utf8"), /get_updates_indisponivel/);
});

// ---------- uma tarefa por contato

function setupThreads({ config = {}, postToAgent, closeTask, answer = "ok" } = {}) {
  const clock = { now: T0 };
  const posted = [];
  const closed = [];
  const inbox = [];
  const bridge = createBridge({
    dir,
    now: () => clock.now,
    config: {
      enabled: true,
      agentId: "a",
      mode: "selected",
      chats: [PERSON, OTHER],
      groups: [],
      excludes: [],
      groupSeconds: 0,
      minGapSeconds: 0,
      maxRepliesPerHour: 100,
      ...config,
    },
    deps: {
      readMessages: async ({ chatId }) => {
        const mine = inbox.filter((item) => item.chat_id === chatId);
        for (const item of mine) inbox.splice(inbox.indexOf(item), 1);
        return mine;
      },
      postToAgent:
        postToAgent ??
        (async (request) => {
          posted.push(request);
          return {
            deliveryId: `d${posted.length}`,
            ...(request.key ? { taskId: `task-${request.key.slice(-4)}` } : {}),
          };
        }),
      closeTask: closeTask ?? (async (request) => closed.push(request)),
      getDelivery: async () => ({ status: "completed", answer }),
      agentAccess: async () => "workspace",
      send: async () => {},
    },
  });
  const arrive = (id, chat, text = "oi") =>
    inbox.push(msg(id, chat, text, { timestamp: new Date(clock.now - 500).toISOString() }));
  return { bridge, posted, closed, clock, arrive };
}

test("cada contato tem a sua tarefa e a ponte guarda contato -> taskId, sem número no nome", async () => {
  const { bridge, posted, arrive } = setupThreads();
  arrive("T1", PERSON);
  arrive("T2", OTHER);
  await bridge.poll();
  assert.equal(posted.length, 2);
  assert.notEqual(posted[0].key, posted[1].key);
  for (const request of posted) assert.match(request.key, /^WhatsApp #[0-9a-f]{10}$/);
  assert.ok(posted.every((request) => !request.key.includes("5500000")));
  const state = JSON.parse(readFileSync(bridge.files.state, "utf8"));
  assert.equal(state.threads[PERSON].taskId, `task-${posted[0].key.slice(-4)}`);
  arrive("T3", PERSON, "de novo");
  await bridge.poll();
  assert.equal(posted[2].taskId, state.threads[PERSON].taskId, "a mesma tarefa na segunda mensagem");
});

test("o aviso ao dono continua no chat do agente, sem chave de tarefa nem conteúdo do cliente", async () => {
  const { bridge, posted, arrive } = setupThreads({ answer: "[[HUMANO]]" });
  arrive("W1", PERSON, "texto secreto do cliente");
  await bridge.poll();
  const notice = posted.find((request) => request.clientMessageId.startsWith("wc-aviso"));
  assert.ok(notice, "o dono foi avisado");
  assert.equal(notice.key, undefined);
  assert.equal(notice.taskId, undefined);
  assert.ok(!notice.text.includes("texto secreto"));
  assert.ok(posted.filter((request) => request.key).length === 1, "só a entrega do cliente vai à tarefa");
});

test("tarefa parada há mais de 24 h é encerrada, e a de quem tem trabalho em andamento não", async () => {
  const { bridge, posted, closed, clock, arrive } = setupThreads();
  arrive("C1", PERSON);
  await bridge.poll();
  const taskId = `task-${posted[0].key.slice(-4)}`;
  clock.now += 23 * 3_600_000;
  await bridge.poll();
  assert.equal(closed.length, 0);
  clock.now += 2 * 3_600_000;
  await bridge.poll();
  assert.deepEqual(closed, [{ agentId: "a", taskId }]);
  assert.equal(JSON.parse(readFileSync(bridge.files.state, "utf8")).threads[PERSON], undefined);
  assert.match(readFileSync(bridge.files.audit, "utf8"), /tarefa_encerrada/);
});

test("com o limite de tarefas abertas perto, a ponte encerra a mais antiga já parada antes de abrir outra", async () => {
  const { bridge, posted, closed, clock, arrive } = setupThreads({ config: { maxThreadsAbertas: 1 } });
  arrive("L1", PERSON);
  await bridge.poll();
  clock.now += 20 * 60_000;
  arrive("L2", OTHER);
  await bridge.poll();
  assert.equal(closed.length, 1);
  assert.equal(posted.length, 2);
});

test("sem a rota de tarefas a ponte cai no chat do agente e registra o fato uma vez", async () => {
  const calls = [];
  const { bridge, arrive } = setupThreads({
    postToAgent: async (request) => {
      calls.push(request);
      return { deliveryId: `d${calls.length}`, taskId: null, fallback: true };
    },
  });
  arrive("X1", PERSON);
  arrive("X2", OTHER);
  await bridge.poll();
  assert.equal(calls.length, 2, "as mensagens são entregues mesmo assim");
  const log = readFileSync(bridge.files.audit, "utf8");
  assert.equal(log.split("fio_por_contato_indisponivel").length - 1, 1);
});

test("threadsPorContato false mantém o chat único de antes", async () => {
  const { bridge, posted, arrive } = setupThreads({ config: { threadsPorContato: false } });
  arrive("Z1", PERSON);
  await bridge.poll();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].key, undefined);
});

test("a API: /tasks devolve o taskId, 404 cai em /messages, outra recusa é erro e close tolera 404", async () => {
  writeFileSync(join(dir, "url"), "http://127.0.0.1:1");
  writeFileSync(join(dir, "token"), "t");
  const seen = [];
  let mode = "ok";
  const api = createAgentApi({
    dir,
    fetchImpl: async (url, init) => {
      seen.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/tasks")) {
        if (mode === "ok")
          return { status: 202, json: async () => ({ deliveries: [{ id: "d1" }], taskId: "tk1", created: true }) };
        if (mode === "missing") return { status: 404, json: async () => ({}) };
        return { status: 409, json: async () => ({}) };
      }
      if (url.endsWith("/close")) return { ok: false, status: 404 };
      return { status: 202, json: async () => ({ deliveries: [{ id: "d9" }] }) };
    },
  });
  const request = { agentId: "a", text: "t", clientMessageId: "k", key: "WhatsApp #abc", taskId: "old" };
  assert.deepEqual(await api.postToAgent(request), { deliveryId: "d1", taskId: "tk1" });
  assert.deepEqual(seen[0].body, { key: "WhatsApp #abc", text: "t", clientMessageId: "k", taskId: "old" });
  mode = "missing";
  assert.deepEqual(await api.postToAgent(request), { deliveryId: "d9", taskId: null, fallback: true });
  assert.ok(seen.at(-1).url.endsWith("/messages"));
  mode = "full";
  await assert.rejects(() => api.postToAgent(request), /409/);
  await api.closeTask({ agentId: "a", taskId: "tk1" });
  assert.ok(seen.at(-1).url.endsWith("/tasks/tk1/close"));
});
