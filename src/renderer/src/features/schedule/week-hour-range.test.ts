import { weekHourRange } from "@openbot/ui/features/conversation/routine-calendar-week";
import { describe, expect, it } from "vitest";

describe("weekHourRange", () => {
  it("shows the working day for a week with no run", () => {
    expect(weekHourRange([])).toEqual({ first: 8, last: 17 });
  });

  it("grows a short range to eight rows", () => {
    expect(weekHourRange([9, 10])).toEqual({ first: 9, last: 16 });
  });

  it("keeps the hours that have runs", () => {
    expect(weekHourRange([7, 14, 17])).toEqual({ first: 7, last: 17 });
  });

  it("grows towards the morning when the range meets midnight", () => {
    expect(weekHourRange([22, 23])).toEqual({ first: 16, last: 23 });
  });
});
