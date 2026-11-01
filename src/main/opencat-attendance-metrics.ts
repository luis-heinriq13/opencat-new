// OpenCat: the attendance report of the WhatsApp (not official) connection. The bridge writes one line per event to
// opencat-ponte-metricas.jsonl (and rotates it to .1 by size). This module reads a bounded tail of both files and
// turns the lines into counts. It never keeps a message, a phone number or a chat id: a line has none, and the
// report holds only the first characters of the conversation hash.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTENDANCE_ERROR_CATEGORIES,
  ATTENDANCE_EVENTS,
  type AttendanceAttentionItem,
  type AttendanceBucket,
  type AttendanceErrorCategory,
  type AttendanceEvent,
  type AttendanceKind,
  type AttendanceLatencyHour,
  type AttendancePeriod,
  type AttendanceReport,
  NO_APP_CONNECTION,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import { readAppConnection } from "./opencat-app-connections";

export const METRICS_FILE_NAME = "opencat-ponte-metricas.jsonl";
/** Rows older than this are never read into a report. */
export const METRICS_RETENTION_DAYS = 90;
/** The most bytes read from one file. The bridge rotates at 1 MB, so a normal file is read whole. */
export const METRICS_READ_LIMIT_BYTES = 2_000_000;
/** The most rows kept after parsing, newest last. */
export const METRICS_ROW_LIMIT = 20_000;
const ATTENTION_LIMIT = 20;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PERIOD_DAYS: Record<AttendancePeriod, number> = { today: 1, "7d": 7, "30d": 30 };

export interface MetricRow {
  at: number;
  conversation: string;
  kind: AttendanceKind;
  event: AttendanceEvent;
  waitMs: number;
  agentMs: number;
  sendMs: number;
  error: string | null;
}

function duration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, DAY) : 0;
}

/** One line of the file, or null when it is not a valid row. A bad line never stops the report. */
export function parseMetricLine(line: string): MetricRow | null {
  if (line.length === 0 || line.length > 2_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isDynamicRecord(value)) return null;
  const at = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
  const event = value.evento;
  if (!Number.isFinite(at) || !isOneOf(ATTENDANCE_EVENTS, event)) return null;
  if (typeof value.conversa !== "string" || !/^[0-9a-f]{4,64}$/i.test(value.conversa)) return null;
  return {
    at,
    conversation: value.conversa.toLowerCase(),
    kind: value.tipo === "group" ? "group" : "contact",
    event,
    waitMs: duration(value.esperaMs),
    agentMs: duration(value.agenteMs),
    sendMs: duration(value.envioMs),
    error: typeof value.erro === "string" ? value.erro.slice(0, 40) : null,
  };
}

/** The error text of the bridge as one of a few categories. Anything else is "outro". */
export function errorCategoryOf(error: string | null): AttendanceErrorCategory {
  return isOneOf(ATTENDANCE_ERROR_CATEGORIES, error) ? error : "outro";
}

/** The value at the share `p` (0 to 1) of a sorted list, by the nearest rank. Null for an empty list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? null;
}

function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalHour(time: number): number {
  const date = new Date(time);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** The first moment of a period. "Today" starts at local midnight; the others count whole days back from now. */
export function periodStart(period: AttendancePeriod, now: number): number {
  return period === "today" ? startOfLocalDay(now) : now - PERIOD_DAYS[period] * DAY;
}

/**
 * Turns rows into the report. A pure function: the rows, the period and `now` are the only input.
 * The time zone is the one of the computer, for the hour of the day and the weekday.
 */
