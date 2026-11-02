// @vitest-environment node

import type { ConversationSnapshot, QueueDelivery } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import type { DeliveryContext } from "../mailbox-store";
import { deliveryPromptInput } from "./delivery-content";

describe("deliveryPromptInput continuation after actions", () => {
  it("explicitly instructs the backup model not to repeat completed actions and lists past work steps", () => {
    const delivery: QueueDelivery = {
      id: "del-1",
      messageId: "msg-1",
      recipientAgentId: "agent-1",
      sender: { kind: "user" },
      text: "Envie uma mensagem e liste os arquivos.",
      attachments: [],
      replyToMessageId: null,
      status: "queued",
      position: 1,
      turnId: "turn-1",
      error: null,
      createdAt: "2026-11-02T09:00:00.000Z",
    };

    const context: DeliveryContext = {
      delivery,
      managedAttachments: [],
      resumeAfterUsageLimit: {
        turnId: "turn-1",
        previousTurnIds: ["turn-1"],
        workSteps: "openbot.send_message (completed)\nopenbot.list_files (completed)",
      },
    };

    const snapshot: ConversationSnapshot = {
      agentId: "agent-1",
      threadId: "thread-1",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "turn-1-progress",
          author: "assistant",
          text: "Mensagem enviada com sucesso para o canal.",
          createdAt: "2026-11-02T09:00:01.000Z",
          turnId: "turn-1",
          itemType: "message",
          status: "completed",
        },
      ],
    };

    const items = deliveryPromptInput(context, {
      agentNames: new Map(),
      snapshot,
      routineRun: null,
    });

    expect(items.length).toBeGreaterThan(0);
    const textItem = items[0];
    expect(textItem).toBeDefined();
    if (!textItem || textItem.type !== "text") throw new Error("Expected text item");
    const promptText = textItem.text;

    // Must warn the model not to repeat completed actions
    expect(promptText).toContain("Do not repeat completed actions");
    expect(promptText).toContain("Check the outcome of any interrupted action before you retry it");

    // Must include the recorded work steps
    expect(promptText).toContain("openbot.send_message (completed)");
    expect(promptText).toContain("openbot.list_files (completed)");

    // Must include the progress already communicated
    expect(promptText).toContain("Mensagem enviada com sucesso para o canal.");
  });
});
