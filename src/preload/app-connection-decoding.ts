// What main answers for the agent that an app is connected to. The answer holds counts only.

import {
  APP_CONNECTION_APPS,
  APP_CONNECTION_REPLY_MODES,
  APP_CONNECTION_SCOPES,
  type AppConnectionStatus,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";

export function decodeAppConnectionStatus(value: unknown): AppConnectionStatus {
  if (
    !isDynamicRecord(value) ||
    !isOneOf(APP_CONNECTION_APPS, value.app) ||
    !isBoolean(value.configured) ||
    !(value.agentId === null || isString(value.agentId)) ||
    !isBoolean(value.enabled) ||
    !isOneOf(APP_CONNECTION_REPLY_MODES, value.reply) ||
    !isOneOf(APP_CONNECTION_SCOPES, value.scope) ||
    !isNumber(value.chatCount) ||
    !isNumber(value.groupCount) ||
    !isNumber(value.excludedCount)
  ) {
    throw new Error("Invalid app connection status.");
  }
  return {
    app: value.app,
    configured: value.configured,
    agentId: value.agentId,
    enabled: value.enabled,
    reply: value.reply,
    scope: value.scope,
    chatCount: value.chatCount,
    groupCount: value.groupCount,
    excludedCount: value.excludedCount,
  };
}
