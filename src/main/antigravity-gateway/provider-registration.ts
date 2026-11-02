// The `antigravity-pro` custom endpoint, pointed at the local gateway. The harness stays as it is:
// only the address and the key of the endpoint change, and its id and model ids stay valid.
//
// The bearer token lives in the endpoint's sealed secret, like any endpoint key. A key without the
// prefix belongs to an older address, so it is replaced and never sent to the gateway's callers.

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { CustomProviderModel } from "@openbot/contracts/ipc";
import { ANTIGRAVITY_GATEWAY_PROVIDER_ID, CUSTOM_PROVIDER_LIMITS } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import type { CustomProviderChanges } from "../custom-provider-changes";
import type { CustomProviderStore } from "../custom-provider-store";
import { AntigravityGateway, type AntigravityGatewayOptions, type GatewayModel } from "./antigravity-gateway";
import { parseJsonObject } from "./translate";

const logger = createOpenBotLogger("antigravity-gateway");

export const ANTIGRAVITY_PROVIDER_ID = ANTIGRAVITY_GATEWAY_PROVIDER_ID;
const ANTIGRAVITY_PROVIDER_NAME = "Antigravity";
const TOKEN_PREFIX = "ocag_";
const PREFERRED_PORT = 20_129;
const MODEL_REFRESH_MS = 30 * 60_000;

type RegistrationStore = Pick<CustomProviderStore, "configs" | "save" | "update">;

/**
 * What the gateway remembers of the endpoint, in a small file next to the saved endpoints: that it
 * saved the endpoint once (so a deletion by the user stays), and the model ids it already offered
 * (so a model the user removed does not return).
 */
export interface RegistrationMarker {
  readonly seen: readonly string[];
}

export interface MarkerFile {
  readonly read: () => Promise<RegistrationMarker | null>;
  readonly write: (marker: RegistrationMarker) => Promise<void>;
}

export function markerFileAt(path: string): MarkerFile {
  return {
    read: async () => {
      const text = await readFile(path, "utf8").catch(() => null);
      const parsed = text === null ? null : parseJsonObject(text);
      const seen = parsed?.seen;
      return Array.isArray(seen) ? { seen: seen.filter((id): id is string => typeof id === "string") } : null;
    },
    write: (marker) => writeFile(path, JSON.stringify(marker), "utf8"),
  };
}

