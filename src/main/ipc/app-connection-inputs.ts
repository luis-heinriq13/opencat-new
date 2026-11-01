import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { APP_CONNECTION_APPS, type AppConnectionApp, type AppConnectionChange } from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import { isObject, requireString } from "./validation";

export function parseAppConnectionApp(value: unknown): AppConnectionApp {
  if (!isOneOf(APP_CONNECTION_APPS, value)) throw new Error("Unknown app.");
  return value;
}

export function parseAppConnectionChange(value: unknown): AppConnectionChange {
  if (!isObject(value)) throw new Error("A connection change is required.");
  const app = parseAppConnectionApp(value.app);
  switch (value.action) {
    case "set-agent":
      return { app, action: "set-agent", agentId: requireString(value.agentId, "agentId", INPUT_LIMITS.identifier) };
    case "turn-on":
    case "pause":
    case "disconnect":
      return { app, action: value.action };
    default:
      throw new Error("Unknown connection action.");
  }
}
