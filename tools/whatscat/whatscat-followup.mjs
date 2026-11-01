// WhatsCat: fila controlada de follow-up. O agente só propõe, o dono aprova no painel e só a ponte envia.
// Este módulo guarda a fila e as regras. Ele nunca fala com o WhatsApp: o envio fica em createBridge.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  chatDigits,
  filterOutbound,
  hasHandoffMarker,
  hasRedactedAnswer,
  maskNumber,
  minutesOf,
} from "./whatscat-safety.mjs";

export const FOLLOW_UP_FILE = "opencat-ponte-followup.json";
export const FOLLOW_UP_MAX_TEXT = 600;
export const FOLLOW_UP_MIN_GAP_MS = 240_000;
export const FOLLOW_UP_DEFAULTS = { ativo: false, limiteDia: 5, inicio: "09:00", fim: "18:00" };
const FOLLOW_UP_MAX_PER_DAY = 20;
const MAX_OPEN_PROPOSALS = 100;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const CSV_HEADER = "telefone,empresa,data,motivo";
/** A coluna do telefone, depois de normalizar o cabeçalho ("nmero" é "Número" em Windows-1252 lido como UTF-8). */
const PHONE_HEADER = /telefone|celular|whatsapp|^(?:phone|mobile|tel|fone|cel|whats|wpp|numero|nmero|contato)$/;
/** A chave do selo da aprovação. Nunca entra na fila, nem em ferramenta do agente. */
export const APPROVAL_KEY_FILE = "opencat-ponte-aprovacao.key";

export const defaultDoNotContactFile = () =>
  join(homedir(), "OpenBot", "Shared", "ChatNeed-Prospeccao", "nao-contatar.csv");

export function writePrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

/** A configuração do follow-up. Qualquer dúvida resulta em desligado e nos limites padrão. */
export function followUpConfigOf(raw) {
  const record = raw && typeof raw === "object" ? raw : {};
  const limit = Number(record.limiteDia);
  const start = minutesOf(record.inicio);
  const end = minutesOf(record.fim);
  const hoursOk = start !== null && end !== null && start < end;
  return {
    ativo: record.ativo === true,
    autonomia: record.autonomia === "auto" ? "auto" : "aprovar",
    limiteDia:
      record.limiteDia !== null && record.limiteDia !== "" && Number.isFinite(limit)
        ? Math.min(FOLLOW_UP_MAX_PER_DAY, Math.max(1, Math.floor(limit)))
        : FOLLOW_UP_DEFAULTS.limiteDia,
    inicio: hoursOk ? String(record.inicio).trim() : FOLLOW_UP_DEFAULTS.inicio,
    fim: hoursOk ? String(record.fim).trim() : FOLLOW_UP_DEFAULTS.fim,
    naoContatarArquivo:
      typeof record.naoContatarArquivo === "string" && record.naoContatarArquivo
        ? record.naoContatarArquivo
        : defaultDoNotContactFile(),
  };
}

/** Segunda a sexta, dentro do horário, no relógio local. */
export function insideFollowUpHours(settings, time) {
  const date = new Date(time);
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= minutesOf(settings.inicio) && minutes < minutesOf(settings.fim);
}

/**
 * Só números do Brasil, com 55. O nono dígito nunca é inventado: o que veio é o que fica. Um celular sem o nono
 * dígito segue como veio e leva `aviso`, porque o motor só aceita a forma registrada no WhatsApp (ver docs/whatscat.md).
 */
export function normalizeNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: false, motivo: "numero_invalido" };
  if (/@g\.us\b/i.test(raw) || /^\d{5,}-\d+$/.test(raw)) return { ok: false, motivo: "grupo" };
  if (/[^\d\s().+-]/.test(raw)) return { ok: false, motivo: "numero_invalido" };
  if (raw.startsWith("+") && !raw.startsWith("+55")) return { ok: false, motivo: "numero_invalido" };
  let digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  const match = /^55([1-9]\d)(\d{8,9})$/.exec(digits);
  if (!match) return { ok: false, motivo: "numero_invalido" };
  const local = match[2];
  if (local.length === 9 && local[0] !== "9") return { ok: false, motivo: "numero_invalido" };
  return {
    ok: true,
    numero: digits,
    chatId: `${digits}@s.whatsapp.net`,
    ...(local.length === 8 && /^[6-9]/.test(local) ? { aviso: "sem_nono_digito" } : {}),
  };
}

