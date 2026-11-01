// A small OpenAI-compatible server for the `antigravity-pro` custom endpoint, so that the harness
// reaches the user's Antigravity accounts with no other program in between.
//
// Owned by the main process. It listens only on 127.0.0.1 and refuses a request without its bearer
// or with a Host or Origin that is not this computer, so a web page in a browser cannot reach it,
// through DNS rebinding or otherwise. No log line has a prompt, token or link: only codes and counts.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { findVerificationLink } from "@openbot/user-errors";
import { Effect, Option, Schema } from "effect";
import { ANTIGRAVITY_USER_AGENT, FETCH_MODELS_URL } from "../../backend/antigravity-short-window";
import { type GatewayAccount, GatewayAccounts, type GatewayFetch } from "./accounts";
import { ThoughtSignatureStore } from "./thought-signatures";
import {
  AnswerTranslator,
  chunkOf,
  completionOf,
  googleBody,
  type JsonRecord,
  MODEL_ID_PREFIX,
  parseJsonObject,
  type TranslatedRequest,
  translateRequest,
} from "./translate";

const logger = createOpenBotLogger("antigravity-gateway");

const GOOGLE_API = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY_BYTES = 64 * 1_024 * 1_024;
const MAX_ERROR_TEXT = 1_000;
/** Until Google starts to answer, including one with no stream, which comes whole at the end. */
const ANSWER_START_TIMEOUT_MS = 5 * 60_000;
/** Between two parts of a streamed answer. */
const STREAM_IDLE_TIMEOUT_MS = 3 * 60_000;
const MODELS_TIMEOUT_MS = 15_000;
const MODELS_CACHE_MS = 5 * 60_000;
const DEFAULT_LIMIT_MS = 60_000;
const VALIDATION_LIMIT_MS = 5 * 60_000;
const NO_MODELS: readonly GatewayModel[] = [];

/** A failure that the local caller sees. Only the caller: nothing here goes to a log. */
export class GatewayHttpError extends Schema.TaggedError<GatewayHttpError>()("GatewayHttpError", {
  status: Schema.Number,
  code: Schema.String,
  text: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Number),
}) {}

const ChatBody = Schema.Struct({
  model: Schema.NonEmptyString,
  messages: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  stream: Schema.optional(Schema.Boolean),
});

const ModelsAnswer = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      disabled: Schema.optional(Schema.Boolean),
    }),
  ),
});

export interface GatewayModel {
  readonly id: string;
  readonly name: string;
}

export interface AntigravityGatewayOptions {
  /** The folders of the accounts, in the order to use them. Read at each use. */
  readonly accountHomes: () => readonly string[];
  readonly token: string;
  readonly preferredPort: number;
  readonly fetch?: GatewayFetch;
  readonly now?: () => number;
  /** Limits that tests shorten. */
  readonly answerStartMs?: number;
  readonly streamIdleMs?: number;
}

export function isOfferedModel(id: string): boolean {
  return !/^(tab_|chat_)/u.test(id) && !/image/iu.test(id) && !id.endsWith("-disabled");
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sameToken(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** When Google says that a limit ends, in any of the forms it uses. */
function limitEnd(response: Response, text: string, now: number): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return now + header * 1_000;
  const reset = /"quotaResetTimeStamp"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  const resetMs = reset ? Date.parse(reset) : Number.NaN;
  if (Number.isFinite(resetMs) && resetMs > now) return resetMs;
  const delay = /"retryDelay"\s*:\s*"([\d.]+)s"/u.exec(text)?.[1];
  return now + (delay ? Number(delay) * 1_000 : DEFAULT_LIMIT_MS);
}

function googleMessage(text: string): string {
  const error = parseJsonObject(text)?.error;
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  return message.slice(0, MAX_ERROR_TEXT);
}

function secondsUntil(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1_000));
}

export class AntigravityGateway {
  readonly #options: AntigravityGatewayOptions;
  readonly #fetch: GatewayFetch;
  readonly #now: () => number;
  readonly #accounts: GatewayAccounts;
  readonly #signatures = new ThoughtSignatureStore();
  readonly #running = new Set<AbortController>();
  #server: Server | null = null;
  #port = 0;
  #models: { readonly at: number; readonly list: readonly GatewayModel[] } | null = null;

