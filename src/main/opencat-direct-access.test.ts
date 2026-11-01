import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  directAccessAllows,
  directMemberUsername,
  isDirectAccessPublicUrl,
  startDirectAccessGateway,
} from "./opencat-direct-access";

describe("directMemberUsername", () => {
  it("makes a name the team store accepts", () => {
    const valid = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
    for (const name of ["João da Silva", "  ", undefined, "---", "a", "x".repeat(80), "José!!"])
      expect(directMemberUsername(name, "ab12")).toMatch(valid);
    expect(directMemberUsername("João da Silva", "ab12")).toBe("joao-da-silva-ab12");
    expect(directMemberUsername("", "ab12")).toBe("membro-ab12");
  });
});

describe("directAccessAllows", () => {
  it("lets the member routes pass", () => {
    for (const path of ["/v1/identity", "/v1/join", "/v1/agents", "/v1/agents/a/messages", "/v1/compatibility"])
      expect(directAccessAllows(path)).toBe(true);
  });

  it("keeps the routes of this computer and of a WebRTC session out", () => {
    for (const path of [
      "/",
      "/internal",
      "/v2/x",
      "/v1/remote-screen/sessions/a/viewer",
      "/v1/browser-view/a",
      "/v1/../internal",
      "/v1/%2e%2e/internal",
      "/v1/a%2fb",
    ])
      expect(directAccessAllows(path)).toBe(false);
  });
});

describe("isDirectAccessPublicUrl", () => {
  it("accepts only an HTTPS origin", () => {
    expect(isDirectAccessPublicUrl("https://servidor.example.com/")).toBe(true);
    expect(isDirectAccessPublicUrl("http://servidor.example.com/")).toBe(false);
    expect(isDirectAccessPublicUrl("https://servidor.example.com/x")).toBe(false);
    expect(isDirectAccessPublicUrl("https://a:b@servidor.example.com/")).toBe(false);
    expect(isDirectAccessPublicUrl(1)).toBe(false);
  });
});

describe("startDirectAccessGateway", () => {
  let api: Server;
  let close: () => void = () => undefined;
  afterEach(() => {
    close();
    api.close();
  });

  async function start() {
    const seen: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
    api = createServer((incoming, response) => {
      seen.push({ url: incoming.url, headers: incoming.headers });
      response.end("ok");
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (address === null || typeof address === "string") throw new Error("The test server has no port.");
    const apiPort = address.port;
    const gateway = await startDirectAccessGateway(() => apiPort);
    close = gateway.close;
    return { seen, gateway };
  }

  function get(port: number, path: string, headers: Record<string, string> = {}) {
    return new Promise<number>((resolve, reject) => {
      const outgoing = request({ host: "127.0.0.1", port, path, headers }, (answer) => {
        answer.resume();
        resolve(answer.statusCode ?? 0);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  it("forwards a member route without the headers that only the host may set", async () => {
    const { seen, gateway } = await start();
    expect(await get(gateway.port, "/v1/agents", { "x-openbot-webrtc-session": "s", authorization: "Bearer t" })).toBe(
      200,
    );
    expect(seen[0]?.headers["x-openbot-webrtc-session"]).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBe("Bearer t");
  });

  it("refuses other routes before they reach the Team API", async () => {
    const { seen, gateway } = await start();
    expect(await get(gateway.port, "/v1/remote-screen/sessions/a/viewer")).toBe(404);
    expect(await get(gateway.port, "/internal")).toBe(404);
    expect(seen).toEqual([]);
  });

  it("refuses a socket upgrade on any route but the events", async () => {
    const { gateway } = await start();
    const answer = await new Promise<string>((resolve) => {
      const socket = connect(gateway.port, "127.0.0.1", () => {
        socket.write("GET /v1/browser-view/x HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      });
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
    });
    expect(answer).toContain("404");
  });
});
