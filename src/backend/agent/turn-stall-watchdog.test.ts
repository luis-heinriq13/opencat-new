// @vitest-environment node

import { spawn } from "node:child_process";
import { classifyFailure } from "@openbot/telemetry";
import { describe, expect, it } from "vitest";
import type { ThreadItem } from "../protocol";
import { hasLiveChildProcesses, isProcessAlive } from "../windows-process-tree";
import { isExternalActionItem } from "./turn-lifecycle";

const tool = (name: string, command?: string): ThreadItem => ({
  type: "toolCall",
  name,
  ...(command ? { command } : {}),
});

describe("Process activity and child process detection", () => {
  it("detects running process and non-existent process correctly", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });

  it("detects live child process during long-running command and clears when ended", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
      stdio: "ignore",
    });

    try {
      const hasChildren = await hasLiveChildProcesses(process.pid);
      expect(hasChildren).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }

    const deadHasChildren = await hasLiveChildProcesses(99999999);
    expect(deadHasChildren).toBe(false);
  });
});

describe("External action detection (isExternalActionItem)", () => {
  it("detects messaging actions that must not be repeated automatically", () => {
    expect(isExternalActionItem(tool("openbot.send_message"))).toBe(true);
    expect(isExternalActionItem(tool("whatscat.send_text"))).toBe(true);
    expect(isExternalActionItem(tool("teams.teams_enviar_mensagem"))).toBe(true);
    expect(isExternalActionItem(tool("send_mail"))).toBe(true);
  });

  it("detects deploys, publishes, and git push commands", () => {
    expect(isExternalActionItem(tool("openbot_site_hosting.publish_site"))).toBe(true);
    expect(isExternalActionItem(tool("deploy_edge_function"))).toBe(true);
    expect(isExternalActionItem(tool("run_command", "git push origin main"))).toBe(true);
    expect(isExternalActionItem(tool("run_command", "npm publish"))).toBe(true);
    expect(isExternalActionItem(tool("run_command", "docker push my-repo/image:latest"))).toBe(true);
  });

  it("detects financial and Stripe actions", () => {
    expect(isExternalActionItem(tool("stripe.stripe_api_write"))).toBe(true);
    expect(isExternalActionItem(tool("browser.fill_card"))).toBe(true);
    expect(isExternalActionItem(tool("browser.checkout_pay"))).toBe(true);
  });

  it("does not flag internal read or inspection tools as external actions", () => {
    expect(isExternalActionItem(tool("view_file"))).toBe(false);
    expect(isExternalActionItem(tool("search_web"))).toBe(false);
    expect(isExternalActionItem(tool("list_apps"))).toBe(false);
    expect(isExternalActionItem(tool("run_command", "git status"))).toBe(false);
    expect(isExternalActionItem(tool("run_command", "npm test"))).toBe(false);
    expect(isExternalActionItem(tool("run_command", "bun run build"))).toBe(false);
  });
});

describe("Stall failure classification across languages", () => {
  it("classifies English stalled provider error as timeout", () => {
    expect(classifyFailure("Antigravity stopped responding, so OpenBot ended this turn.")).toBe("timeout");
    expect(classifyFailure("Codex stopped responding, so OpenBot ended this turn.")).toBe("timeout");
  });

  it("classifies Portuguese stalled provider error as timeout", () => {
    expect(classifyFailure("Antigravity parou de responder, por isso o OpenBot encerrou a rodada.")).toBe("timeout");
    expect(classifyFailure("OpenCode parou de responder, por isso o OpenBot encerrou a rodada.")).toBe("timeout");
    expect(classifyFailure("Pi parou de responder, por isso o OpenBot encerrou a rodada.")).toBe("timeout");
  });
});

