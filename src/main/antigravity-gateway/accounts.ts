// The Google accounts the gateway can use: their token files, access tokens, order and limits.
//
// It reads `acp_token.json` and never writes it: the Antigravity server owns that file. The access
// token stays in memory. No token, secret or response text reaches an error or a log.

import { readFile } from "node:fs/promises";
import { Effect, Schema, Semaphore } from "effect";
import {
  type AntigravityAuth,
  antigravityRefreshBody,
  antigravityTokenFile,
  decodeAntigravityAuth,
  isGoogleTokenUri,
} from "../../backend/antigravity-short-window";

/** Google's HTTP boundary: tests inject it so that no request leaves the computer. */
export type GatewayFetch = (url: string, init: RequestInit) => Promise<Response>;

export class AccountTokenFailed extends Schema.TaggedError<AccountTokenFailed>()("AccountTokenFailed", {
  cause: Schema.Defect(),
}) {}

const TokenAnswer = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Number),
});

const REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_LIFETIME_S = 3_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface GatewayAccount {
  /** The account folder: it never leaves this process. */
  readonly home: string;
  readonly auth: AntigravityAuth;
}

interface AccessToken {
  readonly refreshToken: string;
  readonly token: string;
  readonly expiresAt: number;
}

export class GatewayAccounts {
  readonly #homes: () => readonly string[];
  readonly #fetch: GatewayFetch;
  readonly #now: () => number;
  readonly #tokens = new Map<string, AccessToken>();
  readonly #refreshes = new Map<string, Semaphore.Semaphore>();
  /** `<home>\n<model>` to the time when the limit ends. */
  readonly #limits = new Map<string, number>();
  /** The account in use. It stays while it works, so that Google's cache stays valid. */
  #current: string | null = null;

  constructor(options: { homes: () => readonly string[]; fetch: GatewayFetch; now?: () => number }) {
    this.#homes = options.homes;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Each signed-in account once, in order. One Google project signed in twice counts once. */
  readonly list = Effect.fn("AntigravityGateway.listAccounts")(function* (this: GatewayAccounts) {
    const accounts: GatewayAccount[] = [];
    const projects = new Set<string>();
    for (const home of this.#homes()) {
      const text = yield* Effect.tryPromise({
        try: () => readFile(antigravityTokenFile({ GEMINI_HOME: home }), "utf8"),
        catch: (cause) => new AccountTokenFailed({ cause }),
      }).pipe(Effect.orElseSucceed(() => null));
      const auth = text === null ? null : decodeAntigravityAuth(text);
      if (!auth || !isGoogleTokenUri(auth.token_uri) || projects.has(auth.project_id)) continue;
      projects.add(auth.project_id);
      accounts.push({ home, auth });
    }
    return accounts;
  });

  /** The accounts to try for a model: the current one first, then the others in their order. */
  ordered(accounts: readonly GatewayAccount[]): GatewayAccount[] {
    const start = Math.max(
      0,
      accounts.findIndex((account) => account.home === this.#current),
    );
    return [...accounts.slice(start), ...accounts.slice(0, start)];
  }

  /** The time when the account can take this model again, or null when it can now. */
  limitedUntil(account: GatewayAccount, model: string): number | null {
    const key = `${account.home}\n${model}`;
    const until = this.#limits.get(key);
    if (until === undefined) return null;
    if (until > this.#now()) return until;
    this.#limits.delete(key);
    return null;
  }

  markLimited(account: GatewayAccount, model: string, until: number): void {
    this.#limits.set(`${account.home}\n${model}`, until);
  }

  markWorking(account: GatewayAccount): void {
    this.#current = account.home;
  }

  forgetToken(account: GatewayAccount): void {
    this.#tokens.delete(account.home);
  }

  #refreshGate(home: string): Semaphore.Semaphore {
    const existing = this.#refreshes.get(home);
    if (existing) return existing;
    const gate = Semaphore.makeUnsafe(1);
    this.#refreshes.set(home, gate);
    return gate;
  }

  #valid(account: GatewayAccount): string | null {
    const held = this.#tokens.get(account.home);
    // A new refresh token means that the user signed in to the account again.
    if (!held || held.refreshToken !== account.auth.refresh_token) return null;
    return held.expiresAt > this.#now() ? held.token : null;
  }

  /** One refresh at a time per account: parallel requests share its result. */
  accessToken(account: GatewayAccount): Effect.Effect<string, AccountTokenFailed> {
    const held = this.#valid(account);
    if (held) return Effect.succeed(held);
    return this.#refreshGate(account.home).withPermit(
      Effect.suspend(() => {
        const token = this.#valid(account);
        return token ? Effect.succeed(token) : this.#refresh(account);
      }),
    );
  }

  #refresh = Effect.fn("AntigravityGateway.refreshToken")(function* (this: GatewayAccounts, account: GatewayAccount) {
    const { auth, home } = account;
    // A redirect would send the client secret to another address.
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        this.#fetch(auth.token_uri, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: antigravityRefreshBody(auth),
          signal: AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]),
        }),
      catch: (cause) => new AccountTokenFailed({ cause }),
    });
    if (!response.ok) return yield* new AccountTokenFailed({ cause: new Error(`HTTP ${response.status}`) });
    const answer = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (cause) => new AccountTokenFailed({ cause }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TokenAnswer)),
      Effect.mapError((error) =>
        error instanceof AccountTokenFailed ? error : new AccountTokenFailed({ cause: new Error("Bad token answer.") }),
      ),
    );
    const lifetimeMs = (answer.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1_000;
    this.#tokens.set(home, {
      refreshToken: auth.refresh_token,
      token: answer.access_token,
      expiresAt: this.#now() + lifetimeMs - TOKEN_EXPIRY_MARGIN_MS,
    });
    return answer.access_token;
  });
}
