import { describe, expect, it } from "vitest";
import { classifyFailure, isRetiredModelNotice } from "../../packages/telemetry/src/events";

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

  it("treats a broken stream as a failover cause", () => {
    expect(classifyFailure("RequestError: Internal error: OpenAI Chat stream ended without finish_reason")).toBe(
      "provider_unavailable",
    );
  });

  it("keeps an unrelated error unknown", () => {
    expect(classifyFailure("The model refused this request")).toBe("unknown");
  });
});

describe("classifyFailure for a retired model", () => {
  const notice =
    "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.";

  it("treats the retirement notice as unavailable", () => {
    expect(classifyFailure(notice)).toBe("provider_unavailable");
    expect(classifyFailure(`RequestError: ${notice}`)).toBe("provider_unavailable");
    expect(isRetiredModelNotice(notice)).toBe(true);
  });

  it("does not match an answer that only mentions the phrase", () => {
    const long = `Here is the migration plan. ${"Step. ".repeat(60)}${notice}`;
    expect(isRetiredModelNotice(long)).toBe(false);
    expect(isRetiredModelNotice(`I checked: ${notice}\nThen I fixed the build.`)).toBe(false);
    expect(isRetiredModelNotice("The v1 endpoint is no longer available. Switch to v2.")).toBe(false);
    expect(isRetiredModelNotice("Gemini 3.5 Flash is no longer available.")).toBe(false);
    expect(classifyFailure("The report says the feature is no longer available in the app")).toBe("unknown");
  });
});

describe("isRetiredModelNotice with repeats", () => {
  const notice =
    "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.";

  it("matches a message that only repeats the notice", () => {
    expect(isRetiredModelNotice(Array(4).fill(notice).join(" "))).toBe(true);
    expect(isRetiredModelNotice(Array(11).fill(notice).join("\n"))).toBe(true);
    expect(isRetiredModelNotice(`${notice}\n\n${notice}  \n`)).toBe(true);
    expect(isRetiredModelNotice(`RequestError: ${notice} ${notice}`)).toBe(true);
    expect(classifyFailure(Array(3).fill(notice).join(" "))).toBe("provider_unavailable");
  });

  it("does not match repeats mixed with other text or beyond the bounds", () => {
    expect(isRetiredModelNotice(`${notice} ${notice}\nThen I fixed the build.`)).toBe(false);
    expect(isRetiredModelNotice(`Summary: ${notice} ${notice} and more`)).toBe(false);
    expect(isRetiredModelNotice(`${notice}\n${notice}\nThe v1 endpoint is no longer available. Switch to v2.`)).toBe(
      false,
    );
    expect(isRetiredModelNotice(`${notice} ${"x".repeat(200)}`)).toBe(false);
    expect(isRetiredModelNotice(Array(80).fill(notice).join(" "))).toBe(false);
    expect(isRetiredModelNotice(`${notice}${notice}`)).toBe(false);
    expect(isRetiredModelNotice("  ")).toBe(false);
  });
});