export function aggregateAttendance(
  rows: readonly MetricRow[],
  period: AttendancePeriod,
  now: number,
): Omit<AttendanceReport, "connection"> {
  const retained = now - METRICS_RETENTION_DAYS * DAY;
  const start = periodStart(period, now);
  const length = now - start;
  const previousStart = start - length;
  const bucketHours = period === "30d" ? 6 : 1;
  const bucketSize = bucketHours * HOUR;
  const firstBucket = startOfLocalHour(start);
  const buckets: AttendanceBucket[] = [];
  for (let at = firstBucket; at <= now; at += bucketSize) buckets.push({ start: at, received: 0, answered: 0 });

  const totals = { received: 0, answered: 0, handoff: 0, blocked: 0, failed: 0, paused: 0, conversations: 0 };
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hourly = Array.from({ length: 24 }, (): { times: number[]; failures: number } => ({ times: [], failures: 0 }));
  const allTimes: number[] = [];
  const failures = new Map<AttendanceErrorCategory, number>();
  const attention: AttendanceAttentionItem[] = [];
  const conversations = new Set<string>();
  let previousAnswered = 0;
  let hasData = false;

  for (const row of rows) {
    if (row.at < retained || row.at > now + HOUR) continue;
    hasData = true;
    if (row.event === "respondida" && row.at >= previousStart && row.at < start) previousAnswered += 1;
    if (row.at < start || row.at > now) continue;
    conversations.add(row.conversation);
    const date = new Date(row.at);
    const hour = date.getHours();
    const bucket = buckets[Math.min(buckets.length - 1, Math.max(0, Math.floor((row.at - firstBucket) / bucketSize)))];
    switch (row.event) {
      case "recebida": {
        totals.received += 1;
        if (bucket) bucket.received += 1;
        const dayRow = heatmap[date.getDay()];
        if (dayRow) dayRow[hour] = (dayRow[hour] ?? 0) + 1;
        break;
      }
      case "respondida": {
        totals.answered += 1;
        if (bucket) bucket.answered += 1;
        const total = row.waitMs + row.agentMs + row.sendMs;
        hourly[hour]?.times.push(total);
        allTimes.push(total);
        break;
      }
      case "humano":
        totals.handoff += 1;
        attention.push({
          at: row.at,
          ref: row.conversation.slice(0, 6),
          kind: row.kind,
          event: "humano",
          category: null,
        });
        break;
      case "bloqueada":
        totals.blocked += 1;
        attention.push({
          at: row.at,
          ref: row.conversation.slice(0, 6),
          kind: row.kind,
          event: "bloqueada",
          category: null,
        });
        break;
      case "falhou": {
        const category = errorCategoryOf(row.error);
        totals.failed += 1;
        const slot = hourly[hour];
        if (slot) slot.failures += 1;
        failures.set(category, (failures.get(category) ?? 0) + 1);
        attention.push({ at: row.at, ref: row.conversation.slice(0, 6), kind: row.kind, event: "falhou", category });
        break;
      }
      case "pausada":
        totals.paused += 1;
        break;
    }
  }
  totals.conversations = conversations.size;

  const latency: AttendanceLatencyHour[] = hourly.map((entry, hour) => {
    const sorted = [...entry.times].sort((a, b) => a - b);
    return {
      hour,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      answers: sorted.length,
      failures: entry.failures,
    };
  });
  const sortedAll = [...allTimes].sort((a, b) => a - b);
  return {
    period,
    generatedAt: now,
    hasData,
    totals,
    previousAnswered,
    bucketHours,
    buckets,
    heatmap,
    latency,
    latencyOverall: { p50: percentile(sortedAll, 0.5), p90: percentile(sortedAll, 0.9) },
    attention: attention.sort((a, b) => b.at - a.at).slice(0, ATTENTION_LIMIT),
    failures: [...failures].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
  };
}

/** The last bytes of a file as text, from the first full line. A missing or unreadable file reads as empty. */
async function readTail(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const { size } = await stat(file);
    handle = await open(file, "r");
    const length = Math.min(size, METRICS_READ_LIMIT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    if (size <= length) return text;
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

/** The valid rows of the file and of its rotated copy, oldest first, at most `METRICS_ROW_LIMIT`. */
export async function readMetricRows(dataDirectory: string, now: number): Promise<MetricRow[]> {
  const file = join(dataDirectory, METRICS_FILE_NAME);
  const [rotated, current] = await Promise.all([readTail(`${file}.1`), readTail(file)]);
  const oldest = now - METRICS_RETENTION_DAYS * DAY;
  const rows: MetricRow[] = [];
  for (const line of `${rotated}\n${current}`.split("\n")) {
    const row = parseMetricLine(line.trim());
    if (row && row.at >= oldest) rows.push(row);
  }
  return rows.length > METRICS_ROW_LIMIT ? rows.slice(rows.length - METRICS_ROW_LIMIT) : rows;
}

/** The report for a period. A missing or unreadable file gives an empty report, never an error. */
export async function readAttendanceReport(
  dataDirectory: string,
  period: AttendancePeriod,
  now: number = Date.now(),
): Promise<AttendanceReport> {
  const [rows, connection] = await Promise.all([
    readMetricRows(dataDirectory, now),
    readAppConnection(dataDirectory).catch(() => NO_APP_CONNECTION),
  ]);
  return { ...aggregateAttendance(rows, period, now), connection };
}
