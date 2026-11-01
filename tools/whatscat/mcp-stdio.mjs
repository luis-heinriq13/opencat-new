// A small MCP server over stdio, so the bundled servers need no package at run time.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export function serveMcp({ name, version, listTools, callTool }) {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const { id, method, params } = request;
    if (id === undefined) return;
    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name, version },
          },
        });
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: await listTools() } });
      } else if (method === "tools/call") {
        send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments ?? {}) });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: toolText(error instanceof Error ? error.message : String(error), true) });
    }
  });
  return lines;
}

export function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Limits for outgoing messages, kept in a file so a restart does not reset them. `check` answers the
 * number of milliseconds to wait, or throws when a limit is reached. `record` stores one send.
 */
export function createSendLimiter({
  file,
  minGapMs,
  jitterMs = 0,
  perHour,
  perDay,
  now = Date.now,
  random = Math.random,
}) {
  const read = () => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(value.sent) ? value.sent.filter((time) => typeof time === "number") : [];
    } catch {
      return [];
    }
  };
  const write = (sent) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ sent }), { mode: 0o600 });
    renameSync(temporary, file);
  };
  return {
    usage() {
      const time = now();
      const sent = read();
      return {
        lastHour: sent.filter((at) => time - at < 3_600_000).length,
        lastDay: sent.filter((at) => time - at < 86_400_000).length,
        perHour,
        perDay,
      };
    },
    check() {
      const time = now();
      const sent = read().filter((at) => time - at < 86_400_000);
      if (sent.length >= perDay) throw new Error(`Limite diário de ${perDay} mensagens atingido. Nada foi enviado.`);
      if (sent.filter((at) => time - at < 3_600_000).length >= perHour)
        throw new Error(`Limite de ${perHour} mensagens por hora atingido. Nada foi enviado.`);
      const last = sent.at(-1);
      if (last === undefined) return 0;
      return Math.max(0, last + minGapMs + Math.floor(random() * jitterMs) - time);
    },
    record() {
      const time = now();
      write([...read().filter((at) => time - at < 86_400_000), time]);
    },
  };
}
