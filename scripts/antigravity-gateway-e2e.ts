// Checks the local Antigravity gateway through its real HTTP socket, with a stand-in for Google at
// the fetch boundary and temporary token files, so no request leaves the computer. Checks:
//   1. Text, streamed and not, reaches the caller; the `ag/` id maps to the Google id.
//   2. A tool loop on Gemini: the thought signature of step one is sent again in step two, and the
//      tool result reaches Google with its id and name. A tool name and schema are translated.
//   3. A 429 moves to the next account, which stays in use; with no account left, a 429 with
//      Retry-After. 403 VALIDATION_REQUIRED gives the link to the caller only.
//   4. No bearer, a wrong bearer, a foreign Host and a foreign Origin are refused before Google.
//   5. A caller that goes away cancels the request at Google.
//   6. `/v1/models` joins the accounts, without tab_, chat_, image and -disabled models.
//   7. The endpoint is saved with the same id and models, a sealed key and the gateway's address.
// `bun scripts/antigravity-gateway-e2e.ts`. Writes .openbot-build/antigravity-gateway-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { AntigravityGateway } from "../src/main/antigravity-gateway/antigravity-gateway";
import {
  markerFileAt,
  mergedModels,
  startAntigravityGateway,
} from "../src/main/antigravity-gateway/provider-registration";
import { ThoughtSignatureStore } from "../src/main/antigravity-gateway/thought-signatures";
import { CustomProviderStore } from "../src/main/custom-provider-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/antigravity-gateway-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-antigravity-gateway-"));
const TOKEN = "e2e-bearer";
const results: { check: string; ok: boolean; error?: string }[] = [];

function makeAccount(name: string): string {
  const home = join(root, name);
  mkdirSync(join(home, "antigravity-acp"), { recursive: true });
  writeFileSync(
    join(home, "antigravity-acp", "acp_token.json"),
    JSON.stringify({
      client_id: "client",
      client_secret: "secret",
      project_id: `project-${name}`,
      refresh_token: `refresh-${name}`,
      scopes: [],
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  return home;
}

interface GoogleCall {
  url: string;
  token: string;
  body: JsonValue;
}

type Script = (call: GoogleCall, signal: AbortSignal | null | undefined) => Response | Promise<Response>;

/** A JSON body as the checks read it. */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

/** The value at a dotted path. A wrong path reads as undefined and fails its check. */
function read(value: JsonValue, path: string): JsonValue {
  let current = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current)) current = current[Number(key)];
    else current = typeof current === "object" && current !== null ? current[key] : undefined;
  }
  return current;
}

const calls: GoogleCall[] = [];
let tokenRefreshes = 0;
let script: Script = () => new Response("{}", { status: 500 });

const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
const answer = (parts: unknown[], finishReason = "STOP") => ({
  response: {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 6 },
  },
});

const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  if (url.includes("oauth2.googleapis.com")) {
    tokenRefreshes += 1;
    const refresh = new URLSearchParams(String(init.body)).get("refresh_token");
    return Response.json({ access_token: `access-${refresh}`, expires_in: 3600 });
  }
  const headers = new Headers(init.headers);
  const call: GoogleCall = {
    url,
    token: headers.get("authorization") ?? "",
    body: JSON.parse(String(init.body)),
  };
  if (url.includes("fetchAvailableModels")) {
    return Response.json({
      models:
        read(call?.body, "project") === "project-a"
          ? {
              "gemini-3-flash": { displayName: "Gemini 3 Flash" },
              "claude-opus-4-6-thinking": { displayName: "Claude Opus" },
              tab_flash: {},
              chat_1: {},
              "gemini-3.1-flash-image": { displayName: "Image" },
              "gemini-4-argon-disabled": { displayName: "Off", disabled: true },
            }
          : { "gemini-only-b": { displayName: "B" }, "gemini-3-flash": { displayName: "Gemini 3 Flash" } },
    });
  }
  calls.push(call);
  return script(call, init.signal);
};

const a = makeAccount("a");
const b = makeAccount("b");
let homes = [a, b];
const gateway = new AntigravityGateway({ accountHomes: () => homes, token: TOKEN, preferredPort: 0, fetch: fakeFetch });
await Effect.runPromise(gateway.start());
const url = `${gateway.baseUrl}/chat/completions`;
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = auth) =>
  fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

