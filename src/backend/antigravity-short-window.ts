// The short (five-hour) Gemini quota window of the signed-in Google account.
//
// The `/usage` answer of the Antigravity server lists only the weekly limit. Pro accounts also have
// a short window, which Google's `fetchAvailableModels` reports per model as `quotaInfo`. This reads
// it with the account's own token file (`acp_token.json` in `antigravity-acp`) and sends the token
// only to Google, as the Antigravity runtime does. The access token lives in memory for one call.
// Any failure reads as no short window, so the weekly reading stays as it was, with no error. No
// token, secret or response text is kept in an error or a log.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { AccountRateLimitWindowResult } from "./protocol";

export const FETCH_MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
export const ANTIGRAVITY_USER_AGENT = "antigravity/hub/2.24.0 darwin/arm64";
const SHORT_WINDOW_TIMEOUT_MS = 8_000;
const FIVE_HOUR_WINDOW_MINS = 300;
/** A reset further ahead than this belongs to a weekly quota, as on Plus accounts. */
const SHORT_WINDOW_LIMIT_MS = 6 * 60 * 60 * 1_000;

export interface AntigravityShortWindows {
  gemini?: AccountRateLimitWindowResult;
  other?: AccountRateLimitWindowResult;
}

/** The HTTP boundary: tests inject it so that no request leaves the computer. */
export type ShortWindowFetch = (url: string, init: RequestInit) => Promise<Response>;

const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  project_id: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  token_uri: Schema.NonEmptyString,
});

const ModelsAnswer = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      quotaInfo: Schema.optional(
        Schema.Struct({
          remainingFraction: Schema.optional(Schema.Number),
          resetTime: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

export type AntigravityAuth = typeof TokenFile.Type;

/** The contents of a token file, or null when they are not one. */
export function decodeAntigravityAuth(text: string): AntigravityAuth | null {
  return Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(TokenFile))(text));
}

/** The client secret and refresh token go only to a Google address over https. */
export function isGoogleTokenUri(uri: string): boolean {
  const url = URL.parse(uri);
  return url?.protocol === "https:" && /(^|\.)(googleapis|google)\.com$/iu.test(url.hostname);
}

/** The form that exchanges a refresh token for an access token. */
export function antigravityRefreshBody(auth: AntigravityAuth): string {
  return new URLSearchParams({
    client_id: auth.client_id,
    client_secret: auth.client_secret,
    refresh_token: auth.refresh_token,
    grant_type: "refresh_token",
  }).toString();
}

const TokenAnswer = Schema.Struct({ access_token: Schema.NonEmptyString });

class ShortWindowFailed extends Schema.TaggedError<ShortWindowFailed>()("ShortWindowFailed", {
  cause: Schema.Defect(),
}) {}

export function antigravityTokenFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.GEMINI_HOME?.trim() || join(home, ".gemini"), "antigravity-acp", "acp_token.json");
}

/** The windows of a `fetchAvailableModels` answer: the one reset under about six hours per family. */
export function parseShortWindows(answer: unknown, nowMs: number): AntigravityShortWindows {
  const decoded = Schema.decodeUnknownOption(ModelsAnswer)(answer);
  const result: AntigravityShortWindows = {};
  if (Option.isNone(decoded)) return result;
  for (const [id, model] of Object.entries(decoded.value.models)) {
    const family = /^gemini-/iu.test(id) ? "gemini" : /^(claude-|gpt-oss)/iu.test(id) ? "other" : null;
    const info = model.quotaInfo;
    if (!family || !info?.resetTime) continue;
    const resetMs = Date.parse(info.resetTime);
    const fraction = info.remainingFraction ?? 0;
    if (!Number.isFinite(resetMs) || resetMs <= nowMs || resetMs - nowMs >= SHORT_WINDOW_LIMIT_MS) continue;
    const window: AccountRateLimitWindowResult = {
      usedPercent: Math.max(0, Math.min(100, 100 - fraction * 100)),
      windowDurationMins: FIVE_HOUR_WINDOW_MINS,
      resetsAt: resetMs / 1_000,
    };
    const current = result[family];
    // The binding model: the one with the least room.
    if (!current || (current.usedPercent ?? 0) < (window.usedPercent ?? 0)) result[family] = window;
  }
  return result;
}

const post = Effect.fn("Antigravity.shortWindowPost")(function* (
  doFetch: ShortWindowFetch,
  url: string,
  init: RequestInit,
) {
  // A redirect would send the client secret or the token to another address.
  const response = yield* Effect.tryPromise({
    try: () => doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(SHORT_WINDOW_TIMEOUT_MS) }),
    catch: (cause) => new ShortWindowFailed({ cause }),
  });
  if (!response.ok) return yield* new ShortWindowFailed({ cause: new Error(`HTTP ${response.status}`) });
  return yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (cause) => new ShortWindowFailed({ cause }),
  });
});

const read = Effect.fn("Antigravity.readShortWindows")(function* (
  tokenFile: string,
  doFetch: ShortWindowFetch,
  nowMs: number,
) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(tokenFile, "utf8"),
    catch: (cause) => new ShortWindowFailed({ cause }),
  });
  const auth = decodeAntigravityAuth(text);
  if (!auth || !isGoogleTokenUri(auth.token_uri)) return {} satisfies AntigravityShortWindows;
  const token = yield* post(doFetch, auth.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: antigravityRefreshBody(auth),
  });
  const access = Option.getOrNull(Schema.decodeUnknownOption(TokenAnswer)(token));
  if (!access) return {} satisfies AntigravityShortWindows;
  const answer = yield* post(doFetch, FETCH_MODELS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access.access_token}`,
      "User-Agent": ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify({ project: auth.project_id }),
  });
  return parseShortWindows(answer, nowMs);
});

/** The short windows of the account whose `GEMINI_HOME` is in `env`; empty when unreadable. */
export const readAntigravityShortWindows = (
  env: NodeJS.ProcessEnv,
  doFetch: ShortWindowFetch = (url, init) => fetch(url, init),
  nowMs: number = Date.now(),
): Effect.Effect<AntigravityShortWindows> =>
  read(antigravityTokenFile(env), doFetch, nowMs).pipe(
    Effect.catch(() => Effect.succeed({} satisfies AntigravityShortWindows)),
  );
