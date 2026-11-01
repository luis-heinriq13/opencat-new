// WhatsCat: regras de segurança em código, sem depender do modelo obedecer ao prompt.
// Funções puras: o filtro de saída, as palavras de parada, o horário de silêncio e a menção em grupo.

/** Textos que só existem no invólucro que a ponte monta. Uma resposta com qualquer um deles vazou o invólucro. */
export const WRAPPER_MARKERS = [
  "whatscat_mensagem_nao_confiavel",
  "historicodestecontato",
  "isolamento: este bloco",
  "o json abaixo e uma mensagem",
  "instrucoes do dono para este grupo",
  "aviso interno do whatscat",
];

export const HANDOFF_MARKER = "@@HUMANO@@";
export const DEFAULT_STOP_WORDS = ["pare", "parar", "sair", "não quero", "stop"];

/** Minúsculas, sem acento e sem pontuação: "Não quero!" e "nao quero" são a mesma coisa. */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bghp_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\bAIza[0-9A-Za-z_-]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const LOCAL_PATH = /(?:\/Users\/|~\/\.|\/home\/[a-z]|[A-Za-z]:\\Users\\)/;
const CHAT_ID = /\b\d{5,}(?::\d+)?@(?:s\.whatsapp\.net|lid|g\.us)\b/g;
/** Número com separadores: 10 dígitos ou mais, ou 8 ou mais quando começa com "+". Datas e preços ficam de fora. */
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;

export const digitsOf = (value) => String(value ?? "").replace(/\D/g, "");

/** Os dígitos do número de uma conversa de pessoa. Grupo e @lid não têm número. */
export function chatDigits(chatId) {
  const match = /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(chatId));
  return match ? match[1] : null;
}

const sameNumber = (left, right) => {
  if (!left || !right) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.length >= 8 && longer.endsWith(shorter);
};

const words = (text) => normalizeText(text).split(" ").filter(Boolean);
const SHINGLE = 12;

function shingles(text) {
  const list = words(text);
  const found = new Set();
  for (let index = 0; index + SHINGLE <= list.length; index += 1)
    found.add(list.slice(index, index + SHINGLE).join(" "));
  return found;
}

/**
 * A resposta do agente só sai se passar aqui. Devolve { ok: true } ou { ok: false, reason }.
 * `chatId` é a conversa de destino; `instructionTexts` são os textos que a resposta não pode repetir.
 */
export function filterOutbound(answer, { chatId, instructionTexts = [] } = {}) {
  const text = String(answer ?? "");
  const plain = normalizeText(text);
  if (WRAPPER_MARKERS.some((marker) => plain.includes(normalizeText(marker)))) {
    return { ok: false, reason: "invólucro" };
  }
  if (/<\/?whatscat/i.test(text)) return { ok: false, reason: "invólucro" };
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return { ok: false, reason: "segredo" };
  if (LOCAL_PATH.test(text)) return { ok: false, reason: "caminho_local" };
  const own = chatDigits(chatId);
  const group = String(chatId).endsWith("@g.us");
  for (const match of text.match(CHAT_ID) ?? []) {
    if (match.toLowerCase() === String(chatId).toLowerCase()) continue;
    return { ok: false, reason: "outra_conversa" };
  }
  for (const match of text.match(PHONE) ?? []) {
    const digits = digitsOf(match);
    const long = match.trim().startsWith("+") ? digits.length >= 8 : digits.length >= 10;
    if (!long || digits.length > 15) continue;
    if (!group && sameNumber(digits, own)) continue;
    return { ok: false, reason: group ? "numero_em_grupo" : "outro_numero" };
  }
  // Número colado, sem separador, também conta.
  for (const digits of text.match(/\d{10,15}/g) ?? []) {
    if (!group && sameNumber(digits, own)) continue;
    return { ok: false, reason: group ? "numero_em_grupo" : "outro_numero" };
  }
  const overlap = instructionTexts.filter((item) => typeof item === "string" && item.length > 0);
  if (overlap.length) {
    const mine = shingles(text);
    for (const item of overlap) {
      const theirs = shingles(item);
      for (const piece of mine) if (theirs.has(piece)) return { ok: false, reason: "instrucoes" };
    }
  }
  return { ok: true };
}

export const hasHandoffMarker = (answer) => /\[\[\s*humano\s*\]\]|@@\s*humano\s*@@/i.test(String(answer ?? ""));

/** O filtro de segredos do app apagou parte da resposta. Esse texto nunca pode chegar ao contato. */
export const hasRedactedAnswer = (answer) => /\[redacted-[a-z-]+\]/i.test(String(answer ?? ""));

const STOP_WORD_MAX_WORDS = 8;
const OPT_OUT_MAX_WORDS = 40;
const POLITE =
  "(?:por favor|favor|pf|pfv|pfvr|obrigad[oa]|grat[oa]|oi|ola|bom dia|boa tarde|boa noite|eu|quero|queria|gostaria de|pode|me|ja)";
/** Valem só como a mensagem inteira: "remover" sozinho é um pedido, "como remover a mancha" não é. */
const OPT_OUT_WHOLE = new RegExp(
  `^(?:${POLITE} )*(?:remover|remova|remove|descadastrar|descadastre|descadastra|nao tenho (?:mais )?interesse|sem interesse)(?: ${POLITE})*$`,
);
const OUTREACH = "(?:mensag\\w*|contatos?|propaganda\\w*|promoc\\w*|spam|isso|nada)";
const QUANTIFIER = "(?:(?:mais|nenhuma?|essas?|esses?|estas?|estes?|suas?|seus?) )*";
const LIST = "(?:lista|base|cadastro|contatos|envios?|disparos?|mailing)";
const MY_NUMBER = "(?:meu (?:numero|contato|telefone|celular|whatsapp|cadastro)|este numero|esse numero)";
const FROM_LIST = `d[aeo]s? (?:\\w+ )?${LIST}`;
const CONTACTING = "(?:enviar|mandar|chamar|contatar|ligar|incomodar|escrever|procurar)";
const CONTACT_ME =
  "(?:envie|enviem|mande|mandem|chame|chamem|contate|contatem|procure|procurem|ligue|liguem|escreva|escrevam|incomode|incomodem)";