async function streamed(response: Response) {
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  assert.equal(events.at(-1), "[DONE]");
  return events.slice(0, -1).map((event) => JSON.parse(event));
}

async function check(name: string, run: () => Promise<void>) {
  calls.length = 0;
  try {
    await run();
    results.push({ check: name, ok: true });
  } catch (error) {
    results.push({ check: name, ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

await check("text, no stream, ag/ id", async () => {
  script = () => Response.json(answer([{ text: "hello" }]));
  const response = await post({
    model: "ag/gemini-3-flash",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "hello");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.total_tokens, 6);
  const call = calls[0];
  assert.ok(call?.url.endsWith(":generateContent"));
  assert.equal(read(call?.body, "model"), "gemini-3-flash");
  assert.equal(read(call?.body, "userAgent"), "antigravity");
  assert.equal(read(call?.body, "requestType"), "agent");
  assert.equal(read(call?.body, "project"), "project-a");
  assert.equal(call?.token, "Bearer access-refresh-a");
  assert.equal(read(call?.body, "request.systemInstruction.parts.0.text"), "be brief");
  assert.ok(read(call?.body, "request.sessionId"));
});

await check("text, stream, thinking level from the model id", async () => {
  script = () =>
    sse(
      answer([{ text: "think", thought: true }], ""),
      { response: { candidates: [{ content: { parts: [{ text: "he" }] } }] } },
      answer([{ text: "llo" }]),
    );
  const response = await post({
    model: "ag/gemini-3.8-flash-high",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(response.status, 200);
  const events = await streamed(response);
  const deltas = events.map((event) => event.choices[0].delta);
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "hello");
  assert.equal(deltas.map((delta) => delta.reasoning_content ?? "").join(""), "think");
  assert.equal(events.at(-1).choices[0].finish_reason, "stop");
  assert.ok(calls[0]?.url.endsWith(":streamGenerateContent?alt=sse"));
  assert.equal(read(calls[0]?.body, "request.generationConfig.thinkingConfig.thinkingLevel"), "high");
});

await check("tool loop with a thought signature", async () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "mcp/read file",
        description: "Reads",
        parameters: {
          type: "object",
          $schema: "x",
          additionalProperties: false,
          properties: {
            path: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
            none: { type: "object" },
          },
          required: ["path", "gone"],
        },
      },
    },
  ];
  script = () =>
    sse(answer([{ functionCall: { name: "mcp_read_file", args: { path: "a" } }, thoughtSignature: "SIG-1" }]));
  const first = await streamed(
    await post({ model: "ag/gemini-3.8-flash-high", stream: true, tools, messages: [{ role: "user", content: "go" }] }),
  );
  const call = first.flatMap((event) => event.choices[0].delta.tool_calls ?? [])[0];
  assert.equal(call.function.name, "mcp/read file");
  assert.equal(call.function.arguments, '{"path":"a"}');
  assert.equal(first.at(-1).choices[0].finish_reason, "tool_calls");
  const declaration = read(calls[0]?.body, "request.tools.0.functionDeclarations.0");
  assert.equal(read(declaration, "name"), "mcp_read_file");
  assert.equal(read(declaration, "parameters.$schema"), undefined);
  assert.equal(read(declaration, "parameters.additionalProperties"), undefined);
  assert.equal(read(declaration, "parameters.properties.path.type"), "string");
  assert.equal(read(declaration, "parameters.properties.path.nullable"), true);
  assert.deepEqual(read(declaration, "parameters.required"), ["path"]);
  assert.ok(read(declaration, "parameters.properties.none.properties.reason"));
  assert.equal(read(calls[0]?.body, "request.toolConfig.functionCallingConfig.mode"), "VALIDATED");

  calls.length = 0;
  script = () => sse(answer([{ text: "done" }]));
  const second = await streamed(
    await post({
      model: "ag/gemini-3.8-flash-high",
      stream: true,
      tools,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "file text" },
      ],
    }),
  );
  assert.equal(second.flatMap((event) => event.choices[0].delta.content ?? "").join(""), "done");
  const contents = read(calls[0]?.body, "request.contents");
  assert.deepEqual(
    [read(contents, "0.role"), read(contents, "1.role"), read(contents, "2.role")],
    ["user", "model", "user"],
  );
  assert.equal(read(contents, "1.parts.0.thoughtSignature"), "SIG-1");
  assert.equal(read(contents, "1.parts.0.functionCall.id"), call.id);
  assert.equal(read(contents, "2.parts.0.functionResponse.id"), call.id);
  assert.equal(read(contents, "2.parts.0.functionResponse.name"), "mcp_read_file");
  assert.equal(read(contents, "2.parts.0.functionResponse.response.result"), "file text");
});

