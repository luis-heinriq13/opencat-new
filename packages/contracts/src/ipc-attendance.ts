/**
 * The attendance report of the WhatsApp (not official) connection. The bridge keeps one line per event in a
 * local metrics file. Main reads it and sends this report. It holds counts, times and a short hash label per
 * conversation. It never holds a message, a phone number, a chat id or a name.
 */
import type { AppConnectionStatus } from "./ipc-app-connections";

export const ATTENDANCE_PERIODS = ["today", "7d", "30d"] as const;
export type AttendancePeriod = (typeof ATTENDANCE_PERIODS)[number];

/** The events the bridge writes. */
export const ATTENDANCE_EVENTS = ["recebida", "respondida", "falhou", "bloqueada", "humano", "pausada"] as const;
export type AttendanceEvent = (typeof ATTENDANCE_EVENTS)[number];

export const ATTENDANCE_ERROR_CATEGORIES = ["limite", "motor", "entrega", "agente", "outro"] as const;
export type AttendanceErrorCategory = (typeof ATTENDANCE_ERROR_CATEGORIES)[number];

export type AttendanceKind = "contact" | "group";

/** One bucket of the chart: messages received and answered in a span of hours. */
export interface AttendanceBucket {
  /** The start of the span, in milliseconds since the epoch. */
  start: number;
  received: number;
  answered: number;
}

export interface AttendanceLatencyHour {
  /** The hour of the day, 0 to 23, in the time zone of the computer. */
  hour: number;
  /** Milliseconds, or null when no answer was sent in that hour. */
  p50: number | null;
  p90: number | null;
  answers: number;
  failures: number;
}

/** A conversation that needs a person. The label comes from the hash only. */
export interface AttendanceAttentionItem {
  at: number;
  /** The first characters of the conversation hash. */
  ref: string;
  kind: AttendanceKind;
  event: "humano" | "bloqueada" | "falhou";
  category: AttendanceErrorCategory | null;
}

export interface AttendanceReport {
  period: AttendancePeriod;
  generatedAt: number;
  /** The bridge wrote at least one event in the last 90 days. */
  hasData: boolean;
  connection: AppConnectionStatus;
  totals: {
    received: number;
    answered: number;
    handoff: number;
    blocked: number;
    failed: number;
    paused: number;
    conversations: number;
  };
  /** Answered replies in the span before this one, for the trend. */
  previousAnswered: number;
  /** Hours in each bucket of `buckets`. */
  bucketHours: number;
  buckets: AttendanceBucket[];
  /** Received messages by weekday (0 is Sunday) and hour. */
  heatmap: number[][];
  latency: AttendanceLatencyHour[];
  latencyOverall: { p50: number | null; p90: number | null };
  attention: AttendanceAttentionItem[];
  failures: { category: AttendanceErrorCategory; count: number }[];
}
