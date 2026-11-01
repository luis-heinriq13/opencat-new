// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAVEMAN_SKILL_SLUG, removeRetiredManagedSkills } from "./managed-skill-service";

// Same bytes and marker that ManagedSkillService writes for the caveman skill.
const SKILL_TEXT = "---\nname: caveman\ndescription: Test skill.\n---\n\n# caveman\n";
const MARKER_TEXT = `${JSON.stringify({ managedBy: "openbot", slug: "caveman", version: 1 })}\n`;
const RETIRED = [{ slug: CAVEMAN_SKILL_SLUG, sha256: [createHash("sha256").update(SKILL_TEXT).digest("hex")] }];

let root: string;
let workspace: string;

/** Writes a managed copy into one skill folder, with the marker the service writes. */
async function writeManagedCopy(folder: string, content = SKILL_TEXT): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), content, "utf8");
  await writeFile(join(folder, ".openbot-managed.json"), MARKER_TEXT, "utf8");
}

async function exists(path: string): Promise<boolean> {
  return readFile(path, "utf8").then(
    () => true,
    () => false,
  );
}

async function cleanup(retired = RETIRED): Promise<void> {
  await Effect.runPromise(removeRetiredManagedSkills([{ workspacePath: workspace }], retired));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-managed-skill-"));
  workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("removeRetiredManagedSkills", () => {
  it("removes an unedited managed copy from both skill folders", async () => {
    const agentsFolder = join(workspace, ".agents", "skills", "caveman");
    const claudeFolder = join(workspace, ".claude", "skills", "caveman");
    await writeManagedCopy(agentsFolder);
    await writeManagedCopy(claudeFolder);

    await cleanup();

    expect(await exists(join(agentsFolder, "SKILL.md"))).toBe(false);
    expect(await exists(claudeFolder)).toBe(false);
    expect(await exists(agentsFolder)).toBe(false);
  });

  it("keeps a copy whose SKILL.md the user edited", async () => {
    const folder = join(workspace, ".agents", "skills", "caveman");
    await writeManagedCopy(folder, `${SKILL_TEXT}\nMy own rule.\n`);

    await cleanup();

    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(`${SKILL_TEXT}\nMy own rule.\n`);
  });

  it("keeps a copy without the OpenBot ownership marker", async () => {
    const folder = join(workspace, ".claude", "skills", "caveman");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), SKILL_TEXT, "utf8");

    await cleanup();

    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  });

  it("keeps a copy whose marker names another slug", async () => {
    const folder = join(workspace, ".agents", "skills", "caveman");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), SKILL_TEXT, "utf8");
    await writeFile(
      join(folder, ".openbot-managed.json"),
      `${JSON.stringify({ managedBy: "openbot", slug: "other", version: 1 })}\n`,
      "utf8",
    );

    await cleanup();

    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  });

  it("keeps the folder when the user added another file to it", async () => {
    const folder = join(workspace, ".agents", "skills", "caveman");
    await writeManagedCopy(folder);
    await writeFile(join(folder, "notes.md"), "keep me", "utf8");

    await cleanup();

    expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("keep me");
    expect(await exists(join(folder, "SKILL.md"))).toBe(true);
    expect(await exists(join(folder, ".openbot-managed.json"))).toBe(true);
  });

  it("does not follow a symlinked skill folder out of the workspace", async () => {
    const outside = join(root, "outside");
    await writeManagedCopy(outside);
    await mkdir(join(workspace, ".claude", "skills"), { recursive: true });
    await symlink(outside, join(workspace, ".claude", "skills", "caveman"));

    await cleanup();

    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
    expect(await readFile(join(outside, ".openbot-managed.json"), "utf8")).toBe(MARKER_TEXT);
  });

  it("leaves memories, agent files and other skills untouched", async () => {
    await writeManagedCopy(join(workspace, ".agents", "skills", "caveman"));
    const keep = [
      join(workspace, "AGENTS.md"),
      join(workspace, "memory", "notes.md"),
      join(workspace, ".agents", "skills", "my-skill", "SKILL.md"),
    ];
    for (const path of keep) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "keep", "utf8");
    }

    await cleanup();

    for (const path of keep) expect(await readFile(path, "utf8")).toBe("keep");
  });

  it("does nothing when a workspace has no managed copy", async () => {
    await writeFile(join(workspace, "AGENTS.md"), "keep", "utf8");

    await cleanup();

    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("keep");
  });

  it("does not remove a copy whose content hash is not in the retired list", async () => {
    const folder = join(workspace, ".agents", "skills", "caveman");
    await writeManagedCopy(folder);

    await cleanup([{ slug: CAVEMAN_SKILL_SLUG, sha256: [createHash("sha256").update("x").digest("hex")] }]);

    expect(await exists(join(folder, "SKILL.md"))).toBe(true);
  });

  it("removes nothing when the retired list is empty", async () => {
    const folder = join(workspace, ".claude", "skills", "caveman");
    await writeManagedCopy(folder);

    await cleanup([]);

    expect(await exists(join(folder, "SKILL.md"))).toBe(true);
  });
});
