// The shape and the bounds of the payloads that the Meta Ads and Teams pages send. A message names
// the field only, never a value.

import {
  META_ADS_RANGES,
  type MetaAdsChange,
  type MetaAdsChildrenQuery,
  type MetaAdsQuery,
  type TeamsSendInput,
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

export function parseTeamsSend(value: unknown): TeamsSendInput {
  if (!isObject(value)) throw new Error("A message is required.");
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (text === "" || text.length > TEAMS_MAX_TEXT) throw new Error("text is empty or too long.");
  return { chatId: parseTeamsChatId(value.chatId), text };
}

export function parseSendEnabled(value: unknown): boolean {
  if (!isBoolean(value)) throw new Error("A choice is required.");
  return value;
}
