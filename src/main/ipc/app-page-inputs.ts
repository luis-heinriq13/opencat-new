// The shape and the bounds of the payloads that the Meta Ads and Teams pages send. A message names
// the field only, never a value.

import {
  META_ADS_RANGES,
  type MetaAdsChange,
  type MetaAdsChildrenQuery,
  type MetaAdsQuery,
  TEAMS_AGENT_LEVELS,
  type TeamsAgentPolicy,
  type TeamsAutomationInput,
  type TeamsSendInput,
  type TeamsTarget,
} from "@openbot/contracts/ipc";
import { isBoolean, isOneOf } from "@openbot/contracts/runtime-values";
import { isObject } from "./validation";

const OBJECT_ID = /^\d{3,30}$/;
const ACCOUNT_ID = /^act_\d{3,30}$/;
const CHAT_ID = /^[\w:.@=-]{3,200}$/;
export const TEAMS_MAX_TEXT = 4000;

function range(value: unknown): MetaAdsQuery["range"] {
  if (!isOneOf(META_ADS_RANGES, value)) throw new Error("range is not a known period.");
  return value;
}

function objectId(value: unknown, field: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw new Error(`${field} is not an id.`);
  return value;
}

export function parseMetaAdsQuery(value: unknown): MetaAdsQuery {
  if (!isObject(value)) throw new Error("A query is required.");
  return { range: range(value.range), refresh: value.refresh === true };
}

export function parseMetaAdsChildrenQuery(value: unknown): MetaAdsChildrenQuery {
  if (!isObject(value)) throw new Error("A query is required.");
  if (value.level !== "adset" && value.level !== "ad") throw new Error("level is not known.");
  if (typeof value.accountId !== "string" || !ACCOUNT_ID.test(value.accountId))
    throw new Error("accountId is not an account.");
  return {
    level: value.level,
    parentId: objectId(value.parentId, "parentId"),
    accountId: value.accountId,
    range: range(value.range),
    refresh: value.refresh === true,
  };
}

export function parseMetaAdsChange(value: unknown): MetaAdsChange {
  if (!isObject(value)) throw new Error("A change is required.");
  if (value.action !== "pause" && value.action !== "resume") throw new Error("action is not known.");
  return { id: objectId(value.id, "id"), action: value.action };
}

export function parseTeamsChatId(value: unknown): string {
  if (typeof value !== "string" || !CHAT_ID.test(value)) throw new Error("chatId is not a chat.");
  return value;
}

const ID_PART = /^[\w:.@=-]{3,200}$/;
const AGENT_ID = /^[\w.:-]{1,128}$/;
export const TEAMS_MAX_INSTRUCTION = 2000;
const MAX_TARGETS = 50;

export function parseTeamsTarget(value: unknown): TeamsTarget {
  if (!isObject(value)) throw new Error("A target is required.");
  if (value.type === "chat") return { type: "chat", chatId: parseTeamsChatId(value.chatId) };
  if (
    value.type === "channel" &&
    typeof value.teamId === "string" &&
    ID_PART.test(value.teamId) &&
    typeof value.channelId === "string" &&
    ID_PART.test(value.channelId)
  ) {
    return { type: "channel", teamId: value.teamId, channelId: value.channelId };
  }
  throw new Error("The target is not a chat or a channel.");
}

export function parseTeamsSend(value: unknown): TeamsSendInput {
  if (!isObject(value)) throw new Error("A message is required.");
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (text === "" || text.length > TEAMS_MAX_TEXT) throw new Error("text is empty or too long.");
  return { target: parseTeamsTarget(value.target), text };
}

function agentId(value: unknown): string {
  if (typeof value !== "string" || !AGENT_ID.test(value)) throw new Error("agentId is not an agent.");
  return value;
}

function instruction(value: unknown): string {
  if (typeof value !== "string" || value.length > TEAMS_MAX_INSTRUCTION) throw new Error("instruction is too long.");
  return value.trim();
}

export function parseTeamsAgentPolicy(value: unknown): TeamsAgentPolicy {
  if (!isObject(value)) throw new Error("A policy is required.");
  if (!isOneOf(TEAMS_AGENT_LEVELS, value.level)) throw new Error("level is not known.");
  if (!Array.isArray(value.targets) || value.targets.length > MAX_TARGETS) throw new Error("targets is not a list.");
  return {
    agentId: agentId(value.agentId),
    level: value.level,
    targets: value.targets.map(parseTeamsTarget),
    instruction: instruction(value.instruction),
  };
}

export function parseTeamsAutomation(value: unknown): TeamsAutomationInput {
  if (!isObject(value)) throw new Error("An automation is required.");
  const minutes = value.frequencyMinutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 3 || minutes > 10_080) {
    throw new Error("frequencyMinutes is out of range.");
  }
  const label = typeof value.label === "string" ? value.label.trim().slice(0, 200) : "";
  const text = instruction(value.instruction);
  if (label === "" || text === "") throw new Error("label and instruction are required.");
  return {
    agentId: agentId(value.agentId),
    target: parseTeamsTarget(value.target),
    label,
    frequencyMinutes: minutes,
    instruction: text,
  };
}

export function parseTeamsAutomationId(value: unknown): string {
  return agentId(value);
}

export function parseSendEnabled(value: unknown): boolean {
  if (!isBoolean(value)) throw new Error("A choice is required.");
  return value;
}