await check("a Claude model keeps the tool id and gets no signature of Gemini", async () => {
  script = () => Response.json(answer([{ functionCall: { id: "toolu_1", name: "t", args: {} } }]));
  const first = await (
    await post({
      model: "ag/claude-opus-4-6-thinking",
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
      messages: [{ role: "user", content: "go" }],
    })
  ).json();
  const call = first.choices[0].message.tool_calls[0];
  assert.equal(call.id, "toolu_1");
  assert.equal(read(calls[0]?.body, "request.generationConfig.maxOutputTokens"), 16_384);
  calls.length = 0;
  script = () => Response.json(answer([{ text: "ok" }]));
  await post({
    model: "ag/claude-opus-4-6-thinking",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [{ ...call, id: "call_unknown" }] },
      { role: "tool", tool_call_id: "call_unknown", content: "r" },
    ],
  });
  assert.equal(read(calls[0]?.body, "request.contents.1.parts.0.thoughtSignature"), undefined);
});

await check("an unanswered tool call and a lost call are repaired", async () => {
  script = () => Response.json(answer([{ text: "ok" }]));
  await post({
    model: "ag/gemini-3-flash",
    messages: [
      { role: "tool", tool_call_id: "lost", name: "x", content: "old" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "user", content: "next" },
    ],
  });
  const contents = read(calls[0]?.body, "request.contents");
  assert.match(String(read(contents, "0.parts.0.text")), /Result of tool x/u);
  assert.equal(read(contents, "1.parts.0.thoughtSignature"), "skip_thought_signature_validator");
  assert.equal(read(contents, "2.parts.0.functionResponse.id"), "c1");
  assert.equal(read(contents, "2.parts.1.text"), "next");
});