/** A mesma linha com e sem o nono dígito tem a mesma chave. Serve para recusar, nunca para escolher o destino. */
export function numberKey(digits) {
  let value = String(digits ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
  if (value.length === 10 || value.length === 11) value = `55${value}`;
  const match = /^55([1-9]\d)\d{0,1}(\d{8})$/.exec(value);
  return match ? `55${match[1]}${match[2]}` : value;
}

/** Os campos de uma linha. Excel em pt-BR grava `;`, e o arquivo pode ter linhas antigas com `,`: valem os dois. */
function csvCells(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if ((char === "," || char === ";") && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

const headerName = (cell) =>
  cell
    .normalize("NFD")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();

/** Dígitos de um campo de telefone. Com letra não é número: `5,5E+12` do Excel não pode virar uma chave errada. */
const phoneDigits = (cell) => (/\p{L}/u.test(cell) ? "" : cell.replace(/\D/g, ""));

/** Lança se uma linha não der número: uma linha que não se lê pode ser um pedido de parada. */
function parseDoNotContact(text) {
  if (text.includes("\0")) throw new Error("Lista nao-contatar ilegível.");
  const lines = text
    .replace(/^﻿/u, "")
    .split(/\r?\n/)
    .filter((line) => /[^\s,;"]/.test(line) && !/^sep=.$/i.test(line.trim()));
  const keys = new Set();
  if (!lines.length) return { keys, columns: [0], delimiter: "," };
  const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const first = csvCells(lines[0]);
  const found = first.flatMap((cell, index) => (PHONE_HEADER.test(headerName(cell)) ? [index] : []));
  const startsWithData = first.some((cell) => phoneDigits(cell).length >= 10);
  if (!found.length && !startsWithData && first.some((cell) => /\p{L}/u.test(cell))) {
    throw new Error("Lista nao-contatar sem coluna de telefone.");
  }
  const columns = found.length ? found : [0];
  for (const line of found.length ? lines.slice(1) : lines) {
    const cells = csvCells(line);
    const inColumn = columns.map((column) => phoneDigits(cells[column] ?? "")).filter((digits) => digits.length >= 8);
    const numbers = inColumn.length ? inColumn : cells.map(phoneDigits).filter((digits) => digits.length >= 10);
    if (!numbers.length) throw new Error("Lista nao-contatar com linha ilegível.");
    for (const digits of numbers) keys.add(numberKey(digits));
  }
  return { keys, columns, delimiter };
}

/** As chaves de nao-contatar.csv. Lista ilegível ou ausente lança: sem a lista, nada é proposto nem enviado. */
export function readDoNotContact(file) {
  return parseDoNotContact(readFileSync(file, "utf8")).keys;
}

/** Um campo de CSV que uma planilha não executa e que não quebra a linha. */
export function csvField(value) {
  const flat = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  const safe = /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
  return /[",;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Só acrescenta. Uma linha por número, no separador e na coluna que o arquivo já usa. */
export function appendDoNotContact(file, { numero, empresa = "", motivo, at }) {
  const digits = String(numero ?? "").replace(/\D/g, "");
  if (digits.length < 8) throw new Error("Número inválido.");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const { keys, columns, delimiter } = parseDoNotContact(current);
  if (keys.has(numberKey(digits))) return false;
  const start = !current.trim() ? `${CSV_HEADER}\n` : current.endsWith("\n") ? "" : "\n";
  const cells = [csvField(empresa), csvField(at), csvField(motivo)];
  while (cells.length < columns[0]) cells.push("");
  cells.splice(columns[0], 0, digits);
  appendFileSync(file, `${start}${cells.join(delimiter)}\n`, { mode: 0o600 });
  return true;
}

/** Vale para a proposta, para a edição no painel e de novo logo antes do envio. */
export function checkFollowUpText(text, { chatId, instructionTexts = [] } = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return { ok: false, motivo: "texto_vazio" };
  if (value.length > FOLLOW_UP_MAX_TEXT) return { ok: false, motivo: "texto_longo" };
  if (hasHandoffMarker(value)) return { ok: false, motivo: "marcador_humano" };
  if (hasRedactedAnswer(value)) return { ok: false, motivo: "texto_barrado" };
  const verdict = filterOutbound(value, { chatId, instructionTexts });
  return verdict.ok ? { ok: true, texto: value } : { ok: false, motivo: "texto_barrado" };
}

export function instructionTextsOf(file) {
  if (!file) return [];
  try {
    return [readFileSync(file, "utf8")];
  } catch {
    return [];
  }
}

export const approvalKeyFile = (queueFile) => join(dirname(queueFile), APPROVAL_KEY_FILE);

/** A chave do selo, ou null. Quem só confere não cria: sem a chave, nada sai. */
export function readApprovalKey(file) {
  try {
    const key = readFileSync(file, "utf8").trim();
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

function ensureApprovalKey(file) {
  const current = readApprovalKey(file);
  if (current) return current;
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const created = readApprovalKey(file);
  if (!created) throw new Error("Chave de aprovação indisponível.");
  return created;
}

const approvalSeal = (key, { id, numero, chatId, texto }) =>
  createHmac("sha256", key)
    .update(JSON.stringify([id, numero, chatId, texto]))
    .digest("hex");

/** O item ainda é o que foi aprovado? Sem chave ou sem selo, a resposta é não. */
export function approvalIsValid(key, item) {
  if (!key || typeof item?.selo !== "string") return false;
  const expected = Buffer.from(approvalSeal(key, item));
  const actual = Buffer.from(item.selo);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const emptyQueue = () => ({ versao: 1, proximoEnvioEm: 0, itens: [] });

/** Arquivo ausente é fila vazia. Arquivo corrompido lança: gravar por cima apagaria o que já foi enviado. */
export function readFollowUpQueue(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyQueue();
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || !Array.isArray(value.itens))
    throw new Error("Fila de follow-up inválida.");
  return { ...emptyQueue(), ...value };
}

function withLock(file, action) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    } catch {
      // Outro processo soltou a trava agora.
    }
    if (Date.now() > deadline) throw new Error("A fila de follow-up está ocupada.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * O agente, o painel e a ponte são processos separados. Toda mudança relê a fila dentro da trava: sem isso, um painel
 * com leitura antiga poderia devolver um item enviado para "aprovada" e reenviá-lo.
 */
export function updateFollowUpQueue(file, mutate) {
  return withLock(file, () => {
    const queue = readFollowUpQueue(file);
    const before = JSON.stringify(queue);
    const result = mutate(queue);
    if (JSON.stringify(queue) !== before) writePrivate(file, queue);
    return result;
  });
}

const hash = (value, size) => createHash("sha256").update(String(value)).digest("hex").slice(0, size);

/**
 * O ID e o request_id vêm só do número e da tentativa: refazer a fila nunca gera um segundo envio pelo mesmo número
 * no motor. Só uma falha definida abre uma tentativa nova.
 */
export const followUpId = (numero, tentativa = 1) =>
  `fu-${hash(tentativa > 1 ? `${numberKey(numero)}#${tentativa}` : numberKey(numero), 16)}`;
export const followUpRequestId = (id) => `wc-fu-${hash(id, 16)}`;

const clean = (value, limit) =>
  [...String(value ?? "")]
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .trim()
    .slice(0, limit);

/** Motivo para não contatar este número agora, ou null. */
export function blockedReason(
  { numero, chatId },
  { doNotContact, stopped = [], excludes = [], internalContacts = [] },
) {
  const key = numberKey(numero);
  if (doNotContact.has(key)) return "nao_contatar";
  const same = (id) => id === chatId || (chatDigits(id) && numberKey(chatDigits(id)) === key);
  if (stopped.some(same)) return "nao_contatar";
  if (excludes.some(same)) return "nao_contatar";
  if (internalContacts.some(same)) return "contato_interno";
  return null;
}

/** Só acrescenta uma "proposta". Nada aqui aprova nem envia. */
export function addProposal(file, args, { blocks, instructionTexts = [], now = Date.now } = {}) {
  const number = normalizeNumber(args?.numero);
  if (!number.ok) return { ok: false, motivo: number.motivo };
  const text = checkFollowUpText(args?.texto, { chatId: number.chatId, instructionTexts });
  if (!text.ok) return { ok: false, motivo: text.motivo };
  const motivo = clean(args?.motivo, 300);
  if (!motivo) return { ok: false, motivo: "motivo_vazio" };
  const blocked = blockedReason(number, blocks);
  if (blocked) return { ok: false, motivo: blocked };
  return updateFollowUpQueue(file, (queue) => {
    const previous = queue.itens.filter((item) => numberKey(item.numero) === numberKey(number.numero));
    // Só "falhou" sem dúvida: o motor recusou e nada saiu. Um envio incerto nunca volta.
    const failed = previous.length === 1 && previous[0].status === "falhou" && previous[0].incerto !== true;
    if (previous.length && !failed) return { ok: false, motivo: "duplicado" };
    if (queue.itens.filter((item) => item.status === "proposta").length >= MAX_OPEN_PROPOSALS) {
      return { ok: false, motivo: "fila_cheia" };
    }
    const tentativa = failed ? (previous[0].tentativa ?? 1) + 1 : 1;
    const id = followUpId(number.numero, tentativa);
    const replacement = {
      id,
      ...(tentativa > 1 ? { tentativa } : {}),
      // O escopo que a tentativa anterior ainda não tirou continua sendo desfeito pela ponte.
      ...(failed && previous[0].escopoAdicionado === true ? { escopoAdicionado: true } : {}),
      numero: number.numero,
      chatId: number.chatId,
      nome: clean(args?.nome, 120),
      nicho: clean(args?.nicho, 80),
      texto: text.texto,
      motivo,
      status: "proposta",
      criadaEm: new Date(now()).toISOString(),
      aprovadaEm: null,
      enviadaEm: null,
      ...(number.aviso ? { avisoNumero: number.aviso } : {}),
    };
    if (failed) queue.itens[queue.itens.indexOf(previous[0])] = replacement;
    else queue.itens.push(replacement);
    return { ok: true, id, status: "proposta", ...(number.aviso ? { aviso: number.aviso } : {}) };
  });
}

const sameDay = (left, right) => new Date(left).toDateString() === new Date(right).toDateString();

export const sentToday = (queue, time) =>
  queue.itens.filter((item) => item.enviadaEm && sameDay(Date.parse(item.enviadaEm), time)).length;

const countByStatus = (queue) => {
  const counts = { proposta: 0, aprovada: 0, enviada: 0, recusada: 0, falhou: 0, respondeu: 0 };
  for (const item of queue.itens) if (item.status in counts) counts[item.status] += 1;
  return counts;
};

/** O que o agente pode fazer agora, em palavras simples: o dono pergunta no chat e o agente responde daqui. */
function agentGuidance(settings, counts, left, time) {
  const hours = `de segunda a sexta, das ${settings.inicio} às ${settings.fim}`;
  if (!settings.ativo) {
    return {
      situacao: "desligado",
      mensagem:
        "O follow-up está desligado no painel do dono. Você pode propor, mas nada será aprovado nem enviado até ele ligar.",
    };
  }
  const limit = `Restam ${left} de ${settings.limiteDia} envios hoje, ${hours}.`;
  const closed = insideFollowUpHours(settings, time) ? "" : " Agora está fora do horário: o envio espera.";
  if (settings.autonomia === "auto") {
    return {
      situacao: "automatico",
      mensagem: `Automático: o que você propõe e passa em todos os filtros sai sem aprovação, um por vez, dentro dos limites. ${limit}${closed}`,
    };
  }
  return {
    situacao: "precisa_aprovacao",
    mensagem: `Cada proposta precisa da aprovação do dono no painel. ${counts.proposta} aguardando aprovação e ${counts.aprovada} aprovada(s) esperando o envio. ${limit}${closed}`,
  };
}

/** O que o agente pode ver: contagens e o estado das propostas, sem nome, texto, número inteiro ou histórico. */
export function listForAgent(queue, settings, time) {
  const contagem = countByStatus(queue);
  const enviadasHoje = sentToday(queue, time);
  const restamHoje = Math.max(0, settings.limiteDia - enviadasHoje);
  return {
    ...agentGuidance(settings, contagem, restamHoje, time),
    ativo: settings.ativo,
    autonomia: settings.autonomia,
    limiteDia: settings.limiteDia,
    enviadasHoje,
    restamHoje,
    contagem,
    propostas: queue.itens.map((item) => ({
      id: item.id,
      numero: maskNumber(item.numero),
      nicho: item.nicho,
      status: item.status,
    })),
  };
}

/** O que o painel mostra. Só o dono abre o painel, e ele precisa ver para quem vai a mensagem. */
export function panelView(queue, settings, time) {
  const open = queue.itens.filter((item) => item.status === "proposta" || item.status === "aprovada");
  const closed = queue.itens.filter((item) => item.status !== "proposta" && item.status !== "aprovada");
  return {
    ativo: settings.ativo,
    autonomia: settings.autonomia,
    limiteDia: settings.limiteDia,
    inicio: settings.inicio,
    fim: settings.fim,
    enviadasHoje: sentToday(queue, time),
    contagem: countByStatus(queue),
    itens: open.map((item) => ({
      id: item.id,
      numero: `+${item.numero}`,
      nome: item.nome,
      nicho: item.nicho,
      motivo: item.motivo,
      texto: item.texto,
      status: item.status,
      avisoNumero: item.avisoNumero ?? null,
    })),
    recentes: closed.slice(-10).map((item) => ({
      id: item.id,
      nome: item.nome,
      status: item.status,
      incerto: item.incerto === true,
      motivoFalha: item.motivoFalha ?? item.motivoRecusa ?? null,
    })),
    ultimasEnviadas: queue.itens
      .filter((item) => item.enviadaEm)
      .sort((a, b) => String(b.enviadaEm).localeCompare(String(a.enviadaEm)))
      .slice(0, 10)
      .map((item) => ({
        id: item.id,
        numero: `+${item.numero}`,
        nome: item.nome,
        texto: item.texto,
        enviadaEm: item.enviadaEm,
        status: item.status,
        incerto: item.incerto === true,
        automatica: item.aprovadaPor === "auto",
      })),
  };
}

const EDITABLE = new Set(["proposta", "aprovada"]);

/** Salva o texto editado. Passa de novo pelo filtro e nunca muda o que já saiu da fila. */
export function editItemText(file, { id, texto }, { instructionTexts = [] } = {}) {
  return updateFollowUpQueue(file, (queue) => {
    const item = queue.itens.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, motivo: "nao_encontrado" };
    if (!EDITABLE.has(item.status)) return { ok: false, motivo: "ja_processado" };
    const text = checkFollowUpText(texto, { chatId: item.chatId, instructionTexts });
    if (!text.ok) return { ok: false, motivo: text.motivo };
    item.texto = text.texto;
    if (item.status === "aprovada") item.selo = approvalSeal(ensureApprovalKey(approvalKeyFile(file)), item);
    return { ok: true };
  });
}

/**
 * Aprova o texto que está na tela. Só uma "proposta" vira "aprovada", e só aqui, com o selo de id, número, conversa e
 * texto. Chamam isto só a rota do painel e a ponte no modo "auto"; o agente não tem caminho até aqui.
 */
export function approveItems(file, entries, { blocks, instructionTexts = [], now = Date.now, por = "dono" } = {}) {
  const key = ensureApprovalKey(approvalKeyFile(file));
  return updateFollowUpQueue(file, (queue) => {
    const results = [];
    for (const entry of Array.isArray(entries) ? entries.slice(0, MAX_OPEN_PROPOSALS) : []) {
      const item = queue.itens.find((candidate) => candidate.id === entry?.id);
      const fail = (motivo) => results.push({ id: entry?.id, ok: false, motivo });
      if (!item) {
        fail("nao_encontrado");
        continue;
      }
      if (item.status !== "proposta") {
        fail("ja_processado");
        continue;
      }
      const text = checkFollowUpText(typeof entry.texto === "string" ? entry.texto : item.texto, {
        chatId: item.chatId,
        instructionTexts,
      });
      if (!text.ok) {
        fail(text.motivo);
        continue;
      }
      const blocked = blockedReason(item, blocks);
      if (blocked) {
        fail(blocked);
        continue;
      }
      item.texto = text.texto;
      item.status = "aprovada";
      item.aprovadaEm = new Date(now()).toISOString();
      item.aprovadaPor = por;
      item.selo = approvalSeal(key, item);
      results.push({ id: item.id, ok: true });
    }
    return { ok: results.every((result) => result.ok), resultados: results };
  });
}

export function rejectItem(file, id) {
  return updateFollowUpQueue(file, (queue) => {
    const item = queue.itens.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, motivo: "nao_encontrado" };
    if (!EDITABLE.has(item.status)) return { ok: false, motivo: "ja_processado" };
    item.status = "recusada";
    item.motivoRecusa = "dono";
    return { ok: true };
  });
}

/** O que barra um número agora. Lança se nao-contatar.csv não puder ser lido. */
export function loadBlocks(settings, stateFile) {
  let stopped = [];
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (Array.isArray(state.stopped)) stopped = state.stopped;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    doNotContact: readDoNotContact(settings.followUp.naoContatarArquivo),
    stopped,
    excludes: settings.excludes,
    internalContacts: settings.internoTambemCliente ? [] : settings.internalContacts,
  };
}

export const FOLLOW_UP_TOOLS = [
  {
    name: "propor_follow_up",
    description:
      "Propõe uma mensagem de follow-up. A ferramenta não envia: só a ponte envia, depois da aprovação do dono ou, se ele escolheu o modo automático no painel, depois de todos os filtros. Recusa números de nao-contatar, números já propostos, grupos, números inválidos e texto barrado pelo filtro, vazio ou com mais de 600 caracteres. Use listar_follow_up para saber o que vale agora.",
    inputSchema: {
      type: "object",
      properties: {
        numero: {
          type: "string",
          description: "Número do Brasil, com DDD. Copie como está; não invente o nono dígito.",
        },
        nome: { type: "string", description: "Nome da empresa ou da pessoa." },
        nicho: { type: "string" },
        texto: { type: "string", description: "A mensagem inteira, com até 600 caracteres." },
        motivo: {
          type: "string",
          description: "A razão real para falar com este contato. O dono lê antes de aprovar.",
        },
      },
      required: ["numero", "nome", "nicho", "texto", "motivo"],
    },
  },
  {
    name: "listar_follow_up",
    description:
      "Diz em palavras simples o que você pode fazer agora (desligado, precisa de aprovação ou automático, e quantos envios restam hoje), com as contagens da fila e o estado das propostas, sem texto, nome ou histórico. A aprovação e o modo só mudam no painel do dono.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const isFollowUpTool = (name) => FOLLOW_UP_TOOLS.some((tool) => tool.name === name);

/** As ferramentas do agente: valem com as de envio desligadas. Devolve { texto, erro }. */
export function callFollowUpTool(name, args, { queueFile, stateFile, readSettings, now = Date.now }) {
  const settings = readSettings();
  if (name === "listar_follow_up") {
    return {
      texto: JSON.stringify(listForAgent(readFollowUpQueue(queueFile), settings.followUp, now())),
      erro: false,
    };
  }
  let blocks;
  try {
    blocks = loadBlocks(settings, stateFile);
  } catch {
    return { texto: JSON.stringify({ ok: false, motivo: "lista_nao_contatar_indisponivel" }), erro: true };
  }
  const result = addProposal(queueFile, args, {
    blocks,
    instructionTexts: instructionTextsOf(settings.instructionsFile),
    now,
  });
  return { texto: JSON.stringify(result), erro: result.ok !== true };
}

/**
 * As rotas do painel. O chamador já conferiu o endereço local e o segredo, como nas outras rotas. Devolve
 * { status, value }, ou null se o caminho não é desta fila.
 */
export function handleFollowUpRoute(
  method,
  path,
  body,
  { queueFile, stateFile, readSettings, saveSettings, now = Date.now },
) {
  if (path !== "/follow-up" && !path.startsWith("/follow-up/")) return null;
  const settings = readSettings();
  if (method === "GET" && path === "/follow-up") {
    return { status: 200, value: panelView(readFollowUpQueue(queueFile), settings.followUp, now()) };
  }
  if (method !== "POST") return { status: 404, value: { error: "Não encontrado." } };
  const instructionTexts = instructionTextsOf(settings.instructionsFile);
  const answer = (result) => ({ status: result.ok ? 200 : 400, value: result });
  if (path === "/follow-up/config") {
    const start = minutesOf(body.inicio);
    const end = minutesOf(body.fim);
    if (start === null || end === null || start >= end) {
      return { status: 400, value: { error: "O horário de início precisa ser antes do fim." } };
    }
    const saved = saveSettings({
      followUp: { ativo: body.ativo === true, limiteDia: body.limiteDia, inicio: body.inicio, fim: body.fim },
    });
    return { status: 200, value: { ok: true, ...saved.followUp, naoContatarArquivo: undefined } };
  }
  if (path === "/follow-up/autonomia") {
    if (body.autonomia !== "auto" && body.autonomia !== "aprovar") {
      return { status: 400, value: { error: "Modo inválido." } };
    }
    if (body.autonomia === "auto" && body.confirmo !== true) {
      return { status: 400, value: { error: "Confirme o risco de banimento para ligar o modo automático." } };
    }
    const saved = saveSettings({ followUp: { autonomia: body.autonomia } });
    return { status: 200, value: { ok: true, autonomia: saved.followUp.autonomia } };
  }
  if (path === "/follow-up/texto") return answer(editItemText(queueFile, body, { instructionTexts }));
  if (path === "/follow-up/recusar") return answer(rejectItem(queueFile, body.id));
  if (path === "/follow-up/aprovar") {
    let blocks;
    try {
      blocks = loadBlocks(settings, stateFile);
    } catch {
      return { status: 400, value: { error: "A lista nao-contatar.csv não pôde ser lida. Nada foi aprovado." } };
    }
    return answer(approveItems(queueFile, body.itens, { blocks, instructionTexts, now }));
  }
  return { status: 404, value: { error: "Não encontrado." } };
}

/**
 * Soma uma conversa ao escopo do motor por PUT /scope, que grava settings.json e content-policy.json e reinicia a
 * sessão. Mantém as que já estão e nunca muda o modo. `beforePut` roda só quando o PUT vai acontecer.
 */
export async function widenEngineScope(control, chatId, beforePut) {
  if (!/@s\.whatsapp\.net$/.test(String(chatId))) throw new Error("Só conversa de pessoa entra por aqui.");
  const scope = (await control("GET", "/state"))?.scope;
  if (scope?.mode === "all") return { added: false };
  if (scope?.mode !== "selected" || !Array.isArray(scope.chat_ids)) throw new Error("Escopo do motor indisponível.");
  if (scope.chat_ids.includes(chatId)) return { added: false };
  // Grava antes: uma queda depois do PUT não pode deixar a conversa no escopo sem dono.
  beforePut?.();
  await control("PUT", "/scope", { mode: "selected", chat_ids: [...scope.chat_ids, chatId] });
  return { added: true };
}

/** Desfaz só o que `widenEngineScope` somou, quando a mensagem não saiu. */
export async function narrowEngineScope(control, chatId) {
  const scope = (await control("GET", "/state"))?.scope;
  if (scope?.mode !== "selected" || !Array.isArray(scope.chat_ids) || !scope.chat_ids.includes(chatId)) return;
  await control("PUT", "/scope", { mode: "selected", chat_ids: scope.chat_ids.filter((id) => id !== chatId) });
}

/** O motor só despacha com a conta ligada e com esta conversa no escopo. */
export function engineAllows(state, chatId) {
  const scope = state?.scope;
  if (!state?.whatsapp?.linked) return false;
  return scope?.mode === "all" || (scope?.mode === "selected" && (scope.chat_ids ?? []).includes(chatId));
}
