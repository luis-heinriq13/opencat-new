// OpenAI chat completions to Antigravity `v1internal` and back. Pure functions and one small state
// object for an answer, with no I/O, so the server and the end-to-end script share them.

import { createHash, randomUUID } from "node:crypto";
import { Option, Schema, type Types } from "effect";
import type { ModelFamily, ThoughtSignatureStore } from "./thought-signatures";

/** The prefix of the saved model ids of the `antigravity-pro` endpoint. A bare id also works. */
export const MODEL_ID_PREFIX = "ag/";
/** Gemini documents this value for a tool call whose signature was not produced in this session. */
const NO_SIGNATURE_FALLBACK = "skip_thought_signature_validator";
const MAX_OUTPUT_TOKENS = 64_000;
const CLAUDE_DEFAULT_OUTPUT_TOKENS = 16_384;
const MAX_SCHEMA_DEPTH = 12;
const EFFORT_BUDGET: Readonly<Record<ThinkingLevel, number>> = { low: 8_192, medium: 16_384, high: 32_000 };

type ThinkingLevel = "low" | "medium" | "high";
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export type JsonRecord = Types.Mutable<typeof JsonObject.Type>;

/** The object in a JSON text, or null when the text holds none. */
export function parseJsonObject(text: string): JsonRecord | null {
  return Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))(text));
}

export interface GooglePart extends JsonRecord {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args: unknown };
  functionResponse?: { id?: string; name: string; response: unknown };
}

export interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

export interface GoogleRequest {
  contents: GoogleContent[];
  generationConfig: JsonRecord;
  sessionId: string;
  systemInstruction?: { role: "user"; parts: GooglePart[] };
  tools?: { functionDeclarations: JsonRecord[] }[];
  toolConfig?: { functionCallingConfig: JsonRecord };
}

export interface TranslatedRequest {
  readonly model: string;
  readonly family: ModelFamily;
  readonly request: GoogleRequest;
  /** Sanitized tool name to the name the caller gave, for the names that changed. */
  readonly toolNames: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `ag/gemini-3-flash` and `gemini-3-flash` name one Google model. */
export function upstreamModelId(requested: string): string {
  const bare = requested.startsWith(MODEL_ID_PREFIX) ? requested.slice(MODEL_ID_PREFIX.length) : requested;
  return bare.replace(/\([^()]*\)\s*$/u, "").trim();
}

export function modelFamily(model: string): ModelFamily {
  if (/claude/iu.test(model)) return "claude";
  return /^gemini-/iu.test(model) ? "gemini" : "other";
}

function sanitizeToolName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_.:-]/gu, "_");
  return (/^[a-zA-Z_]/u.test(clean) ? clean : `_${clean}`).slice(0, 64);
}

/** Claude refuses a tool id outside this pattern, and the id comes back through the harness. */
function sanitizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

// ---------------------------------------------------------------------------------------------- //
// Tool schemas: Google takes a small part of JSON Schema, so only that part is copied.

function schemaOfRef(ref: string, root: JsonRecord): JsonRecord | undefined {
  const match = /^#\/(\$defs|definitions)\/(.+)$/u.exec(ref);
  const definitions = match?.[1] ? root[match[1]] : undefined;
  const target = match?.[2] && isRecord(definitions) ? definitions[match[2]] : undefined;
  return isRecord(target) ? target : undefined;
}

function richestVariant(variants: JsonRecord[]): JsonRecord | undefined {
  const score = (variant: JsonRecord) => {
    if (variant.type === "object" || variant.properties) return 3;
    if (variant.type === "array" || variant.items) return 2;
    return variant.type || variant.$ref ? 1 : 0;
  };
  return variants.reduce<JsonRecord | undefined>(
    (best, variant) => (!best || score(variant) > score(best) ? variant : best),
    undefined,
  );
}

function mergeAllOf(schema: JsonRecord, root: JsonRecord): JsonRecord {
  let merged: JsonRecord = { ...schema };
  delete merged.allOf;
  for (const raw of records(schema.allOf)) {
    const part = typeof raw.$ref === "string" ? schemaOfRef(raw.$ref, root) : raw;
    if (!isRecord(part)) continue;
    merged = {
      ...part,
      ...merged,
      properties: {
        ...(isRecord(part.properties) ? part.properties : {}),
        ...(isRecord(merged.properties) ? merged.properties : {}),
      },
      required: [
        ...(Array.isArray(part.required) ? part.required : []),
        ...(Array.isArray(merged.required) ? merged.required : []),
      ],
    };
  }
  return merged;
}