await check("429 moves to the next account, which stays", async () => {
  script = (call) =>
    read(call?.body, "project") === "project-a"
      ? Response.json({ error: { code: 429, details: [{ retryDelay: "120s" }] } }, { status: 429 })
      : Response.json(answer([{ text: "from b" }]));
  const response = await post({ model: "ag/gemini-limit", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "from b");
  assert.deepEqual(
    calls.map((call) => read(call?.body, "project")),
    ["project-a", "project-b"],
  );
  calls.length = 0;
  await post({ model: "ag/gemini-other", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(
    calls.map((call) => read(call?.body, "project")),
    ["project-b"],
  );
});

await check("429 on every account answers 429 with Retry-After", async () => {
  script = () => Response.json({ error: { details: [{ retryDelay: "30s" }] } }, { status: 429 });
  const response = await post({ model: "ag/gemini-spent", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal((await response.json()).error.code, "rate_limit_exceeded");
  assert.equal(calls.length, 2);
  calls.length = 0;
  assert.equal((await post({ model: "ag/gemini-spent", messages: [{ role: "user", content: "hi" }] })).status, 429);
  assert.equal(calls.length, 0, "an account under a limit is not called again");
});

await check("403 VALIDATION_REQUIRED gives the link to the caller", async () => {
  const link = "https://accounts.google.com/signin/continue?sarp=1&continue=https://cloud.google.com/x";
  script = () =>
    Response.json(
      { error: { code: 403, message: `Verify your account: ${link}`, details: [{ reason: "VALIDATION_REQUIRED" }] } },
      { status: 403 },
    );
  const response = await post({ model: "ag/gemini-verify", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "validation_required");
  assert.ok(body.error.message.includes(link));
});

await check("another refusal keeps its status and goes to no other account", async () => {
  script = () => Response.json({ error: { message: "bad schema" } }, { status: 400 });
  const response = await post({ model: "ag/gemini-bad", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /bad schema/u);
  assert.equal(calls.length, 1);
});

await check("bearer refusal", async () => {
  const noBearer = await post({ model: "m", messages: [] }, { "Content-Type": "application/json" });
  assert.equal(noBearer.status, 401);
  const wrong = await post({ model: "m", messages: [] }, { Authorization: "Bearer wrong" });
  assert.equal(wrong.status, 401);
  assert.equal((await fetch(`${gateway.baseUrl}/models`)).status, 401);
  assert.equal(calls.length, 0);
});

/** `fetch` will not set Host, so this uses the plain client. */
function rawStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: gateway.port, path: "/v1/models", method: "GET", headers: { ...auth, ...headers } },
      (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      },
    );
    request.on("error", fail);
    request.end();
  });
}

await check("Host and Origin refusal", async () => {
  assert.equal(await rawStatus({ Host: "evil.example" }), 403);
  assert.equal(await rawStatus({ Host: `evil.example:${gateway.port}` }), 403);
  assert.equal(await rawStatus({ Host: "127.0.0.1:1" }), 403);
  assert.equal(await rawStatus({ Origin: "https://evil.example" }), 403);
  assert.equal(await rawStatus({ Origin: "null" }), 403);
  assert.equal(await rawStatus({ Host: `localhost:${gateway.port}` }), 200);
  assert.equal(await rawStatus({ Origin: "http://localhost:3000" }), 200);
  assert.equal(calls.length, 0);
});

await check("a caller that goes away cancels at Google", async () => {
  const cancelled = Promise.withResolvers<void>();
  script = (_call, signal) => {
    signal?.addEventListener("abort", () => cancelled.resolve());
    return new Promise(() => undefined);
  };
  const leaving = new AbortController();
  const pending = post({ model: "ag/gemini-hang", messages: [{ role: "user", content: "hi" }] });
  const request = fetch(url, {
    method: "POST",
    headers: auth,
    signal: leaving.signal,
    body: JSON.stringify({ model: "ag/gemini-hang", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }).catch(() => null);
  void pending.catch(() => null);
  while (calls.length < 2) await new Promise((next) => setImmediate(next));
  leaving.abort();
  await request;
  await cancelled.promise;
});

await check("models are joined and filtered", async () => {
  const response = await fetch(`${gateway.baseUrl}/models`, { headers: auth });
  const ids = (await response.json()).data.map((model: { id: string }) => model.id).sort();
  assert.deepEqual(ids, ["ag/claude-opus-4-6-thinking", "ag/gemini-3-flash", "ag/gemini-only-b"]);
});

await check("no account: no models and a clear refusal", async () => {
  const none = new AntigravityGateway({
    accountHomes: () => [join(root, "x")],
    token: TOKEN,
    preferredPort: 0,
    fetch: fakeFetch,
  });
  await Effect.runPromise(none.start());
  const models = await fetch(`${none.baseUrl}/models`, { headers: auth });
  assert.deepEqual((await models.json()).data, []);
  const chat = await fetch(`${none.baseUrl}/chat/completions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model: "ag/x", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(chat.status, 503);
  await Effect.runPromise(none.stop());
  assert.deepEqual(mergedModels([{ id: "ag/x", name: "X" }], []), [{ id: "ag/x", name: "X" }]);
  assert.deepEqual(mergedModels([], [{ id: "ag/x", name: "X" }], ["ag/x"]), []);
  assert.deepEqual(
    mergedModels(
      [{ id: "ag/x", name: "My name" }],
      [
        { id: "ag/x", name: "X" },
        { id: "ag/y", name: "Y" },
      ],
    ),
    [
      { id: "ag/x", name: "My name" },
      { id: "ag/y", name: "Y" },
    ],
  );
});

await check("the endpoint keeps its id and models, with a sealed key and the new address", async () => {
  const cipher = {
    canPersist: () => true,
    encrypt: (value: string) => Buffer.from(`sealed:${value}`),
    decrypt: (value: Buffer) => value.toString().replace(/^sealed:/u, ""),
  };
  const path = join(root, "providers.json");
  const store = new CustomProviderStore({ path, cipher });
  await Effect.runPromise(store.load());
  const models = [{ id: "ag/gemini-3-flash", name: "Gemini 3 Flash" }];
  await Effect.runPromise(
    store.save({
      id: "antigravity-pro",
      name: "Old",
      baseUrl: "http://localhost:20128/v1",
      apiKey: "key-of-the-old-address",
      headers: [],
      models,
    }),
  );
  const running = await Effect.runPromise(
    startAntigravityGateway(store, { accountHomes: () => homes, fetch: fakeFetch, preferredPort: 0 }),
  );
  assert.ok(running);
  const saved = store.configs()[0];
  assert.equal(saved?.id, "antigravity-pro");
  assert.equal(saved?.name, "Old", "the name the user set stays");
  assert.equal(saved?.baseUrl, running.gateway.baseUrl);
  assert.ok(saved?.apiKey?.startsWith("ocag_"));
  assert.notEqual(saved?.apiKey, "key-of-the-old-address");
  assert.deepEqual(saved?.models, models);
  const onDisk = readFileSync(path, "utf8");
  assert.ok(!onDisk.includes(saved?.apiKey ?? "-"), "the key is sealed on disk");
  const update = Promise.withResolvers<string[]>();
  running.watchModels({
    update: (input) =>
      Effect.sync(() => {
        update.resolve(input.models.map((model) => model.id));
        return { providers: [], restart: "not-running" as const };
      }),
  });
  assert.deepEqual(await update.promise, ["ag/gemini-3-flash", "ag/claude-opus-4-6-thinking", "ag/gemini-only-b"]);
  await Effect.runPromise(running.stop());

  // A second start reuses the key: a new one on each start would restart nothing but change a secret.
  const key = saved?.apiKey;
  const again = await Effect.runPromise(
    startAntigravityGateway(store, { accountHomes: () => homes, fetch: fakeFetch, preferredPort: 0 }),
  );
  assert.equal(store.configs()[0]?.apiKey, key);
  await Effect.runPromise(again?.stop() ?? Effect.void);
});

await check("token files are not written and a port in use moves to another", async () => {
  const before = readFileSync(join(a, "antigravity-acp", "acp_token.json"), "utf8");
  assert.ok(tokenRefreshes >= 2);
  assert.equal(readFileSync(join(a, "antigravity-acp", "acp_token.json"), "utf8"), before);
  const other = new AntigravityGateway({
    accountHomes: () => homes,
    token: TOKEN,
    preferredPort: gateway.port,
    fetch: fakeFetch,
  });
  await Effect.runPromise(other.start());
  assert.notEqual(other.port, gateway.port);
  await Effect.runPromise(other.stop());
});

const lineEvents = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
const hello = (text: string) => answer([{ text }], "STOP");

await check("a 404 or 403 on one account moves to the next account", async () => {
  // Whichever account is tried first, the one without the model must not end the request.
  for (const without of ["access-refresh-a", "access-refresh-b"]) {
    script = (call) =>
      call.token.includes(without)
        ? Response.json({ error: { message: "no model" } }, { status: 404 })
        : Response.json(hello("ok"));
    const response = await post({ model: "ag/gemini-only-b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 200);
  }
  script = () => Response.json({ error: { message: "no model" } }, { status: 404 });
  const none = await post({ model: "ag/gemini-nobody", messages: [{ role: "user", content: "hi" }] });
  assert.equal(none.status, 404);
});

await check("an error event ends the stream with no [DONE] and nothing after it", async () => {
  script = () => sse(hello("one"), { error: { message: "boom" } }, hello("after"));
  const response = await post({
    model: "ag/gemini-3-flash",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const text = await response.text();
  const events = lineEvents(text);
  assert.ok(events.some((event) => event.includes('"error"')));
  assert.ok(!events.includes("[DONE]"));
  assert.ok(!text.includes("after"));
});

await check("a stream that goes silent ends as a failure; a stream slower than the start limit lives", async () => {
  const quick = new AntigravityGateway({
    accountHomes: () => homes,
    token: TOKEN,
    preferredPort: 0,
    fetch: fakeFetch,
    answerStartMs: 80,
    streamIdleMs: 150,
  });
  await Effect.runPromise(quick.start());
  const ask = () =>
    fetch(`${quick.baseUrl}/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "ag/gemini-3-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
  const encoder = new TextEncoder();
  const part = (text: string) => encoder.encode(`data: ${JSON.stringify(hello(text))}\r\n\r\n`);
  // Chunks come every 60 ms for longer than the start limit, then the answer ends well.
  script = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const piece of ["a", "b", "c", "d"]) {
            controller.enqueue(part(piece));
            await new Promise((next) => setTimeout(next, 60));
          }
          controller.close();
        },
      }),
      { status: 200 },
    );
  const slow = lineEvents(await (await ask()).text());
  assert.equal(slow.at(-1), "[DONE]");
  // One chunk, then silence: the answer is cut, so it must not end with [DONE].
  script = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(part("cut"));
        },
      }),
      { status: 200 },
    );
  const cut = await (await ask()).text().catch(() => "");
  assert.ok(!lineEvents(cut).includes("[DONE]"));
  await Effect.runPromise(quick.stop());
});

