// WhatsCat: ritmo da conversa em funções puras. Divide uma resposta longa em mensagens curtas, calcula a pausa
// entre elas, a janela adaptativa de agrupamento e o ritmo da leitura. Nada aqui lê, envia ou grava arquivos.

export const DEFAULT_PART_CHARS = 300;
export const DEFAULT_MAX_PARTS = 4;
export const DEFAULT_PAUSE_MIN_MS = 1500;
export const DEFAULT_PAUSE_MAX_MS = 5000;

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
const TRAILING = /[.,;:!?)\]}"'”’»…]+$/u;
const LIST_ITEM = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+\S/u;
const ABBREVIATIONS = new Set([
  "sr",
  "sra",
  "srta",
  "dr",
  "dra",
  "prof",
  "profa",
  "av",
  "ex",
  "etc",
  "obs",
  "tel",
  "nº",
  "no",
  "pág",
  "cap",
  "art",
  "vs",
  "min",
  "máx",
  "ltda",
]);
const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";
const PLACEHOLDER = /(\d+)/g;

/** Troca cada endereço por uma marca sem espaço nem ponto: nenhuma divisão cai dentro de um link. */
function hideUrls(text) {
  const urls = [];
  const hidden = text.replace(URL_PATTERN, (match) => {
    const tail = match.match(TRAILING)?.[0] ?? "";
    const url = tail ? match.slice(0, match.length - tail.length) : match;
    urls.push(url);
    return `${PLACEHOLDER_OPEN}${urls.length - 1}${PLACEHOLDER_CLOSE}${tail}`;
  });
  return { hidden, restore: (value) => value.replace(PLACEHOLDER, (_all, index) => urls[Number(index)] ?? "") };
}

