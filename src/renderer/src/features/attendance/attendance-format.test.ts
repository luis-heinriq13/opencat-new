import {
  attendanceTrend,
  DEFAULT_MINUTES_PER_REPLY,
  heatLevel,
  parseMinutesPerReply,
  peakCell,
  savedMinutes,
  sparklineSeries,
} from "@openbot/ui/features/attendance/attendance-format";
import { describe, expect, it } from "vitest";

describe("attendance format", () => {
  it("estimates the time saved from replies and the user's minutes", () => {
    expect(savedMinutes(40, 2)).toBe(80);
    expect(savedMinutes(3, 1.5)).toBe(5);
  });

  it("falls back to the default minutes for a bad saved value", () => {
    expect(parseMinutesPerReply("3,5")).toBe(3.5);
    expect(parseMinutesPerReply("0")).toBe(DEFAULT_MINUTES_PER_REPLY);
    expect(parseMinutesPerReply("abc")).toBe(DEFAULT_MINUTES_PER_REPLY);
    expect(parseMinutesPerReply(null)).toBe(DEFAULT_MINUTES_PER_REPLY);
    expect(parseMinutesPerReply(9999)).toBe(DEFAULT_MINUTES_PER_REPLY);
  });

  it("compares with the span before", () => {
    expect(attendanceTrend(0, 0).kind).toBe("none");
    expect(attendanceTrend(5, 0).kind).toBe("new");
    expect(attendanceTrend(12, 10)).toEqual({ kind: "up", percent: 20 });
    expect(attendanceTrend(5, 10)).toEqual({ kind: "down", percent: 50 });
    expect(attendanceTrend(10, 10).kind).toBe("same");
  });

  it("scales heat levels and finds the peak", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(10, 10)).toBe(4);
    const heatmap = [
      [0, 2],
      [5, 1],
    ];
    expect(peakCell(heatmap)).toEqual({ day: 1, hour: 0, count: 5 });
    expect(peakCell([[0, 0]])).toBeNull();
  });

  it("groups the buckets for the trend line", () => {
    const buckets = Array.from({ length: 56 }, (_, index) => ({ start: index, received: 0, answered: 1 }));
    const series = sparklineSeries(buckets, 28);
    expect(series).toHaveLength(28);
    expect(series.every((value) => value === 2)).toBe(true);
  });
});
