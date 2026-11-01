import type { ChannelMessage } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { channelConversationRows } from "./channel-conversation-rows";

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
