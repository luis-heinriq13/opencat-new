// A Google verification link reaches the user whole, and no other URL gets that exception.
import { redactText } from "@openbot/logging";
import { userErrorMessage } from "@openbot/user-errors";
import {
  findVerificationLink,
  transformAroundVerificationLink,
  truncateKeepingVerificationLink,
  withoutGoogleSignInLinks,
} from "@openbot/user-errors/verification-link";
import { describe, expect, it } from "vitest";
import { shownFailureDetail, shownGeminiFailureDetail } from "./acp-flavor";

const GOOGLE_LINK = `https://accounts.google.com/v3/signin/continue?plt=AKgnsbu96msF${"x".repeat(300)}UH&ticket=abc123456789`;
const SENTENCE = `Verify your account to continue. Verify your account: ${GOOGLE_LINK}`;

describe("Google verification link", () => {
  it("survives the failure limits and the redaction of the text around it", () => {
    expect(shownGeminiFailureDetail(SENTENCE)).toBe(SENTENCE);
    expect(transformAroundVerificationLink(SENTENCE, redactText)).toBe(SENTENCE);
    expect(userErrorMessage(SENTENCE, "fallback")).toBe(SENTENCE);
    expect(findVerificationLink(`${SENTENCE}.`)?.url).toBe(GOOGLE_LINK);
  });

  it("is still cut and redacted for the log path", () => {
    expect(redactText(SENTENCE)).toContain("ticket=[redacted]");
  });

  it("gives no exception to another host, a downgraded scheme or a hidden credential", () => {
    for (const url of [
      `https://evil.example/signin?ticket=abc123456789`,
      `http://accounts.google.com/v3/signin/continue?plt=abc`,
      `https://accounts.google.com.evil.example/signin?plt=abc`,
      `https://accounts.google.com@evil.example/signin?plt=abc`,
      `https://accounts.google.com:8443/v3/signin/continue?plt=abc`,
      `https://accounts.google.com/o/oauth2/auth?client_id=attacker`,
      `https://myaccount.google.com/v3/signin/continue?plt=abc`,
      `https://accounts.google.com/v3/signin/continue/extra?plt=abc`,
      `https://accounts.google.com/v3/signin/continue?continue=https://evil.example/`,
      `https://accounts.google.com/v3/signin/continue?continue=https%3A%2F%2Fevil.example%2F`,
      `https://accounts.google.com/v3/signin/continue?continue=https://google.com.evil.example/`,
      `https://accounts.google.com/v3/signin/continue?continue=http://gemini.google.com/`,
      `https://accounts.google.com/v3/signin/continue?continue=https://gemini.google.com/&continue=https://evil.example/`,
      `https://accounts.google.com/v3/signin/continue?followup=https://evil.example/`,
    ]) {
      expect(findVerificationLink(`Verify: ${url}`)).toBeNull();
    }
    const other = `Open https://evil.example/signin?ticket=abc123456789 ${"y".repeat(400)}`;
    expect(transformAroundVerificationLink(other, redactText)).toContain("ticket=[redacted]");
    expect(truncateKeepingVerificationLink(other, 200).length).toBeLessThanOrEqual(200);
    expect(userErrorMessage(other, "fallback")).toBe("fallback");
  });

  it("accepts the sign-in paths with a redirect that stays on Google", () => {
    for (const url of [
      `https://accounts.google.com/signin/continue?sarp=1&plt=abc`,
      `https://accounts.google.com/v3/signin/continue?continue=https%3A%2F%2Fgemini.google.com%2Fapp&plt=abc`,
    ]) {
      expect(findVerificationLink(`Verify: ${url}`)?.url).toBe(url);
    }
  });

  it("cuts the failure detail of the other providers at the link", () => {
    expect(shownFailureDetail(SENTENCE).length).toBeLessThanOrEqual(200);
  });

  it("leaves no Google sign-in link in a copy that is stored or sent to a team client", () => {
    expect(withoutGoogleSignInLinks(SENTENCE)).toBe("Verify your account to continue. Verify your account");
    expect(withoutGoogleSignInLinks("Open https://accounts.google.com/o/oauth2/auth?plt=abc now")).toBe("Open  now");
    expect(withoutGoogleSignInLinks("See https://example.com/docs?a=1.")).toBe("See https://example.com/docs?a=1.");
  });
});
