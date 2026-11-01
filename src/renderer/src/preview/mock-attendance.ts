import {
  type AppConnectionStatus,
  type AttendancePeriod,
  type AttendanceReport,
  NO_APP_CONNECTION,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD_DAYS: Record<AttendancePeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/** A fixed pseudo-random number from 0 to 1, so a story looks the same on every render. */
function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

export const MOCK_CONNECTION: AppConnectionStatus = {
  ...NO_APP_CONNECTION,
  configured: true,
  agentId: "agent-demo",
  enabled: true,
  reply: "auto",
  scope: "selected",
  chatCount: 12,
  groupCount: 2,
};

/**
 * A fictional report with a workday rhythm: busy at noon and in the evening, quiet at night. It holds no
 * real conversation, only counts and invented hash labels.
 */
export function mockAttendanceReport(
  period: AttendancePeriod,
  now: number,
  connection: AppConnectionStatus = MOCK_CONNECTION,
): AttendanceReport {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = period === "today" ? today.getTime() : now - PERIOD_DAYS[period] * DAY;
  const bucketHours = period === "30d" ? 6 : 1;
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  const buckets: AttendanceReport["buckets"] = [];
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (let at = first.getTime(), index = 0; at <= now; at += bucketHours * HOUR, index += 1) {
    let received = 0;
    for (let offset = 0; offset < bucketHours; offset += 1) {
      const date = new Date(at + offset * HOUR);
      const hour = date.getHours();
      const rhythm = Math.exp(-((hour - 12) ** 2) / 18) + 0.8 * Math.exp(-((hour - 20) ** 2) / 8) + 0.05;
      const weekend = date.getDay() === 0 || date.getDay() === 6 ? 0.6 : 1;
      const count = Math.round(rhythm * weekend * (3 + noise(at / HOUR + offset) * 5));
      received += count;
      const dayRow = heatmap[date.getDay()];
      if (dayRow) dayRow[hour] = (dayRow[hour] ?? 0) + count;
    }
    buckets.push({ start: at, received, answered: Math.round(received * (0.82 + noise(index) * 0.1)) });
  }
  const received = buckets.reduce((sum, bucket) => sum + bucket.received, 0);
  const answered = buckets.reduce((sum, bucket) => sum + bucket.answered, 0);
  const handoff = Math.round(received * 0.06);
  const blocked = Math.round(received * 0.015);
  const failed = Math.round(received * 0.02);
  const latency = Array.from({ length: 24 }, (_, hour) => {
    const busy = Math.exp(-((hour - 12) ** 2) / 18);
    const quiet = hour < 6 || hour > 22;
    const answers = quiet ? 0 : Math.round(2 + busy * 20 + noise(hour) * 4);
    return {
      hour,
      p50: answers ? Math.round(4_000 + busy * 9_000 + noise(hour + 3) * 2_000) : null,
      p90: answers ? Math.round(12_000 + busy * 30_000 + noise(hour + 5) * 8_000) : null,
      answers,
      failures: !quiet && noise(hour + 9) > 0.78 ? 1 + Math.round(noise(hour + 11) * 2) : 0,
    };
  });
  const refs = ["a3f9c1", "7be204", "c0d8a5", "19ae77", "f4420b", "5d6e13"] as const;
  return {
    period,
    generatedAt: now,
    hasData: true,
    connection,
    totals: {
      received,
      answered,
      handoff,
      blocked,
      failed,
      paused: 1,
      conversations: Math.max(3, Math.round(received / 6)),
    },
    previousAnswered: Math.round(answered * 0.88),
    bucketHours,
    buckets,
    heatmap,
    latency,
    latencyOverall: { p50: 7_400, p90: 31_000 },
    attention: [
      { at: now - 25 * 60_000, ref: refs[0], kind: "contact", event: "humano", category: null },
      { at: now - 3 * HOUR, ref: refs[1], kind: "contact", event: "falhou", category: "limite" },
      { at: now - 5 * HOUR, ref: refs[2], kind: "group", event: "bloqueada", category: null },
      { at: now - 9 * HOUR, ref: refs[3], kind: "contact", event: "humano", category: null },
      { at: now - 26 * HOUR, ref: refs[4], kind: "contact", event: "falhou", category: "motor" },
    ],
    failures: [
      { category: "limite", count: Math.max(1, Math.round(failed * 0.5)) },
      { category: "motor", count: Math.max(1, Math.round(failed * 0.3)) },
      { category: "entrega", count: Math.max(1, Math.round(failed * 0.2)) },
    ],
  };
}

/** The same report with no events and no agent: a new install. */
export function emptyAttendanceReport(period: AttendancePeriod, now: number): AttendanceReport {
  return {
    ...mockAttendanceReport(period, now, NO_APP_CONNECTION),
    hasData: false,
    totals: { received: 0, answered: 0, handoff: 0, blocked: 0, failed: 0, paused: 0, conversations: 0 },
    previousAnswered: 0,
    buckets: [],
    heatmap: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
    latency: Array.from({ length: 24 }, (_, hour) => ({ hour, p50: null, p90: null, answers: 0, failures: 0 })),
    latencyOverall: { p50: null, p90: null },
    attention: [],
    failures: [],
  };
}

/** The preview answers with the fictional report. */
export function createMockAttendance(): OpenBotDesktopApi["attendance"] {
  return { report: async (period) => mockAttendanceReport(period, Date.now()) };
}
