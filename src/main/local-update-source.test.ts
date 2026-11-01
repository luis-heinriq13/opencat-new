// @vitest-environment node

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundlePathFromExecutable, type LocalUpdateDependencies, readLocalUpdate } from "./local-update-source";

const COMMIT = "a".repeat(40);
const OLD_COMMIT = "b".repeat(40);
const uid = process.getuid?.() ?? 0;

let root: string;
let updates: string;
let app: string;

type Fields = { [key: string]: string | number | boolean | (string | number)[] };

function manifest(overrides: Fields = {}): string {
  return JSON.stringify({
    schema: 1,
    commit: COMMIT,
    version: "1.2.3",
    builtAt: "2026-11-01T10:00:00Z",
    appPath: app,
    changes: ["Fix the calendar", "Add the update button"],
    ...overrides,
  });
}

async function writePending(text: string): Promise<void> {
  const path = join(updates, "pending.json");
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

function deps(overrides: Partial<LocalUpdateDependencies> = {}): LocalUpdateDependencies {
  return {
    paths: { updatesDirectory: updates, expectedAppPath: app },
    uid,
    ownTeamId: async () => "TEAM123456",
    codesign: async () => ({ valid: true, teamId: "TEAM123456" }),
    ...overrides,
  };
}

async function reasonOf(overrides?: Partial<LocalUpdateDependencies>): Promise<string> {
  const result = await readLocalUpdate(deps(overrides));
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencat-update-"));
  updates = join(root, "OpenCat-updates");
  app = join(root, "dist", "OpenBot.app");
  await mkdir(updates, { mode: 0o700 });
  await chmod(updates, 0o700);
  await mkdir(app, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readLocalUpdate", () => {
  it("accepts a valid manifest", async () => {
    await writePending(manifest());
    const result = await readLocalUpdate(deps());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.update.changes).toEqual(["Fix the calendar", "Add the update button"]);
  });

  it("is quiet when there is no manifest", async () => {
    expect(await reasonOf()).toContain("pending.json is missing");
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["an unknown field", manifest({ extra: true })],
    ["a wrong schema number", manifest({ schema: 2 })],
    ["a short commit", manifest({ commit: "abc123" })],
    ["a version with spaces", manifest({ version: "1 2" })],
    ["a bad date", manifest({ builtAt: "yesterday" })],
    ["no changes", manifest({ changes: [] })],
    ["a change that is not text", manifest({ changes: [1] })],
    ["a change with a control character", manifest({ changes: ["a\u0007b"] })],
    ["too many changes", manifest({ changes: Array.from({ length: 51 }, () => "x") })],
  ])("rejects %s", async (_name, text) => {
    await writePending(text);
    expect((await readLocalUpdate(deps())).ok).toBe(false);
  });

  it("rejects an app path other than the build path", async () => {
    await writePending(manifest({ appPath: "/Applications/Other.app" }));
    expect(await reasonOf()).toContain("appPath");
  });

  it("rejects a symbolic link as pending.json", async () => {
    const real = join(root, "real.json");
    await writeFile(real, manifest(), { mode: 0o600 });
    await symlink(real, join(updates, "pending.json"));
    expect(await reasonOf()).toContain("symbolic link");
  });

  it("rejects a symbolic link as the build", async () => {
    await writePending(manifest());
    await rm(app, { recursive: true });
    await mkdir(join(root, "elsewhere.app"));
    await symlink(join(root, "elsewhere.app"), app);
    expect(await reasonOf()).toContain("symbolic link");
  });

  it("rejects a file owned by another user", async () => {
    await writePending(manifest());
    expect(await reasonOf({ uid: uid + 1 })).toContain("another user");
  });

  it("rejects a manifest that other users can write", async () => {
    await writePending(manifest());
    await chmod(join(updates, "pending.json"), 0o666);
    expect(await reasonOf()).toContain("writable");
  });

  it("rejects the commit that is already installed", async () => {
    await writePending(manifest());
    await writeFile(join(updates, "installed.json"), JSON.stringify({ commit: COMMIT }), { mode: 0o600 });
    expect(await reasonOf()).toContain("already installed");
  });

  it("accepts a commit that differs from the installed one", async () => {
    await writePending(manifest());
    await writeFile(join(updates, "installed.json"), JSON.stringify({ commit: OLD_COMMIT }), { mode: 0o600 });
    expect((await readLocalUpdate(deps())).ok).toBe(true);
  });

  it("rejects a bad signature", async () => {
    await writePending(manifest());
    expect(await reasonOf({ codesign: async () => ({ valid: false, teamId: null }) })).toContain("signature");
  });

  it("rejects another Team ID", async () => {
    await writePending(manifest());
    expect(await reasonOf({ codesign: async () => ({ valid: true, teamId: "OTHER00000" }) })).toContain("Team ID");
  });

  it("rejects when the running app has no Team ID", async () => {
    await writePending(manifest());
    expect(await reasonOf({ ownTeamId: async () => null })).toContain("no Team ID");
  });
});

describe("bundlePathFromExecutable", () => {
  it("finds the bundle", () => {
    expect(bundlePathFromExecutable("/Applications/OpenCat.app/Contents/MacOS/OpenBot")).toBe(
      "/Applications/OpenCat.app",
    );
    expect(bundlePathFromExecutable("/usr/bin/node")).toBeNull();
  });
});