describe("Stall watchdog and recovery logic simulation", () => {
  interface SimulatedRunningTurn {
    lastActivityAt: number;
    lastProgressAt: number;
    openTools: Map<string, { name: string; startedAt: number }>;
    hasExternalAction: boolean;
    inactivityWarningShown: boolean;
  }

  it("scenario: tool open without live child process and silent triggers stall cutoff", () => {
    const WARNING_LIMIT_MS = 3 * 60_000;
    const STALL_LIMIT_MS = 10 * 60_000;
    const t0 = 1000000;

    const turn: SimulatedRunningTurn = {
      lastActivityAt: t0,
      lastProgressAt: t0,
      openTools: new Map([["tool-1", { name: "custom_tool", startedAt: t0 }]]),
      hasExternalAction: false,
      inactivityWarningShown: false,
    };

    const hasLiveChildren = false;
    if (turn.openTools.size > 0 && hasLiveChildren) {
      turn.lastProgressAt = t0 + 200_000;
    }

    const elapsed = 11 * 60_000;
    const now = t0 + elapsed;
    const silentFor = now - turn.lastActivityAt;
    const noProgressFor = now - turn.lastProgressAt;

    expect(silentFor >= WARNING_LIMIT_MS).toBe(true);
    expect(noProgressFor >= STALL_LIMIT_MS).toBe(true);
  });

  it("scenario: long-running build with live child process is NOT cut", () => {
    const STALL_LIMIT_MS = 10 * 60_000;
    const t0 = 1000000;

    const turn: SimulatedRunningTurn = {
      lastActivityAt: t0,
      lastProgressAt: t0,
      openTools: new Map([["tool-1", { name: "run_command", startedAt: t0 }]]),
      hasExternalAction: false,
      inactivityWarningShown: false,
    };

    const hasLiveChildren = true;
    const currentTime = t0 + 9 * 60_000;
    if (turn.openTools.size > 0 && hasLiveChildren) {
      turn.lastProgressAt = currentTime;
    }

    const noProgressFor = currentTime - turn.lastProgressAt;
    expect(noProgressFor < STALL_LIMIT_MS).toBe(true);
  });

  it("scenario: question waiting on user prevents stall", () => {
    const STALL_LIMIT_MS = 10 * 60_000;
    const t0 = 1000000;

    const turn: SimulatedRunningTurn = {
      lastActivityAt: t0,
      lastProgressAt: t0,
      openTools: new Map(),
      hasExternalAction: false,
      inactivityWarningShown: false,
    };

    const isWaitingOnUser = true;
    const currentTime = t0 + 15 * 60_000;

    if (isWaitingOnUser) {
      turn.lastActivityAt = currentTime;
      turn.lastProgressAt = currentTime;
    }

    const noProgressFor = currentTime - turn.lastProgressAt;
    expect(noProgressFor).toBe(0);
    expect(noProgressFor < STALL_LIMIT_MS).toBe(true);
  });

  it("scenario: external action prevents automatic retry and triggers user safety prompt", () => {
    const stallRetries = new Map<string, number>();
    const deliveryId = "del-123";
    const turn: SimulatedRunningTurn = {
      lastActivityAt: 1000,
      lastProgressAt: 1000,
      openTools: new Map(),
      hasExternalAction: true,
      inactivityWarningShown: true,
    };

    let safetyNoticeEmitted = false;
    let requeued = false;

    if (turn.hasExternalAction) {
      safetyNoticeEmitted = true;
      requeued = false;
    } else {
      requeued = true;
    }

    expect(safetyNoticeEmitted).toBe(true);
    expect(requeued).toBe(false);
    expect(stallRetries.get(deliveryId)).toBeUndefined();
  });

  it("scenario: automatic recovery tries same session first, then backup model", () => {
    const stallRetries = new Map<string, number>();
    const deliveryId = "del-456";

    let retryCount = stallRetries.get(deliveryId) ?? 0;
    let actionTaken = "";
    if (retryCount === 0) {
      stallRetries.set(deliveryId, 1);
      actionTaken = "requeue_same_session_continue";
    }

    expect(actionTaken).toBe("requeue_same_session_continue");
    expect(stallRetries.get(deliveryId)).toBe(1);

    retryCount = stallRetries.get(deliveryId) ?? 0;
    if (retryCount >= 1) {
      stallRetries.delete(deliveryId);
      actionTaken = "failover_backup_model";
    }

    expect(actionTaken).toBe("failover_backup_model");
    expect(stallRetries.get(deliveryId)).toBeUndefined();
  });
});