function isLoopbackUrl(value: string): boolean {
  const host = URL.parse(value)?.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function gatewayToken(store: Pick<CustomProviderStore, "configs">): string {
  const saved = store.configs().find((provider) => provider.id === ANTIGRAVITY_PROVIDER_ID)?.apiKey;
  return saved?.startsWith(TOKEN_PREFIX) ? saved : `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/**
 * Creates the endpoint on the first run only. An endpoint that the user deleted stays deleted. An
 * existing endpoint changes its address and key only, and only when it is the gateway's own (a key
 * with the prefix) or an older local address; a name, headers or models the user set stay.
 */
const registerEndpoint = Effect.fn("AntigravityGateway.registerEndpoint")(function* (
  store: RegistrationStore,
  baseUrl: string,
  token: string,
  marker: MarkerFile | null,
) {
  const current = store.configs().find((provider) => provider.id === ANTIGRAVITY_PROVIDER_ID);
  const known = marker ? yield* Effect.promise(() => marker.read()) : null;
  if (!current) {
    if (known) return;
    yield* store.save({
      id: ANTIGRAVITY_PROVIDER_ID,
      name: ANTIGRAVITY_PROVIDER_NAME,
      baseUrl,
      apiKey: token,
      models: [],
      headers: [],
    });
    if (marker) yield* Effect.promise(() => marker.write({ seen: [] }).catch(() => undefined));
    return;
  }
  if (marker && !known) yield* Effect.promise(() => marker.write({ seen: [] }).catch(() => undefined));
  const ours = current.apiKey?.startsWith(TOKEN_PREFIX) === true || isLoopbackUrl(current.baseUrl);
  if (!ours || (current.baseUrl === baseUrl && current.apiKey === token)) return;
  yield* store.update({
    id: ANTIGRAVITY_PROVIDER_ID,
    name: current.name,
    baseUrl,
    apiKey: token,
    headers: [...current.headers],
    models: [...current.models],
  });
});

/**
 * Saved ids stay, with their saved names, so that an agent on one keeps it. A model that an account
 * offers for the first time goes after them. A model in `seen` was offered before: if the user
 * removed it, it does not return. An empty offer changes nothing, so no agent can lose its model.
 */
export function mergedModels(
  saved: readonly CustomProviderModel[],
  offered: readonly GatewayModel[],
  seen: readonly string[] = [],
): CustomProviderModel[] {
  if (offered.length === 0) return [...saved];
  const known = new Set([...saved.map((model) => model.id), ...seen]);
  return [...saved, ...offered.filter((model) => !known.has(model.id))].slice(0, CUSTOM_PROVIDER_LIMITS.models);
}

export interface RunningAntigravityGateway {
  readonly gateway: AntigravityGateway;
  /** Starts the model readings. The first one runs now, and none of them can stop the app. */
  readonly watchModels: (changes: Pick<CustomProviderChanges, "update">) => void;
  readonly stop: () => Effect.Effect<void>;
}

/**
 * Null when the gateway cannot start or be saved. The app then goes on without it, and the saved
 * endpoint stays as it was. Runs before the harness reads the endpoints, so no restart is needed.
 */
export const startAntigravityGateway = Effect.fn("AntigravityGateway.startForApp")(function* (
  store: RegistrationStore,
  options: Pick<AntigravityGatewayOptions, "accountHomes" | "fetch"> & {
    preferredPort?: number;
    marker?: MarkerFile;
  },
) {
  const start = Effect.gen(function* () {
    const token = gatewayToken(store);
    const gateway = new AntigravityGateway({
      accountHomes: options.accountHomes,
      fetch: options.fetch,
      token,
      preferredPort: options.preferredPort ?? PREFERRED_PORT,
    });
    yield* gateway.start();
    yield* registerEndpoint(store, gateway.baseUrl, token, options.marker ?? null).pipe(
      Effect.tapError(() => gateway.stop().pipe(Effect.ignore)),
    );
    return gateway;
  });
  const gateway = yield* start.pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        logger.warn("The local Antigravity gateway did not start.");
        return null;
      }),
    ),
  );
  if (!gateway) return null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const running: RunningAntigravityGateway = {
    gateway,
    watchModels: (changes) => {
      const refresh = () => {
        Effect.runPromise(refreshModels(store, gateway, changes, options.marker ?? null)).catch(() =>
          logger.warn("The Antigravity model list was not read."),
        );
      };
      refresh();
      timer = setInterval(refresh, MODEL_REFRESH_MS);
      timer.unref();
    },
    stop: () =>
      Effect.suspend(() => {
        if (timer) clearInterval(timer);
        return gateway.stop();
      }),
  };
  return running;
});

const refreshModels = Effect.fn("AntigravityGateway.refreshModels")(function* (
  store: RegistrationStore,
  gateway: AntigravityGateway,
  changes: Pick<CustomProviderChanges, "update">,
  marker: MarkerFile | null,
) {
  const offered = yield* gateway.models();
  // Null or empty: no account answered or none is readable, which says nothing about the models.
  if (offered === null || offered.length === 0) return;
  const current = store.configs().find((provider) => provider.id === ANTIGRAVITY_PROVIDER_ID);
  if (!current) return;
  const known = marker ? yield* Effect.promise(() => marker.read()) : null;
  const models = mergedModels(current.models, offered, known?.seen ?? []);
  if (marker) {
    const seen = [...new Set([...(known?.seen ?? []), ...offered.map((model) => model.id)])];
    yield* Effect.promise(() => marker.write({ seen }).catch(() => undefined));
  }
  const same =
    models.length === current.models.length && models.every((model, index) => model.id === current.models[index]?.id);
  if (same) return;
  yield* changes.update({
    id: ANTIGRAVITY_PROVIDER_ID,
    name: current.name,
    baseUrl: current.baseUrl,
    models,
  });
});