/** Frases de um parágrafo. Não divide depois de abreviação ("Sr. Silva") nem dentro de número ("3.5"). */
function sentencesOf(paragraph) {
  const pieces = paragraph.split(/(?<=[.!?…]["”')\]]?)\s+(?=[\p{Lu}\p{N}"“¿¡(])/u);
  const joined = [];
  for (const piece of pieces) {
    const previous = joined.at(-1);
    const lastWord = previous?.match(/([\p{L}º]+)\.$/u)?.[1]?.toLowerCase();
    if (previous !== undefined && lastWord && ABBREVIATIONS.has(lastWord))
      joined[joined.length - 1] = `${previous} ${piece}`;
    else joined.push(piece);
  }
  return joined;
}

/** Corta um trecho sem ponto final no último espaço que cabe. Uma palavra maior que o teto fica inteira. */
function cutWords(text, limit) {
  const out = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let at = rest.lastIndexOf(" ", limit);
    if (at <= 0) at = rest.indexOf(" ", limit);
    if (at <= 0) break;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Unidades que nunca se dividem: cada item de lista inteiro, cada frase. `join` é o que une uma unidade à
 * anterior dentro do mesmo trecho.
 */
function unitsOf(block, limit, size) {
  // Um parágrafo que cabe inteiro fica inteiro, com suas quebras de linha.
  if (size(block) <= limit) return [{ text: block, join: " " }];
  const lines = block.split("\n");
  if (lines.some((line) => LIST_ITEM.test(line))) {
    // Item de lista com suas linhas de continuação; o texto antes da lista é um item à parte.
    const items = [];
    for (const line of lines) {
      if (LIST_ITEM.test(line) || items.length === 0) items.push(line);
      else items[items.length - 1] += `\n${line}`;
    }
    return items.map((text) => ({ text, join: "\n" }));
  }
  const flat = lines.map((line) => line.trim()).join("\n");
  const units = [];
  for (const sentence of sentencesOf(flat)) {
    for (const piece of sentence.length > limit ? cutWords(sentence, limit) : [sentence])
      units.push({ text: piece, join: " " });
  }
  return units;
}

function pack(blocks, limit, hide) {
  const parts = [];
  let current = "";
  const size = (value) => hide.restore(value).length;
  for (const block of blocks) {
    block.units.forEach((unit, index) => {
      const glue = index === 0 ? "\n\n" : unit.join;
      const candidate = current ? `${current}${glue}${unit.text}` : unit.text;
      if (current && size(candidate) > limit) {
        parts.push(current);
        current = unit.text;
      } else {
        current = candidate;
      }
    });
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Divide a resposta em mensagens curtas: primeiro nas linhas em branco, depois nas frases. Alvo de `maxChars`
 * por mensagem e no máximo `maxParts`. Link e item de lista nunca são cortados no meio. Se o texto não cabe em
 * `maxParts` mensagens do tamanho alvo, o alvo cresce até caber: nada é perdido nem resumido.
 */
export function splitReply(text, { maxChars = DEFAULT_PART_CHARS, maxParts = DEFAULT_MAX_PARTS } = {}) {
  const clean = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!clean) return [];
  const limit = Math.max(40, Math.floor(maxChars));
  const wanted = Math.max(1, Math.floor(maxParts));
  if (clean.length <= limit) return [clean];
  const hide = hideUrls(clean);
  const paragraphs = hide.hidden
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  let target = limit;
  for (let round = 0; round < 40; round += 1) {
    const size = (value) => hide.restore(value).length;
    const blocks = paragraphs.map((block) => ({ units: unitsOf(block, target, size) }));
    const parts = pack(blocks, target, hide);
    if (parts.length <= wanted) return parts.map((part) => hide.restore(part).trim());
    target = Math.ceil(target * 1.25);
  }
  return [clean];
}

/** Pausa antes de uma parte: proporcional ao tamanho dela, entre o mínimo e o máximo da config. */
export function partPauseMs(
  text,
  { minMs = DEFAULT_PAUSE_MIN_MS, maxMs = DEFAULT_PAUSE_MAX_MS, maxChars = DEFAULT_PART_CHARS } = {},
) {
  const low = Math.max(0, minMs);
  const high = Math.max(low, maxMs);
  const share = Math.min(1, String(text ?? "").length / Math.max(1, maxChars));
  return Math.round(low + (high - low) * share);
}

const COMPLETE_END = /[.!?…)"”]\s*$|\p{Extended_Pictographic}\s*$/u;

/**
 * Janela de silêncio de uma rajada. `baseMs` é o padrão. Termina em pontuação, emoji ou é mídia: a pessoa
 * provavelmente acabou, então espera menos. Mensagens muito seguidas (digitando em pedaços) esperam mais.
 * Nunca passa de `hardMs` desde a primeira mensagem, e 0 continua sendo 0.
 */
export function adaptiveWindowMs(entry, baseMs, hardMs) {
  if (baseMs <= 0) return 0;
  const last = entry.messages.at(-1);
  let factor = 1;
  if (last?.mediaType || COMPLETE_END.test(String(last?.text ?? ""))) factor = 0.5;
  else if (entry.prevAt !== undefined && entry.lastAt - entry.prevAt <= 2000 && entry.messages.length > 1) factor = 1.4;
  return Math.min(hardMs, Math.max(1000, Math.round(baseMs * factor)));
}

/**
 * Ritmo da leitura: curto enquanto há movimento e longo depois de um tempo parado. `activity()` marca que
 * algo aconteceu (mensagem nova ou trabalho na fila); `delayMs()` diz quanto esperar até a próxima leitura.
 */
export function createPollPacer({ now = Date.now } = {}) {
  let lastActivity = now();
  return {
    activity() {
      lastActivity = now();
    },
    delayMs({ pollSeconds = 3, pollIdleSeconds = 15, idleMinutes = 5 } = {}) {
      const idle = now() - lastActivity > idleMinutes * 60_000;
      return Math.max(1, idle ? Math.max(pollSeconds, pollIdleSeconds) : pollSeconds) * 1000;
    },
  };
}

const UPDATE_CURSOR_PARAMS = ["cursor", "checkpoint", "next_cursor", "update_id", "offset", "after_id", "since_id"];
const TYPING_TOOLS = [
  "send_typing",
  "set_typing",
  "typing",
  "send_chat_state",
  "send_presence",
  "set_presence",
  "chat_presence",
];

const propertiesOf = (tool) => Object.keys(tool?.inputSchema?.properties ?? {});
const requiredOf = (tool) => (Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : []);

/**
 * O que o motor oferece, lido só da lista de ferramentas dele. `get_updates` só vale se ele declara um
 * parâmetro de ponto de controle; o indicador de digitação só vale se a ferramenta pede apenas `chat_id`.
 * Qualquer dúvida devolve null: a ponte segue com `read_messages` e sem indicador.
 */
export function inspectEngineTools(tools) {
  const list = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool.name === "string") : [];
  const updatesTool = list.find((tool) => tool.name === "get_updates");
  const cursorParam = updatesTool
    ? UPDATE_CURSOR_PARAMS.find((name) => propertiesOf(updatesTool).includes(name))
    : null;
  const updatesRequired = updatesTool ? requiredOf(updatesTool).filter((name) => name !== cursorParam) : [];
  const typingTool = list.find(
    (tool) =>
      TYPING_TOOLS.includes(tool.name) &&
      propertiesOf(tool).includes("chat_id") &&
      requiredOf(tool).every((name) => name === "chat_id"),
  );
  return {
    updates:
      updatesTool && cursorParam && updatesRequired.length === 0 ? { name: updatesTool.name, cursorParam } : null,
    typing: typingTool ? { name: typingTool.name } : null,
  };
}

const RESULT_CURSORS = ["next_cursor", "cursor", "checkpoint", "next_checkpoint", "next_offset"];

/**
 * Lê as mensagens novas de todas as conversas de uma vez, com `get_updates`, se a lista de ferramentas
 * confirmou o ponto de controle. Confere o formato da primeira resposta (lista de mensagens e um novo ponto de
 * controle); fora do esperado, desliga e devolve `unusable: true` para a ponte voltar a `read_messages`.
 */
export function createUpdatesReader(callEngine, plan) {
  let broken = false;
  return {
    get usable() {
      return Boolean(plan) && !broken;
    },
    async read({ cursor }) {
      if (!plan || broken) return { unusable: true };
      const args = { limit: 100, ...(cursor ? { [plan.cursorParam]: cursor } : {}) };
      const result = await callEngine(plan.name, args);
      if (result?.isError) throw new Error("O motor recusou a leitura.");
      let value = result?.structuredContent;
      if (!value) {
        try {
          value = JSON.parse(result?.content?.[0]?.text ?? "null");
        } catch {
          value = null;
        }
      }
      const found = Array.isArray(value) ? value : (value?.messages ?? value?.updates ?? value?.items);
      const next = RESULT_CURSORS.map((name) => value?.[name]).find(
        (item) => typeof item === "string" || typeof item === "number",
      );
      if (!Array.isArray(found) || next === undefined || (cursor && String(next).length === 0)) {
        broken = true;
        return { unusable: true };
      }
      const messages = found.map((item) => (item && typeof item === "object" && item.message ? item.message : item));
      return { messages, cursor: String(next), firstRead: !cursor };
    },
  };
}