function cleanSchema(input: unknown, root: JsonRecord, depth: number): JsonRecord {
  if (!isRecord(input) || depth > MAX_SCHEMA_DEPTH) return { type: "object", properties: placeholderProperties() };
  let schema = input.allOf ? mergeAllOf(input, root) : input;
  if (typeof schema.$ref === "string") {
    const target = schemaOfRef(schema.$ref, root);
    const { $ref: _ref, ...rest } = schema;
    schema = isRecord(target) ? { ...target, ...rest } : rest;
    return cleanSchema(schema, root, depth + 1);
  }
  let nullable = schema.nullable === true;
  const variants = records(schema.anyOf ?? schema.oneOf);
  if (variants.length > 0) {
    const concrete = variants.filter((variant) => variant.type !== "null");
    nullable ||= concrete.length < variants.length;
    const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
    return {
      ...cleanSchema({ ...richestVariant(concrete), ...rest }, root, depth + 1),
      ...(nullable ? { nullable } : {}),
    };
  }
  let type = schema.type;
  if (Array.isArray(type)) {
    const names = type.filter((name) => name !== "null");
    nullable ||= names.length < type.length;
    type = names.includes("object") && schema.properties ? "object" : (names[0] ?? "string");
  }
  const enumValues = schema.const !== undefined ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : null;
  if (typeof type !== "string") type = schema.properties ? "object" : schema.items ? "array" : "string";
  if (enumValues) type = "string";
  const clean: JsonRecord = { type };
  if (typeof schema.description === "string") clean.description = schema.description;
  if (nullable) clean.nullable = true;
  if (enumValues) clean.enum = enumValues.map(String);
  if (type === "array") clean.items = schema.items ? cleanSchema(schema.items, root, depth + 1) : { type: "string" };
  if (type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    clean.properties =
      names.length > 0
        ? Object.fromEntries(names.map((name) => [name, cleanSchema(properties[name], root, depth + 1)]))
        : placeholderProperties();
    const required = Array.isArray(schema.required) ? schema.required.filter((name) => names.includes(name)) : [];
    if (required.length > 0) clean.required = [...new Set(required)];
  }
  return clean;
}

/** Google refuses an object with no property. The placeholder is optional. */
function placeholderProperties(): JsonRecord {
  return { reason: { type: "string", description: "Why this tool is called." } };
}

function translateTools(body: JsonRecord): {
  tools?: GoogleRequest["tools"];
  toolConfig?: GoogleRequest["toolConfig"];
  names: Map<string, string>;
} {
  const names = new Map<string, string>();
  const seen = new Set<string>();
  const declarations: JsonRecord[] = [];
  for (const tool of records(body.tools)) {
    const fn = isRecord(tool.function) ? tool.function : null;
    const original = stringOf(fn?.name);
    if (!fn || !original) continue;
    const name = sanitizeToolName(original);
    if (seen.has(name)) continue;
    seen.add(name);
    if (name !== original) names.set(name, original);
    const parameters = isRecord(fn.parameters) ? fn.parameters : { type: "object" };
    declarations.push({
      name,
      description: stringOf(fn.description) ?? "",
      parameters: cleanSchema(parameters, parameters, 0),
    });
  }
  if (declarations.length === 0) return { names };
  const choice = body.tool_choice;
  const forced = isRecord(choice) && isRecord(choice.function) ? stringOf(choice.function.name) : undefined;
  const config: JsonRecord =
    choice === "none"
      ? { mode: "NONE" }
      : choice === "required"
        ? { mode: "ANY" }
        : forced
          ? { mode: "ANY", allowedFunctionNames: [sanitizeToolName(forced)] }
          : { mode: "VALIDATED" };
  return { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: config }, names };
}

// ---------------------------------------------------------------------------------------------- //
// Messages

function dataUrlPart(url: string): GooglePart | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) return null;
  const mimeType = url.slice(5, comma).split(";")[0] || "application/octet-stream";
  return { inlineData: { mimeType, data: url.slice(comma + 1) } };
}