await check("a bad models answer reads as no answer, not as an empty list", async () => {
  const odd = new AntigravityGateway({
    accountHomes: () => homes,
    token: TOKEN,
    preferredPort: 0,
    fetch: (target, init) =>
      target.includes("fetchAvailableModels") ? Promise.resolve(Response.json({ nope: 1 })) : fakeFetch(target, init),
  });
  assert.equal(await Effect.runPromise(odd.models()), null);
});

await check("thought signatures are bounded by total size", async () => {
  const store = new ThoughtSignatureStore();
  const big = "s".repeat(200 * 1_024);
  for (let index = 0; index < 400; index += 1) store.put(`id${index}`, big, "gemini");
  assert.equal(store.get("id0", "gemini"), null);
  assert.equal(store.get("id399", "gemini"), big);
});

await check("a deleted endpoint and a removed model stay gone; an unreadable account removes nothing", async () => {
  const cipher = {
    canPersist: () => true,
    encrypt: (value: string) => Buffer.from(`sealed:${value}`),
    decrypt: (value: Buffer) => value.toString().replace(/^sealed:/u, ""),
  };
  const store = new CustomProviderStore({ path: join(root, "providers2.json"), cipher });
  await Effect.runPromise(store.load());
  const marker = markerFileAt(join(root, "marker.json"));
  const start = (accountHomes: () => string[]) =>
    Effect.runPromise(startAntigravityGateway(store, { accountHomes, fetch: fakeFetch, preferredPort: 0, marker }));
  const updates: string[][] = [];
  const changes = {
    update: (input: { models: readonly { id: string }[] }) =>
      Effect.sync(() => {
        updates.push(input.models.map((model) => model.id));
        return { providers: [], restart: "not-running" as const };
      }),
  };
  const settle = async () => {
    for (let turn = 0; turn < 40; turn += 1) await new Promise((next) => setTimeout(next, 5));
  };
  const first = await start(() => homes);
  assert.ok(first);
  first.watchModels(changes);
  while (updates.length === 0) await new Promise((next) => setImmediate(next));
  await Effect.runPromise(first.stop());
  assert.equal(store.configs().length, 1);
  // The user keeps the models but removes one, and a start with no readable account changes nothing.
  const kept = { id: "ag/gemini-3-flash", name: "Gemini 3 Flash" };
  await Effect.runPromise(
    store.update({
      id: "antigravity-pro",
      name: "Antigravity",
      baseUrl: store.configs()[0]?.baseUrl ?? "",
      models: [kept],
    }),
  );
  updates.length = 0;
  const unreadable = await start(() => [join(root, "missing")]);
  assert.ok(unreadable);
  unreadable.watchModels(changes);
  await settle();
  assert.deepEqual(updates, []);
  assert.deepEqual(store.configs()[0]?.models, [kept]);
  await Effect.runPromise(unreadable.stop());
  // A model the user removed does not come back.
  const again = await start(() => homes);
  assert.ok(again);
  again.watchModels(changes);
  await settle();
  assert.deepEqual(updates, []);
  await Effect.runPromise(again.stop());
  // A deleted endpoint is not saved again.
  await Effect.runPromise(store.remove("antigravity-pro"));
  const last = await start(() => homes);
  assert.equal(store.configs().length, 0);
  await Effect.runPromise(last?.stop() ?? Effect.void);
});

homes = [];
await Effect.runPromise(gateway.stop());
await rm(root, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results)
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.check}${result.error ? `: ${result.error}` : ""}\n`);
process.exit();
