// @vitest-environment node

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../agent-store";
import { UsageLimitGate } from "./usage-limit-gate";

const agent = (id: string, model: string, provider = "opencode") => ({ id, model, provider });

function makeGate(agents: ReturnType<typeof agent>[]) {
  const released = vi.fn(() => Effect.void);
  const gate = new UsageLimitGate({
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: the gate reads only `list` from the store.
    store: { list: () => agents } as unknown as AgentStore,
    hooks: {
      emit: vi.fn(),
      emitRuntimeSnapshot: vi.fn(),
      scheduleDrain: vi.fn(),
      readUsage: () => Effect.succeed(null),
      held: () => Effect.void,
      released,
    },
  });
  return { gate, released };
}

describe("UsageLimitGate provider errors", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares one failed model across every agent on that provider and model", () => {
    const { gate } = makeGate([agent("a", "m1"), agent("b", "m1"), agent("c", "m2")]);
    gate.failed("a");
    const key = { provider: "opencode" as const, accountId: null, model: "m1" };
    expect(gate.isFailed(key)).toBe(true);
    expect(gate.isFailed({ ...key, model: "m2" })).toBe(false);
    expect(gate.failureKey("b")).toBe(gate.failureKey("a"));
  });

  it("passes the model over for 10 minutes, then lets agents try it again", async () => {
    const { gate, released } = makeGate([agent("a", "m1")]);
    gate.failed("a");
    const key = { provider: "opencode" as const, accountId: null, model: "m1" };
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(gate.isFailed(key)).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(gate.isFailed(key)).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("ends the hold when a turn on the model completes", async () => {
    const { gate } = makeGate([agent("a", "m1")]);
    gate.failed("a");
    await Effect.runPromise(gate.completed("a"));
    expect(gate.isFailed({ provider: "opencode", accountId: null, model: "m1" })).toBe(false);
  });

  it("holds a usage limit for every agent on the model until its reset", async () => {
    const { gate } = makeGate([agent("a", "m1"), agent("b", "m1")]);
    const resetsAt = Math.floor(Date.now() / 1_000) + 3_600;
    await Effect.runPromise(gate.reached("a", resetsAt));
    expect(gate.mayDrain("b")).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_000 + 31_000);
    expect(gate.mayDrain("b")).toBe(true);
  });
});
