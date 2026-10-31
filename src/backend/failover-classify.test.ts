import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../packages/telemetry/src/events";

describe("classifyFailure for provider errors seen in channels", () => {
  it("treats a stalled provider as a timeout", () => {
    expect(classifyFailure("lobo stopped responding, so OpenBot ended this turn. Send the message again.")).toBe(
      "timeout",
    );
  });

  it("treats a router with no working model as unavailable", () => {
    expect(classifyFailure("RequestError: Internal error: All fusion panel models failed")).toBe(
      "provider_unavailable",
    );
  });

  it("keeps an unrelated error unknown", () => {
    expect(classifyFailure("The model refused this request")).toBe("unknown");
  });
});
