import { type ConversationMessage, MODEL_SWITCH_ITEM_TYPES } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { toAgentMessages } from "./app-message-projection";

function switchNote(id: string, text: string): ConversationMessage {
  return {
    id,
    author: "system",
    source: "system",
    text,
    createdAt: "2026-10-31T16:00:00.000Z",
    status: "completed",
    itemType: MODEL_SWITCH_ITEM_TYPES["usage-limit"],
  } as ConversationMessage;
}

function userMessage(id: string): ConversationMessage {
  return {
    id,
    author: "user",
    source: "user",
    text: "oi",
    createdAt: "2026-10-31T16:00:00.000Z",
    status: "completed",
  } as ConversationMessage;
}

describe("model switch notes", () => {
  it("shows a run of switches as one row with the newest note", () => {
    const rows = toAgentMessages([switchNote("a", "Luna"), switchNote("b", "Terra"), switchNote("c", "Sonnet")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("c");
    expect(rows[0]?.actionMarker).toMatchObject({ kind: "model-switch", text: "Sonnet", repeated: 3 });
  });

  it("keeps a single switch as it is", () => {
    const rows = toAgentMessages([switchNote("a", "Luna")]);
    expect(rows[0]?.actionMarker).not.toHaveProperty("repeated");
  });

  it("does not merge switches that another message separates", () => {
    const rows = toAgentMessages([switchNote("a", "Luna"), userMessage("u"), switchNote("b", "Terra")]);
    expect(rows).toHaveLength(3);
  });
});
