import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The bundled servers are plain JavaScript.
import { createSendLimiter } from "../../tools/whatscat/mcp-stdio.mjs";

function limiter(clock: { now: number }) {
  return createSendLimiter({
    file: join(mkdtempSync(join(tmpdir(), "limites-")), "limites.json"),
    minGapMs: 20_000,
    jitterMs: 0,
    perHour: 2,
    perDay: 3,
    now: () => clock.now,
  });
}

describe("send limiter", () => {
  it("waits between sends and refuses over the hourly limit", () => {
    const clock = { now: 1_000_000_000 };
    const limit = limiter(clock);
    expect(limit.check()).toBe(0);
    limit.record();
    expect(limit.check()).toBe(20_000);
    clock.now += 30_000;
    expect(limit.check()).toBe(0);
    limit.record();
    clock.now += 30_000;
    expect(() => limit.check()).toThrow(/por hora/);
  });

  it("refuses over the daily limit even after the hour passes", () => {
    const clock = { now: 1_000_000_000 };
    const limit = limiter(clock);
    for (let index = 0; index < 3; index += 1) {
      limit.record();
      clock.now += 3_600_001;
    }
    expect(() => limit.check()).toThrow(/diário/);
    clock.now += 86_400_000;
    expect(limit.check()).toBe(0);
  });
});
