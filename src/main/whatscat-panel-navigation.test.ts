import { describe, expect, it } from "vitest";
import { isPanelCloseUrl, isPanelUrlAllowed } from "./whatscat-panel-navigation";

const panel = "http://127.0.0.1:4100/abc123/";

describe("whatscat panel navigation", () => {
  it("allows only the panel's own loopback origin and secret path", () => {
    expect(isPanelUrlAllowed(panel, "http://127.0.0.1:4100/abc123/estado")).toBe(true);
    expect(isPanelUrlAllowed(panel, "http://127.0.0.1:4100/other/")).toBe(false);
    expect(isPanelUrlAllowed(panel, "http://127.0.0.1:4101/abc123/")).toBe(false);
    expect(isPanelUrlAllowed(panel, "https://evil.example/abc123/")).toBe(false);
    expect(isPanelUrlAllowed(panel, "not a url")).toBe(false);
  });

  it("recognises only the close route of this panel", () => {
    expect(isPanelCloseUrl(panel, "http://127.0.0.1:4100/abc123/fechar")).toBe(true);
    expect(isPanelCloseUrl(panel, "http://127.0.0.1:4100/abc123/estado")).toBe(false);
    expect(isPanelCloseUrl(panel, "http://127.0.0.1:4100/zzz/fechar")).toBe(false);
    expect(isPanelCloseUrl(panel, "https://evil.example/abc123/fechar")).toBe(false);
  });
});