/** Frases que só um pedido para sair escreve. Cada uma nomeia a mensagem, a lista ou o número da pessoa. */
const OPT_OUT_PHRASES = [
  `\\bnao (?:quero|desejo|preciso|gostaria de|tenho interesse em)(?: mais)? (?:receber|ter) ${QUANTIFIER}${OUTREACH}\\b`,
  "\\bnao (?:quero|desejo|gostaria de)(?: mais)? ser (?:contatad|incomodad|procurad)",
  "\\bnao (?:quero|desejo) mais contato\\b",
  `(?<!nao quero )(?<!nao vou )\\b(?:pare|parem|parar|para|deixe|deixem|deixar) de me ${CONTACTING}\\b`,
  `(?<!nao quero )(?<!nao vou )\\b(?:pare|parem|parar|para|deixe|deixem|deixar) de (?:enviar|mandar|receber) ${QUANTIFIER}${OUTREACH}\\b`,
  "(?<!nao )\\bme (?:remov(?:a|am|e|er)|exclu(?:a|am|i|ir))\\b",
  `(?<!nao )\\b(?:remov|retir|tir|exclu|apag|delet)\\w* ${MY_NUMBER}\\b`,
  `(?<!nao )\\b(?:me (?:remov|retir|tir|exclu)\\w*|(?:remov|retir|tir|exclu)\\w* me) ${FROM_LIST}\\b`,
  `(?<!nao quero )\\bsair ${FROM_LIST}\\b(?! de espera)`,
  "\\bdescadastr\\w*",
  "\\bcancelar (?:a |minha )?inscricao\\b",
  `\\bnao me ${CONTACT_ME}(?: (?:mais|novamente|de novo)\\b| ${QUANTIFIER}${OUTREACH}\\b|$)`,
  "\\bnao (?:entre|entrem) (?:mais )?em contato(?: comigo\\b| mais\\b| novamente\\b|$)",
].map((source) => new RegExp(source));

/**
 * A pessoa pediu para parar? Uma frase de saída explícita vale até em mensagem longa e educada, com qualquer
 * `stopWords`. A palavra solta ("pare", "sair", "não quero") só vale em mensagem curta: em frase longa ela é conversa.
 */
export function matchesStopWord(text, stopWords = DEFAULT_STOP_WORDS) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const count = normalized.split(" ").length;
  if (
    count <= OPT_OUT_MAX_WORDS &&
    (OPT_OUT_WHOLE.test(normalized) || OPT_OUT_PHRASES.some((phrase) => phrase.test(normalized)))
  ) {
    return true;
  }
  if (count > STOP_WORD_MAX_WORDS) return false;
  const padded = ` ${normalized} `;
  return stopWords.map(normalizeText).some((word) => word && padded.includes(` ${word} `));
}

/** "HH:MM" em minutos desde a meia-noite, ou null. */
export function minutesOf(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

/** Horário de silêncio no relógio local. Devolve a chave da janela (a data em que ela começou) ou null. */
export function quietWindow(quiet, time) {
  if (!quiet?.enabled) return null;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return null;
  const date = new Date(time);
  const now = date.getHours() * 60 + date.getMinutes();
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const began = new Date(date);
  if (start > end && now < end) began.setDate(began.getDate() - 1);
  return `${began.getFullYear()}-${began.getMonth() + 1}-${began.getDate()}`;
}

/**
 * O motor não manda dado de menção nas mensagens (os campos são message_id, chat_id, sender_id, from_me,
 * media_type, filename e texto). Por isso a menção é reconhecida por campos de menção, se vierem, ou pelo
 * texto: "@" + número da conta conectada, ou um dos nomes configurados.
 */
export function isMentioned(message, { selfId, names = [] } = {}) {
  const selfDigits = chatDigits(selfId) ?? digitsOf(String(selfId ?? "").split("@")[0]);
  const listed = (message.mentions ?? []).map((item) => digitsOf(String(item).split("@")[0]));
  if (selfDigits && listed.some((digits) => sameNumber(digits, selfDigits))) return true;
  const text = normalizeText(message.text);
  if (selfDigits && text.includes(`@${selfDigits}`)) return true;
  if (selfDigits && selfDigits.length >= 8 && digitsOf(text).includes(selfDigits)) return true;
  const padded = ` ${text.replace(/@/g, " ")} `;
  return names.map(normalizeText).some((name) => name.length >= 2 && padded.includes(` ${name} `));
}

/** Texto do dono (instruções do grupo) entra no bloco sem os marcadores do invólucro e com tamanho limitado. */
export function cleanOwnerText(value, limit = 1000) {
  let text = String(value ?? "").slice(0, limit);
  for (const marker of WRAPPER_MARKERS) text = text.replace(new RegExp(marker, "gi"), "");
  return text.replace(/</g, "(").trim();
}

/** Máscara para mostrar o número conectado: nada além dos dois últimos dígitos. */
export function maskNumber(value) {
  const digits = digitsOf(value);
  if (digits.length < 6) return null;
  return `+${digits.slice(0, Math.min(2, digits.length - 2))} •••• ••${digits.slice(-2)}`;
}
