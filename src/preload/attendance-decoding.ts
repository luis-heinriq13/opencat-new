// What main answers for the attendance page. The answer holds counts, times and hash labels only.

import { ATTENDANCE_ERROR_CATEGORIES, ATTENDANCE_PERIODS, type AttendanceReport } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isOneOf } from "@openbot/contracts/runtime-values";
import { decodeAppConnectionStatus } from "./app-connection-decoding";

const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every(isNumber);
const nullableNumber = (value: unknown): value is number | null => value === null || isNumber(value);

export function decodeAttendanceReport(value: unknown): AttendanceReport {
  if (
    !isDynamicRecord(value) ||
    !isOneOf(ATTENDANCE_PERIODS, value.period) ||
    !isNumber(value.generatedAt) ||
    !isBoolean(value.hasData) ||
    !isDynamicRecord(value.totals) ||
    !isNumber(value.previousAnswered) ||
    !isNumber(value.bucketHours) ||
    !Array.isArray(value.buckets) ||
    !Array.isArray(value.heatmap) ||
    !value.heatmap.every(numbers) ||
    !Array.isArray(value.latency) ||
    !isDynamicRecord(value.latencyOverall) ||
    !Array.isArray(value.attention) ||
    !Array.isArray(value.failures)
  ) {
    throw new Error("Invalid attendance report.");
  }
  const totals = value.totals;
  const count = (key: string): number => {
    const entry = totals[key];
    if (!isNumber(entry)) throw new Error("Invalid attendance report.");
    return entry;
  };
  const overall = value.latencyOverall;
  if (!nullableNumber(overall.p50) || !nullableNumber(overall.p90)) throw new Error("Invalid attendance report.");
  return {
    period: value.period,
    generatedAt: value.generatedAt,
    hasData: value.hasData,
    connection: decodeAppConnectionStatus(value.connection),
    totals: {
      received: count("received"),
      answered: count("answered"),
      handoff: count("handoff"),
      blocked: count("blocked"),
      failed: count("failed"),
      paused: count("paused"),
      conversations: count("conversations"),
    },
    previousAnswered: value.previousAnswered,
    bucketHours: value.bucketHours,
    buckets: value.buckets.map((bucket) => {
      if (
        !isDynamicRecord(bucket) ||
        !isNumber(bucket.start) ||
        !isNumber(bucket.received) ||
        !isNumber(bucket.answered)
      )
        throw new Error("Invalid attendance report.");
      return { start: bucket.start, received: bucket.received, answered: bucket.answered };
    }),
    heatmap: value.heatmap.map((row) => [...row]),
    latency: value.latency.map((hour) => {
      if (
        !isDynamicRecord(hour) ||
        !isNumber(hour.hour) ||
        !nullableNumber(hour.p50) ||
        !nullableNumber(hour.p90) ||
        !isNumber(hour.answers) ||
        !isNumber(hour.failures)
      )
        throw new Error("Invalid attendance report.");
      return { hour: hour.hour, p50: hour.p50, p90: hour.p90, answers: hour.answers, failures: hour.failures };
    }),
    latencyOverall: { p50: overall.p50, p90: overall.p90 },
    attention: value.attention.map((item) => {
      if (
        !isDynamicRecord(item) ||
        !isNumber(item.at) ||
        typeof item.ref !== "string" ||
        (item.kind !== "contact" && item.kind !== "group") ||
        (item.event !== "humano" && item.event !== "bloqueada" && item.event !== "falhou") ||
        !(item.category === null || isOneOf(ATTENDANCE_ERROR_CATEGORIES, item.category))
      )
        throw new Error("Invalid attendance report.");
      return { at: item.at, ref: item.ref.slice(0, 8), kind: item.kind, event: item.event, category: item.category };
    }),
    failures: value.failures.map((entry) => {
      if (!isDynamicRecord(entry) || !isOneOf(ATTENDANCE_ERROR_CATEGORIES, entry.category) || !isNumber(entry.count))
        throw new Error("Invalid attendance report.");
      return { category: entry.category, count: entry.count };
    }),
  };
}
