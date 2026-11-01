import type { ChannelMessage, ChannelPage, ChannelTask } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { channelConversationRows, channelWorkingTurns, stoppedChannelTasks } from "./channel-conversation-rows";

function entry(
  id: string,
  text: string,
  itemType?: string,
  author: "assistant" | "system" = "assistant",
): ChannelMessage {
  return {
    id,
    channelId: "c1",
    sequence: 1,
    taskId: null,
    superseded: false,
    author: { kind: "agent", id: "a1", name: "Agent" },
    message: {
      id,
      author,
      text,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      ...(itemType ? { itemType } : {}),
    },
  };
}

describe("channelConversationRows", () => {
  it("hides model-switch notes and retirement notices, and keeps real answers", () => {
    const rows = channelConversationRows([
      entry("1", "Moved to a backup model", "model-switch:provider-error", "system"),
      entry("2", "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash."),
      entry("3", "Done. The report is ready."),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["3"]);
  });
});

const NOTICE =
  "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.";

const NOTICE_TEXT = NOTICE;

function task(id: string, error: string | null, state: ChannelTask["state"] = "failed"): ChannelTask {
  return {
    id,
    channelId: "c1",
    parentTaskId: null,
    rootTaskId: id,
    ownerAgentId: "a1",
    requestMessageId: `m-${id}`,
    instruction: "",
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state,
    revision: 1,
    assignmentCount: 1,
    error,
  };
}

function page(tasks: ChannelTask[], messages: ChannelMessage[]): ChannelPage {
  return {
    channel: {
      id: "c1",
      name: "general",
      title: "General",
      instructions: "",
      members: [],
      leadAgentId: null,
      archived: false,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    messages,
    tasks,
    olderCursor: null,
    throughSequence: 1,
  };
}

describe("channelConversationRows with a repeated retirement notice", () => {
  it("hides final answers and commentary that only repeat the notice", () => {
    const rows = channelConversationRows([
      entry("1", Array(4).fill(NOTICE_TEXT).join(" ")),
      entry("2", Array(11).fill(NOTICE_TEXT).join("\n"), "commentary"),
      entry("3", `${NOTICE_TEXT} ${NOTICE_TEXT}\nI fixed the build.`),
      entry("4", "Done."),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["3", "4"]);
  });

  it("starts no working turn from a hidden notice", () => {
    const hidden = entry("1", NOTICE_TEXT, "commentary");
    hidden.taskId = "t1";
    hidden.message.turnId = "turn-1";
    expect(channelWorkingTurns(page([task("t1", null, "running")], [hidden]), new Set())).toEqual([]);
    const real = entry("2", "Thinking about the build", "commentary");
    real.taskId = "t1";
    real.message.turnId = "turn-2";
    expect(channelWorkingTurns(page([task("t1", null, "running")], [hidden, real]), new Set())).toEqual(["turn-2"]);
  });
});

describe("stoppedChannelTasks", () => {
  const now = Date.parse("2026-01-10T12:00:00.000Z");
  const worked = (taskId: string, createdAt: string): ChannelMessage => {
    const base = entry(`m-${taskId}`, "work");
    return { ...base, taskId, message: { ...base.message, createdAt } };
  };

  it("hides a provider error older than 24 hours and keeps newer ones", () => {
    const result = stoppedChannelTasks(
      page(
        [task("old", "429 rate limit exceeded"), task("new", "429 rate limit exceeded")],
        [worked("old", "2026-01-08T12:00:00.000Z"), worked("new", "2026-01-10T06:00:00.000Z")],
      ),
      now,
    );
    expect(result.map((item) => item.id)).toEqual(["new"]);
  });

  it("keeps an old failure that is not a provider error, and one with no known age", () => {
    const result = stoppedChannelTasks(
      page(
        [task("plain", "The build script failed"), task("unknown", "rate limit exceeded")],
        [worked("plain", "2026-01-01T00:00:00.000Z")],
      ),
      now,
    );
    expect(result.map((item) => item.id)).toEqual(["plain", "unknown"]);
  });
});