function contentParts(content: unknown): GooglePart[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: GooglePart[] = [];
  for (const item of records(content)) {
    const text = stringOf(item.text);
    if (item.type === "text" && text) parts.push({ text });
    const image = isRecord(item.image_url) ? stringOf(item.image_url.url) : undefined;
    if (image) {
      const inline = dataUrlPart(image);
      if (inline) parts.push(inline);
      else if (/^https?:\/\//iu.test(image)) parts.push({ fileData: { fileUri: image, mimeType: "image/*" } });
    }
    const file = isRecord(item.file) ? stringOf(item.file.file_data) : undefined;
    const filePart = file ? dataUrlPart(file) : null;
    if (filePart) parts.push(filePart);
  }
  return parts;
}

function textOf(content: unknown): string {
  return contentParts(content)
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function parseArguments(raw: unknown): JsonRecord {
  if (typeof raw !== "string") return isRecord(raw) ? raw : {};
  return parseJsonObject(raw || "{}") ?? {};
}

function assistantParts(message: JsonRecord, family: ModelFamily, signatures: ThoughtSignatureStore): GooglePart[] {
  const parts = contentParts(message.content);
  let firstCall = true;
  for (const call of records(message.tool_calls)) {
    const fn = isRecord(call.function) ? call.function : null;
    const name = stringOf(fn?.name);
    if (!fn || !name) continue;
    const id = sanitizeToolCallId(stringOf(call.id) ?? `call_${randomUUID().replaceAll("-", "")}`);
    const signature =
      signatures.get(id, family) ?? (firstCall && family === "gemini" ? NO_SIGNATURE_FALLBACK : undefined);
    firstCall = false;
    parts.push({
      functionCall: { id, name: sanitizeToolName(name), args: parseArguments(fn.arguments) },
      ...(signature ? { thoughtSignature: signature } : {}),
    });
  }
  return parts;
}

/**
 * Google needs the turns to alternate, the first to be the user's, and each tool call to be answered
 * in the next turn. A harness that stopped a tool or compacted its history can break each of these.
 */
function repairTurns(input: readonly GoogleContent[]): GoogleContent[] {
  const merged: GoogleContent[] = [];
  for (const content of input) {
    if (content.parts.length === 0) continue;
    const last = merged.at(-1);
    if (last?.role === content.role) last.parts.push(...content.parts);
    else merged.push({ role: content.role, parts: [...content.parts] });
  }
  const repaired: GoogleContent[] = [];
  for (const [index, content] of merged.entries()) {
    if (content.role === "user") {
      // An answer whose call is not in the turn before it: only the text can stay.
      const previous = repaired.at(-1);
      const called = new Set((previous?.parts ?? []).map((part) => part.functionCall?.id).filter(Boolean));
      const parts = content.parts.map((part): GooglePart => {
        const answer = part.functionResponse;
        if (!answer || called.has(answer.id)) return part;
        return { text: `Result of tool ${answer.name}: ${JSON.stringify(answer.response)}` };
      });
      repaired.push({ role: "user", parts });
      continue;
    }
    repaired.push(content);
    const calls = content.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
    if (calls.length === 0) continue;
    const next = merged[index + 1];
    const answered = new Set((next?.parts ?? []).map((part) => part.functionResponse?.id).filter(Boolean));
    const missing: GooglePart[] = calls
      .filter((call) => !answered.has(call.id))
      .map((call) => ({
        functionResponse: { id: call.id, name: call.name, response: { result: "No result was received." } },
      }));
    if (missing.length === 0) continue;
    if (next) next.parts.unshift(...missing);
    else repaired.push({ role: "user", parts: missing });
  }
  if (repaired[0]?.role !== "user") repaired.unshift({ role: "user", parts: [{ text: "..." }] });
  if (repaired.at(-1)?.role === "model") repaired.push({ role: "user", parts: [{ text: "Continue." }] });
  // Claude takes each answer before any text of the same turn.
  for (const content of repaired) {
    if (content.role !== "user" || !content.parts.some((part) => part.functionResponse)) continue;
    content.parts = [
      ...content.parts.filter((part) => part.functionResponse),
      ...content.parts.filter((part) => !part.functionResponse),
    ];
  }
  return repaired;
}

function translateMessages(
  messages: readonly JsonRecord[],
  family: ModelFamily,
  signatures: ThoughtSignatureStore,
): { contents: GoogleContent[]; system: string } {
  const contents: GoogleContent[] = [];
  const system: string[] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) system.push(text);
    } else if (role === "assistant") {
      const parts = assistantParts(message, family, signatures);
      for (const part of parts) {
        if (part.functionCall?.id) callNames.set(part.functionCall.id, part.functionCall.name);
      }
      contents.push({ role: "model", parts });
    } else if (role === "tool") {
      const id = sanitizeToolCallId(stringOf(message.tool_call_id) ?? "");
      const name = callNames.get(id) ?? sanitizeToolName(stringOf(message.name) ?? "tool");
      const parts = contentParts(message.content);
      const text = typeof message.content === "string" ? message.content : textOf(message.content);
      contents.push({
        role: "user",
        parts: [
          { functionResponse: { id, name, response: { result: text } } },
          ...parts.filter((part) => part.text === undefined),
        ],
      });
    } else {
      contents.push({ role: "user", parts: contentParts(message.content) });
    }
  }
  return { contents: repairTurns(contents), system: system.join("\n\n") };
}