  constructor(options: AntigravityGatewayOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#accounts = new GatewayAccounts({
      homes: options.accountHomes,
      fetch: this.#fetch,
      now: this.#now,
    });
  }

  get port(): number {
    return this.#port;
  }

  get baseUrl(): string {
    return `http://${LOOPBACK_HOST}:${this.#port}/v1`;
  }

  /** The preferred port when it is free, so the saved address stays the same; else any free port. */
  readonly start = Effect.fn("AntigravityGateway.start")(function* (this: AntigravityGateway) {
    const preferred = yield* this.#listen(this.#options.preferredPort).pipe(Effect.option);
    const server = Option.isSome(preferred) ? preferred.value : yield* this.#listen(0);
    this.#server = server;
    const address = server.address();
    this.#port = typeof address === "object" && address ? address.port : 0;
  });

  #listen(port: number): Effect.Effect<Server, Error> {
    return Effect.callback<Server, Error>((resume) => {
      const server = createServer((request, response) => this.#receive(request, response));
      server.once("error", (cause) => resume(Effect.fail(cause)));
      server.listen(port, LOOPBACK_HOST, () => {
        server.removeAllListeners("error");
        // A listening socket that fails later must not take the main process down.
        server.on("error", () => logger.warn("The local Antigravity gateway socket failed."));
        resume(Effect.succeed(server));
      });
    });
  }

  /** Ends the requests that run, which also cancels them at Google, and closes the socket. */
  readonly stop = Effect.fn("AntigravityGateway.stop")(function* (this: AntigravityGateway) {
    const server = this.#server;
    this.#server = null;
    for (const running of this.#running) running.abort();
    if (!server) return;
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    });
  });

  /**
   * The models each account offers, joined, with the prefix of the saved ids. Null when no account
   * could answer: the caller keeps what it has. An empty list means that no account is signed in.
   */
  readonly models = Effect.fn("AntigravityGateway.models")(function* (this: AntigravityGateway) {
    const cached = this.#models;
    if (cached && this.#now() - cached.at < MODELS_CACHE_MS) return cached.list;
    const accounts = yield* this.#accounts.list();
    if (accounts.length === 0) {
      this.#models = null;
      return NO_MODELS;
    }
    const offered = new Map<string, GatewayModel>();
    let answered = false;
    for (const account of accounts) {
      const list = yield* this.#accountModels(account).pipe(Effect.orElseSucceed(() => null));
      if (!list) continue;
      answered = true;
      for (const model of list) if (!offered.has(model.id)) offered.set(model.id, model);
    }
    if (!answered) return cached?.list ?? null;
    const list = [...offered.values()];
    this.#models = { at: this.#now(), list };
    return this.#models.list;
  });

  #accountModels = Effect.fn("AntigravityGateway.accountModels")(function* (
    this: AntigravityGateway,
    account: GatewayAccount,
  ) {
    const token = yield* this.#accounts.accessToken(account);
    const failed = (cause: unknown) =>
      new GatewayHttpError({
        status: 502,
        code: "upstream_error",
        text: String(cause instanceof Error ? cause.name : ""),
      });
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        this.#fetch(FETCH_MODELS_URL, {
          method: "POST",
          redirect: "error",
          headers: this.#googleHeaders(token),
          body: JSON.stringify({ project: account.auth.project_id }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
        }),
      catch: failed,
    });
    if (!response.ok) return yield* failed(new Error(`HTTP ${response.status}`));
    const answer = yield* Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: failed });
    const decoded = Schema.decodeUnknownOption(ModelsAnswer)(answer);
    if (Option.isNone(decoded)) return yield* failed(new Error("Bad models answer."));
    const entries = Object.entries(decoded.value.models).filter(
      ([id, model]) => isOfferedModel(id) && model.disabled !== true,
    );
    // Google gives some models the name of another model.
    const nameCounts = new Map<string, number>();
    for (const [, model] of entries) {
      if (model.displayName) nameCounts.set(model.displayName, (nameCounts.get(model.displayName) ?? 0) + 1);
    }
    return entries.map(([id, model]): GatewayModel => {
      const name = model.displayName && nameCounts.get(model.displayName) === 1 ? model.displayName : id;
      return { id: `${MODEL_ID_PREFIX}${id}`, name };
    });
  });

  #googleHeaders(token: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": ANTIGRAVITY_USER_AGENT,
    };
  }

  // ------------------------------------------------------------------------------------------ //
  // HTTP

  /** The framework boundary. Nothing that a request does can throw into the main process. */
  #receive(request: IncomingMessage, response: ServerResponse): void {
    const running = new AbortController();
    this.#running.add(running);
    response.on("close", () => {
      // Before the answer ended, this is the caller going away: Google must stop too.
      if (!response.writableFinished) running.abort();
      this.#running.delete(running);
    });
    const served = this.#route(request, response).pipe(
      Effect.catch((error: GatewayHttpError) => Effect.sync(() => this.#sendError(response, error))),
    );
    Effect.runPromise(served, { signal: running.signal }).catch(() => {
      if (!running.signal.aborted) logger.warn("A request to the local Antigravity gateway failed.");
      response.destroy();
    });
  }

  #route(request: IncomingMessage, response: ServerResponse): Effect.Effect<void, GatewayHttpError> {
    const refused = this.#refusal(request);
    if (refused) return Effect.fail(refused);
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === "/v1/models") return this.#serveModels(response);
    if (request.method === "POST" && path === "/v1/chat/completions") return this.#serveChat(request, response);
    return Effect.fail(new GatewayHttpError({ status: 404, code: "not_found", text: "Not found." }));
  }

  /** In this order, so that a page in a browser learns nothing, not even whether a token is right. */
  #refusal(request: IncomingMessage): GatewayHttpError | null {
    const forbidden = new GatewayHttpError({ status: 403, code: "forbidden", text: "Forbidden." });
    const host = URL.parse(`http://${firstHeader(request.headers.host) ?? ""}`);
    if (!host || !LOOPBACK_NAMES.has(host.hostname) || Number(host.port) !== this.#port) return forbidden;
    const origin = firstHeader(request.headers.origin);
    if (origin !== undefined) {
      const parsed = URL.parse(origin);
      if (!parsed || !LOOPBACK_NAMES.has(parsed.hostname)) return forbidden;
    }
    const bearer = /^Bearer (.+)$/u.exec(firstHeader(request.headers.authorization) ?? "")?.[1] ?? "";
    if (!sameToken(bearer, this.#options.token))
      return new GatewayHttpError({ status: 401, code: "invalid_api_key", text: "Invalid bearer token." });
    return null;
  }

  #sendError(response: ServerResponse, error: GatewayHttpError): void {
    if (response.headersSent) {
      this.#writeEvent(response, { error: { message: error.text, code: error.code } });
      response.end();
      return;
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (error.retryAfterSeconds !== undefined) headers["Retry-After"] = String(error.retryAfterSeconds);
    response.writeHead(error.status, headers);
    response.end(JSON.stringify({ error: { message: error.text, type: error.code, code: error.code } }));
  }

  #writeEvent(response: ServerResponse, event: unknown): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  #serveModels = Effect.fn("AntigravityGateway.serveModels")(function* (
    this: AntigravityGateway,
    response: ServerResponse,
  ) {
    const models = yield* this.models().pipe(Effect.orElseSucceed(() => null));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: (models ?? []).map((model) => ({
          id: model.id,
          object: "model",
          owned_by: "antigravity",
          name: model.name,
        })),
      }),
    );
  });

  #readBody(request: IncomingMessage): Effect.Effect<string, GatewayHttpError> {
    return Effect.tryPromise({
      try: async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          size += buffer.length;
          if (size > MAX_BODY_BYTES) throw new RangeError();
          chunks.push(buffer);
        }
        return Buffer.concat(chunks).toString("utf8");
      },
      catch: (cause) =>
        cause instanceof RangeError
          ? new GatewayHttpError({ status: 413, code: "request_too_large", text: "The request is too large." })
          : new GatewayHttpError({
              status: 400,
              code: "invalid_request_error",
              text: "The request could not be read.",
            }),
    });
  }

  #serveChat = Effect.fn("AntigravityGateway.serveChat")(function* (
    this: AntigravityGateway,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const parsed = parseJsonObject(yield* this.#readBody(request));
    const decoded = Schema.decodeUnknownOption(ChatBody)(parsed);
    if (!parsed || Option.isNone(decoded)) {
      return yield* new GatewayHttpError({
        status: 400,
        code: "invalid_request_error",
        text: "The body needs a model and messages.",
      });
    }
    const { model: requested, messages, stream } = decoded.value;
    const translated = translateRequest({ ...parsed }, messages, requested, this.#signatures);
    const opened = yield* this.#openAnswer(translated, messages, stream === true);
    if (stream === true) yield* this.#pipeStream(opened, translated, requested, response);
    else yield* this.#sendWhole(opened, translated, requested, response);
  });

  // ------------------------------------------------------------------------------------------ //
  // Google, with the choice of account

  /**
   * The first account that accepts the request. A limit or a verification moves to the next account.
   * Any other refusal is about the request, so another account would refuse it too.
   */
  #openAnswer = Effect.fn("AntigravityGateway.openAnswer")(function* (
    this: AntigravityGateway,
    translated: TranslatedRequest,
    messages: readonly JsonRecord[],
    stream: boolean,
  ) {
    const accounts = yield* this.#accounts.list().pipe(Effect.orElseSucceed(() => []));
    if (accounts.length === 0) {
      return yield* new GatewayHttpError({
        status: 503,
        code: "no_account",
        text: sourceText("error.provider.antigravityNoAccount"),
      });
    }
    let soonest: number | null = null;
    let validation: GatewayHttpError | null = null;
    let refusal: GatewayHttpError | null = null;
    let tokenFailures = 0;
    for (const account of this.#accounts.ordered(accounts)) {
      const limited = this.#accounts.limitedUntil(account, translated.model);
      if (limited !== null) {
        soonest = soonest === null ? limited : Math.min(soonest, limited);
        continue;
      }
      const attempt = yield* this.#attempt(account, translated, messages, stream);
      if (attempt.kind === "ok") {
        this.#accounts.markWorking(account);
        return attempt.response;
      }
      if (attempt.kind === "limited") {
        this.#accounts.markLimited(account, translated.model, attempt.until);
        soonest = soonest === null ? attempt.until : Math.min(soonest, attempt.until);
        logger.info("An Antigravity account reached a limit; trying the next one.");
      } else if (attempt.kind === "refused") {
        // This account may lack the model or the right to it; another account may have it.
        refusal ??= attempt.error;
      } else if (attempt.kind === "validation") {
        this.#accounts.markLimited(account, translated.model, this.#now() + VALIDATION_LIMIT_MS);
        validation = attempt.error;
      } else {
        tokenFailures += 1;
      }
    }
    if (validation) return yield* validation;
    if (soonest !== null) {
      return yield* new GatewayHttpError({
        status: 429,
        code: "rate_limit_exceeded",
        text: sourceText("error.provider.antigravityLimit"),
        retryAfterSeconds: secondsUntil(soonest, this.#now()),
      });
    }
    if (refusal) return yield* refusal;
    logger.warn(`No Antigravity account gave an access token (${tokenFailures}).`);
    return yield* new GatewayHttpError({
      status: 503,
      code: "no_account",
      text: sourceText("error.provider.antigravityNoAccount"),
    });
  });

  #attempt = Effect.fn("AntigravityGateway.attempt")(function* (
    this: AntigravityGateway,
    account: GatewayAccount,
    translated: TranslatedRequest,
    messages: readonly JsonRecord[],
    stream: boolean,
  ) {
    const body = googleBody(translated, messages, account.auth.project_id);
    const url = `${GOOGLE_API}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    let response: Response | null = null;
    // An access token can end early. One new token is the only repeat here.
    for (let tries = 0; tries < 2; tries += 1) {
      const token = yield* this.#accounts.accessToken(account).pipe(Effect.option);
      if (Option.isNone(token)) return { kind: "no-token" } as const;
      response = yield* this.#postGoogle(url, token.value, body);
      if (response.status !== 401) break;
      yield* Effect.tryPromise({ try: () => response?.text() ?? Promise.resolve(""), catch: () => null }).pipe(
        Effect.ignore,
      );
      this.#accounts.forgetToken(account);
    }
    if (!response) return { kind: "no-token" } as const;
    if (response.ok) return { kind: "ok", response } as const;
    const failed = response;
    const text = yield* Effect.tryPromise({ try: () => failed.text(), catch: () => null }).pipe(
      Effect.orElseSucceed(() => ""),
    );
    logger.info(`Google answered HTTP ${failed.status} for an Antigravity request.`);
    if (failed.status === 429) return { kind: "limited", until: limitEnd(failed, text, this.#now()) } as const;
    if (failed.status === 403 && text.includes("VALIDATION_REQUIRED")) {
      const link = findVerificationLink(text)?.url ?? "https://accounts.google.com/";
      const error = new GatewayHttpError({
        status: 403,
        code: "validation_required",
        text: sourceText("error.provider.antigravityValidation", { url: link }),
      });
      return { kind: "validation", error } as const;
    }
    const detail = googleMessage(text);
    const error = new GatewayHttpError({
      // A 401 from Google must not read as a wrong key for the local caller.
      status: failed.status === 401 ? 502 : failed.status,
      code: failed.status >= 500 || failed.status === 401 ? "upstream_error" : "invalid_request_error",
      text: sourceText("error.provider.antigravityFailed", { status: failed.status, detail }),
    });
    if (failed.status === 401 || failed.status === 403 || failed.status === 404)
      return { kind: "refused", error } as const;
    return yield* error;
  });

  #postGoogle(url: string, token: string, body: string): Effect.Effect<Response, GatewayHttpError> {
    return Effect.tryPromise({
      // The deadline is for the headers only: a stream may run longer, and the body has its own idle limit.
      try: async (signal) => {
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), this.#options.answerStartMs ?? ANSWER_START_TIMEOUT_MS);
        try {
          return await this.#fetch(url, {
            method: "POST",
            redirect: "error",
            headers: this.#googleHeaders(token),
            body,
            signal: AbortSignal.any([signal, deadline.signal]),
          });
        } finally {
          clearTimeout(timer);
        }
      },
      catch: () =>
        new GatewayHttpError({
          status: 504,
          code: "upstream_error",
          text: sourceText("error.provider.antigravityUnreachable"),
        }),
    });
  }

  #sendWhole = Effect.fn("AntigravityGateway.sendWhole")(function* (
    this: AntigravityGateway,
    google: Response,
    translated: TranslatedRequest,
    requested: string,
    response: ServerResponse,
  ) {
    const answer = yield* Effect.tryPromise({
      try: (): Promise<unknown> => google.json(),
      catch: () =>
        new GatewayHttpError({
          status: 502,
          code: "upstream_error",
          text: sourceText("error.provider.antigravityUnreachable"),
        }),
    });
    const translator = new AnswerTranslator(translated, this.#signatures);
    const completion = completionOf(
      `chatcmpl-${randomUUID()}`,
      Math.floor(this.#now() / 1_000),
      requested,
      translator,
      answer,
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(completion));
  });

  /**
   * The answer reaches the caller as it comes. The status is already 200 here, so a failure in the
   * middle goes to the caller as an `error` event, which is what OpenAI clients read.
   */
  #pipeStream = Effect.fn("AntigravityGateway.pipeStream")(function* (
    this: AntigravityGateway,
    google: Response,
    translated: TranslatedRequest,
    requested: string,
    response: ServerResponse,
  ) {
    const reader = google.body?.getReader();
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(this.#now() / 1_000);
    const translator = new AnswerTranslator(translated, this.#signatures);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    this.#writeEvent(response, chunkOf(id, created, requested, { role: "assistant" }));
    let failed = false;
    /** False after an error event: the answer is over, and the caller must not read it as complete. */
    const onEvent = (data: string): boolean => {
      const event = parseJsonObject(data);
      if (event?.error) {
        failed = true;
        this.#writeEvent(response, {
          error: { message: googleMessage(data), code: "upstream_error" },
        });
        return false;
      }
      for (const delta of translator.feed(event)) this.#writeEvent(response, chunkOf(id, created, requested, delta));
      return true;
    };
    yield* Effect.tryPromise({
      try: async (signal) => {
        if (reader) await readEvents(reader, signal, onEvent, this.#options.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS);
      },
      catch: () =>
        new GatewayHttpError({
          status: 504,
          code: "upstream_error",
          text: sourceText("error.provider.antigravityUnreachable"),
        }),
    });
    if (failed) {
      response.end();
      return;
    }
    this.#writeEvent(response, chunkOf(id, created, requested, {}, translator.finishReason, translator.usage));
    response.end("data: [DONE]\n\n");
  });
}

/** Calls `onEvent` with each SSE `data:` line. Stops at the signal or when Google goes silent. */
async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  onEvent: (data: string) => boolean,
  idleMs: number,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  let stopped = false;
  let silent = false;
  const consume = (line: string) => {
    if (stopped || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data && data !== "[DONE]" && !onEvent(data)) stopped = true;
  };
  const cancel = () => void reader.cancel().catch(() => undefined);
  const goSilent = () => {
    silent = true;
    cancel();
  };
  signal.addEventListener("abort", cancel, { once: true });
  let idle = setTimeout(goSilent, idleMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      clearTimeout(idle);
      if (signal.aborted) throw signal.reason;
      // A cancel for silence also reads as `done`: a cut answer is a failure, not a complete one.
      if (silent) throw new Error("The stream went silent.");
      if (done) break;
      idle = setTimeout(goSilent, idleMs);
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (stopped) {
        cancel();
        return;
      }
    }
    consume(buffered);
  } finally {
    clearTimeout(idle);
    signal.removeEventListener("abort", cancel);
  }
}
