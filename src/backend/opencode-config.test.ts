// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  OPENCODE_AGENT_CONFIG,
  OPENCODE_MAX_STEPS,
  OPENCODE_PROFILE_CONFIG,
  openCodeConfigEnv,
} from "./opencode-config";

const parse = (base: Parameters<typeof openCodeConfigEnv>[0]) =>
  JSON.parse(openCodeConfigEnv(base, () => [], null).OPENCODE_CONFIG_CONTENT ?? "{}");

describe("openCodeConfigEnv", () => {
  it("caps the build agent steps and keeps titles off for agent chats", () => {
    expect(parse(OPENCODE_AGENT_CONFIG).agent).toEqual({
      build: { steps: OPENCODE_MAX_STEPS },
      title: { disable: true },
    });
  });

  it("does not cap the profile generation session", () => {
    expect(parse(OPENCODE_PROFILE_CONFIG).agent).toEqual({ title: { disable: true } });
  });
});