// ---------------------------------------------------------------------------------------------- //
// Generation settings

function requestedEffort(model: string, body: JsonRecord): ThinkingLevel | "none" | null {
  const suffix = /-(low|medium|high)$/u.exec(model)?.[1];
  if (suffix === "low" || suffix === "medium" || suffix === "high") return suffix;
  const effort =
    stringOf(body.reasoning_effort) ?? (isRecord(body.reasoning) ? stringOf(body.reasoning.effort) : undefined);
  switch (effort) {
    case "none":
    case "off":
      return "none";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return null;
  }
}

function generationConfig(model: string, family: ModelFamily, body: JsonRecord): JsonRecord {
  const config: JsonRecord = {};
  const effort = requestedEffort(model, body);
  const geminiMajor = Number(/^gemini-(\d+)/u.exec(model)?.[1] ?? 0);
  let budget = 0;
  if (effort && effort !== "none" && family === "gemini" && geminiMajor >= 3) {
    config.thinkingConfig = { thinkingLevel: effort, includeThoughts: true };
  } else if (effort && effort !== "none" && (family === "claude" || family === "gemini")) {
    budget = EFFORT_BUDGET[effort];
    config.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  } else if (effort === "none" && family === "gemini" && geminiMajor < 3) {
    config.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
  }
  // Gemini 4 takes only its own sampling. Claude takes one of the two, and neither with thinking.
  const claudeThinking = family === "claude" && budget > 0;
  if (geminiMajor < 4 && !claudeThinking) {
    if (typeof body.temperature === "number") config.temperature = body.temperature;
    if (typeof body.top_p === "number" && (family !== "claude" || config.temperature === undefined))
      config.topP = body.top_p;
  }
  const asked = body.max_completion_tokens ?? body.max_tokens;
  let maxTokens = typeof asked === "number" && asked > 0 ? Math.floor(asked) : 0;
  if (!maxTokens && family === "claude") maxTokens = CLAUDE_DEFAULT_OUTPUT_TOKENS;
  if (budget >= maxTokens && maxTokens > 0) maxTokens = budget + maxTokens;
  if (maxTokens > 0) config.maxOutputTokens = Math.min(maxTokens, MAX_OUTPUT_TOKENS);
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter(Boolean) : [];
  if (stop.length > 0) config.stopSequences = stop;
  return config;
}

/** The same conversation keeps one session id on one account, which is what keeps Google's cache. */
function sessionIdOf(messages: readonly JsonRecord[], accountKey: string): string {
  const first = messages.find((message) => message.role === "user");
  const system = messages.find((message) => message.role === "system");
  const hash = createHash("sha256")
    .update(`${accountKey}\n${textOf(system?.content)}\n${textOf(first?.content)}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function translateRequest(
  body: JsonRecord,
  messages: readonly JsonRecord[],
  requestedModel: string,
  signatures: ThoughtSignatureStore,
): TranslatedRequest {
  const model = upstreamModelId(requestedModel);
  const family = modelFamily(model);
  const { contents, system } = translateMessages(messages, family, signatures);
  const { tools, toolConfig, names } = translateTools(body);
  return {
    model,
    family,
    toolNames: names,
    request: {
      contents,
      generationConfig: generationConfig(model, family, body),
      sessionId: "",
      ...(system ? { systemInstruction: { role: "user" as const, parts: [{ text: system }] } } : {}),
      ...(tools ? { tools, toolConfig } : {}),
    },
  };
}

/** The whole body for one account. Each account has its own project and its own session id. */
export function googleBody(translated: TranslatedRequest, messages: readonly JsonRecord[], project: string): string {
  return JSON.stringify({
    project,
    model: translated.model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${randomUUID()}`,
    request: { ...translated.request, sessionId: sessionIdOf(messages, project) },
  });
}

