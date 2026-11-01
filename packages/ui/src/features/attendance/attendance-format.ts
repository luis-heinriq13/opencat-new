import type { AttendanceReport } from "@openbot/contracts/ipc";

/** Minutes saved by one reply until the user sets their own average. */
export const DEFAULT_MINUTES_PER_REPLY = 2;
export const MAX_MINUTES_PER_REPLY = 240;

/** The estimate of the time saved: replies times the average minutes one reply takes a person. */
export function savedMinutes(answered: number, minutesPerReply: number): number {
  return Math.round(answered * minutesPerReply);
}

/** A saved value from storage, or the default when it is missing or not a sensible number. */
export function parseMinutesPerReply(value: unknown): number {
  const number = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  return Number.isFinite(number) && number > 0 && number <= MAX_MINUTES_PER_REPLY ? number : DEFAULT_MINUTES_PER_REPLY;
}

export type AttendanceTrend = { kind: "up" | "down"; percent: number } | { kind: "same" | "new" | "none"; percent: 0 };

/** How the answered replies compare with the span before. */
export function attendanceTrend(answered: number, previous: number): AttendanceTrend {
  if (previous === 0) return answered === 0 ? { kind: "none", percent: 0 } : { kind: "new", percent: 0 };
  const percent = Math.round((Math.abs(answered - previous) / previous) * 100);
  if (percent === 0) return { kind: "same", percent: 0 };
  return { kind: answered > previous ? "up" : "down", percent };
}

/** The share of the received messages, 0 to 1. */
export function shareOf(value: number, received: number): number {
  return received > 0 ? Math.min(1, value / received) : 0;
}

/** The intensity of a heatmap cell: 0 for none, then 1 to 4 against the busiest cell. */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const level = Math.ceil((count / max) * 4);
  if (level <= 1) return 1;
  if (level === 2) return 2;
  return level === 3 ? 3 : 4;
}

/** The busiest weekday and hour, or null when nothing was received. */
export function peakCell(heatmap: readonly (readonly number[])[]): { day: number; hour: number; count: number } | null {
  let best: { day: number; hour: number; count: number } | null = null;
  heatmap.forEach((row, day) => {
    row.forEach((count, hour) => {
      if (count > 0 && (best === null || count > best.count)) best = { day, hour, count };
    });
  });
  return best;
}

/** Answered replies in at most `points` groups of buckets, for the small trend line. */
export function sparklineSeries(buckets: AttendanceReport["buckets"], points = 28): number[] {
  if (buckets.length === 0) return [];
  const size = Math.max(1, Math.ceil(buckets.length / points));
  const series: number[] = [];
  for (let index = 0; index < buckets.length; index += size) {
    series.push(buckets.slice(index, index + size).reduce((sum, bucket) => sum + bucket.answered, 0));
  }
  return series;
}
