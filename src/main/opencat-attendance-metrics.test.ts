import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateAttendance,
  METRICS_FILE_NAME,
  METRICS_ROW_LIMIT,
  type MetricRow,
  parseMetricLine,
  percentile,
  readAttendanceReport,
} from "./opencat-attendance-metrics";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A local noon, so "today" always holds the hours before it whatever the time zone.
const NOW = new Date(2026, 5, 15, 14, 30).getTime();

function row(overrides: Partial<MetricRow> & Pick<MetricRow, "event">): MetricRow {
  return {
    at: NOW - HOUR,
    conversation: "aa11bb22cc",
    kind: "contact",
    waitMs: 0,
    agentMs: 0,
    sendMs: 0,
    error: null,
    ...overrides,
  };
}

describe("parseMetricLine", () => {
  it("reads a row of the bridge", () => {
    const line = JSON.stringify({
      at: new Date(NOW).toISOString(),
      conversa: "aa11bb22cc",
      tipo: "group",
      evento: "respondida",
      esperaMs: 100,
      agenteMs: 2000,
      envioMs: 50,
    });
    expect(parseMetricLine(line)).toMatchObject({ kind: "group", event: "respondida", waitMs: 100, agentMs: 2000 });
  });

  it("ignores malformed lines", () => {
    expect(parseMetricLine("")).toBeNull();
    expect(parseMetricLine("{ nope")).toBeNull();
    expect(parseMetricLine("[1,2]")).toBeNull();
    expect(parseMetricLine(JSON.stringify({ at: "never", conversa: "aa11bb22", evento: "recebida" }))).toBeNull();
    expect(
      parseMetricLine(JSON.stringify({ at: new Date(NOW).toISOString(), conversa: "aa11bb22", evento: "x" })),
    ).toBeNull();
    expect(
      parseMetricLine(JSON.stringify({ at: new Date(NOW).toISOString(), conversa: "not hex!", evento: "recebida" })),
    ).toBeNull();
  });

  it("drops negative and non-finite times", () => {
    const parsed = parseMetricLine(
      JSON.stringify({
        at: new Date(NOW).toISOString(),
        conversa: "aa11bb22",
        evento: "respondida",
        esperaMs: -5,
        agenteMs: "9",
      }),
    );
    expect(parsed).toMatchObject({ waitMs: 0, agentMs: 0 });
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.9)).toBe(9);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("aggregateAttendance", () => {
  it("counts only the rows inside the period", () => {
    const rows = [
      row({ event: "recebida" }),
      row({ event: "recebida", at: NOW - 3 * DAY }),
      row({ event: "recebida", at: NOW - 20 * DAY }),
      row({ event: "respondida", at: NOW - 2 * DAY }),
    ];
    expect(aggregateAttendance(rows, "today", NOW).totals.received).toBe(1);
    expect(aggregateAttendance(rows, "7d", NOW).totals).toMatchObject({ received: 2, answered: 1 });
    expect(aggregateAttendance(rows, "30d", NOW).totals.received).toBe(3);
  });

  it("ignores rows older than 90 days and rows from the future", () => {
    const rows = [row({ event: "recebida", at: NOW - 91 * DAY }), row({ event: "recebida", at: NOW + 5 * DAY })];
    const report = aggregateAttendance(rows, "30d", NOW);
    expect(report.hasData).toBe(false);
    expect(report.totals.received).toBe(0);
  });

  it("reports no data for no rows and still draws empty buckets", () => {
    const report = aggregateAttendance([], "7d", NOW);
    expect(report.hasData).toBe(false);
    expect(report.buckets.length).toBeGreaterThanOrEqual(168);
    expect(report.bucketHours).toBe(1);
    expect(aggregateAttendance([], "30d", NOW).bucketHours).toBe(6);
  });

  it("builds the funnel and the failure categories", () => {
    const rows = [
      row({ event: "recebida" }),
      row({ event: "recebida", conversation: "dd33ee44ff" }),
      row({ event: "respondida", waitMs: 1000, agentMs: 2000, sendMs: 500 }),
      row({ event: "humano", conversation: "dd33ee44ff" }),
      row({ event: "bloqueada", error: "filtro:telefone" }),
      row({ event: "falhou", error: "limite" }),
      row({ event: "falhou", error: "limite" }),
      row({ event: "falhou", error: "something with a secret" }),
      row({ event: "pausada", error: "parada" }),
    ];
    const report = aggregateAttendance(rows, "today", NOW);
    expect(report.totals).toEqual({
      received: 2,
      answered: 1,
      handoff: 1,
      blocked: 1,
      failed: 3,
      paused: 1,
      conversations: 2,
    });
    expect(report.failures).toEqual([
      { category: "limite", count: 2 },
      { category: "outro", count: 1 },
    ]);
    expect(report.attention.every((item) => item.ref.length === 6)).toBe(true);
    expect(report.attention).toHaveLength(5);
  });

  it("computes the percentiles of the response time by hour", () => {
    const at = new Date(2026, 5, 15, 9, 10).getTime();
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seconds) =>
      row({ event: "respondida", at, agentMs: seconds * 1000 }),
    );
    rows.push(row({ event: "falhou", at, error: "motor" }));
    const report = aggregateAttendance(rows, "today", NOW);
    expect(report.latency).toHaveLength(24);
    expect(report.latency[9]).toMatchObject({ p50: 5000, p90: 9000, answers: 10, failures: 1 });
    expect(report.latency[10]).toMatchObject({ p50: null, answers: 0 });
    expect(report.latencyOverall).toEqual({ p50: 5000, p90: 9000 });
  });

  it("fills the heatmap by weekday and hour with received messages only", () => {
    const monday = new Date(2026, 5, 15, 8, 5).getTime();
    expect(new Date(monday).getDay()).toBe(1);
    const rows = [
      row({ event: "recebida", at: monday }),
      row({ event: "recebida", at: monday + 60_000 }),
      row({ event: "respondida", at: monday }),
    ];
    const report = aggregateAttendance(rows, "7d", NOW);
    expect(report.heatmap).toHaveLength(7);
    expect(report.heatmap[1]?.[8]).toBe(2);
    expect(report.heatmap.flat().reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it("counts the answers of the span before for the trend", () => {
    const rows = [row({ event: "respondida", at: NOW - 10 * DAY }), row({ event: "respondida", at: NOW - 2 * DAY })];
    const report = aggregateAttendance(rows, "7d", NOW);
    expect(report.totals.answered).toBe(1);
    expect(report.previousAnswered).toBe(1);
  });

  it("puts rows in their bucket", () => {
    const report = aggregateAttendance([row({ event: "recebida" }), row({ event: "respondida" })], "today", NOW);
    const filled = report.buckets.filter((bucket) => bucket.received + bucket.answered > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ received: 1, answered: 1 });
  });
});

describe("readAttendanceReport", () => {
  const line = (event: string, at: number, extra: Record<string, string | number> = {}) =>
    JSON.stringify({
      at: new Date(at).toISOString(),
      conversa: "aa11bb22cc",
      tipo: "contact",
      evento: event,
      ...extra,
    });

  it("gives an empty report for a missing folder", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "atendimento-")), "missing");
    const report = await readAttendanceReport(dir, "7d", NOW);
    expect(report.hasData).toBe(false);
    expect(report.connection.configured).toBe(false);
  });

  it("reads the file and its rotated copy and skips bad lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atendimento-"));
    writeFileSync(join(dir, `${METRICS_FILE_NAME}.1`), `${line("recebida", NOW - 2 * HOUR)}\n`);
    writeFileSync(
      join(dir, METRICS_FILE_NAME),
      `garbage\n${line("respondida", NOW - HOUR, { esperaMs: 10, agenteMs: 20, envioMs: 30 })}\n{"half":\n`,
    );
    writeFileSync(join(dir, "opencat-ponte.json"), JSON.stringify({ enabled: true, agentId: "agent-1" }));
    const report = await readAttendanceReport(dir, "today", NOW);
    expect(report.totals).toMatchObject({ received: 1, answered: 1 });
    expect(report.latencyOverall.p50).toBe(60);
    expect(report.connection).toMatchObject({ agentId: "agent-1", enabled: true });
  });

  it("reads only a bounded tail of a large file and caps the rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atendimento-"));
    const rows = Array.from({ length: METRICS_ROW_LIMIT + 500 }, () => line("recebida", NOW - HOUR));
    writeFileSync(join(dir, METRICS_FILE_NAME), `${rows.join("\n")}\n`);
    const report = await readAttendanceReport(dir, "today", NOW);
    expect(report.totals.received).toBeLessThanOrEqual(METRICS_ROW_LIMIT);
    expect(report.totals.received).toBeGreaterThan(0);
  });

  it("never puts more than a hash prefix in the report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atendimento-"));
    writeFileSync(
      join(dir, METRICS_FILE_NAME),
      `${line("humano", NOW - HOUR, { texto: "secret words", numero: "5511999999999" })}\n`,
    );
    const text = JSON.stringify(await readAttendanceReport(dir, "today", NOW));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("5511");
    expect(text).not.toContain("aa11bb22cc");
  });
});