// ---------------------------------------------------------------------------------------------- //
// Answers

export interface OpenAiToolCall {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: OpenAiToolCall[];
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(raw: unknown): OpenAiUsage | null {
  if (!isRecord(raw)) return null;
  const prompt = numberOf(raw.promptTokenCount);
  const thoughts = numberOf(raw.thoughtsTokenCount);
  const completion = numberOf(raw.candidatesTokenCount) + thoughts;
  const cached = numberOf(raw.cachedContentTokenCount);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: numberOf(raw.totalTokenCount) || prompt + completion,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(thoughts ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {}),
  };
}

function finishReasonOf(reason: string, sawToolCall: boolean) {
  if (sawToolCall) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  if (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII/u.test(reason)) return "content_filter";
  return "stop";
}

/** The state of one answer: Google's `generateContent` objects in, OpenAI deltas out. */
export class AnswerTranslator {
  readonly #family: ModelFamily;
  readonly #toolNames: ReadonlyMap<string, string>;
  readonly #signatures: ThoughtSignatureStore;
  readonly #usedIds = new Set<string>();
  #pendingSignature: string | null = null;
  #toolCalls = 0;
  #finishReason: string | null = null;
  usage: OpenAiUsage | null = null;

  constructor(translated: TranslatedRequest, signatures: ThoughtSignatureStore) {
    this.#family = translated.family;
    this.#toolNames = translated.toolNames;
    this.#signatures = signatures;
  }

  /** `chunk` is one SSE event or the whole non-streamed answer. */
  feed(chunk: unknown): OpenAiDelta[] {
    if (!isRecord(chunk)) return [];
    const answer = isRecord(chunk.response) ? chunk.response : chunk;
    this.usage = usageOf(answer.usageMetadata) ?? this.usage;
    const candidate = records(answer.candidates)[0];
    if (!candidate) return [];
    if (typeof candidate.finishReason === "string") this.#finishReason = candidate.finishReason;
    const deltas: OpenAiDelta[] = [];
    const content = isRecord(candidate.content) ? candidate.content : null;
    for (const part of records(content?.parts)) {
      const delta = this.#partDelta(part);
      if (delta) deltas.push(delta);
    }
    return deltas;
  }

  #partDelta(part: JsonRecord): OpenAiDelta | null {
    const signature = stringOf(part.thoughtSignature) ?? stringOf(part.thought_signature) ?? null;
    if (isRecord(part.functionCall)) {
      const used = signature ?? this.#pendingSignature;
      this.#pendingSignature = null;
      return { tool_calls: [this.#toolCall(part.functionCall, used)] };
    }
    if (signature) this.#pendingSignature = signature;
    const text = stringOf(part.text);
    if (!text) return null;
    return part.thought === true ? { reasoning_content: text } : { content: text };
  }

  #toolCall(call: JsonRecord, signature: string | null): OpenAiToolCall {
    const sent = stringOf(call.name) ?? "tool";
    const given = stringOf(call.id);
    const clean = given ? sanitizeToolCallId(given) : "";
    const id = clean && !this.#usedIds.has(clean) ? clean : `call_${randomUUID().replaceAll("-", "")}`;
    this.#usedIds.add(id);
    if (signature) this.#signatures.put(id, signature, this.#family);
    return {
      index: this.#toolCalls++,
      id,
      type: "function",
      function: { name: this.#toolNames.get(sent) ?? sent, arguments: JSON.stringify(call.args ?? {}) },
    };
  }

  get finishReason() {
    return finishReasonOf(this.#finishReason ?? "STOP", this.#toolCalls > 0);
  }
}

/** The non-streamed OpenAI answer for one Google answer. */
export function completionOf(
  id: string,
  created: number,
  model: string,
  translator: AnswerTranslator,
  answer: unknown,
) {
  let content = "";
  let reasoning = "";
  const toolCalls: OpenAiToolCall[] = [];
  for (const delta of translator.feed(answer)) {
    content += delta.content ?? "";
    reasoning += delta.reasoning_content ?? "";
    toolCalls.push(...(delta.tool_calls ?? []));
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: translator.finishReason,
      },
    ],
    ...(translator.usage ? { usage: translator.usage } : {}),
  };
}

/** One streamed OpenAI chunk. */
export function chunkOf(
  id: string,
  created: number,
  model: string,
  delta: OpenAiDelta,
  finishReason: string | null = null,
  usage: OpenAiUsage | null = null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}
