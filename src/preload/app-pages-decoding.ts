// What main answers for the Meta Ads and Teams pages. Each answer is rebuilt field by field, so a
// field that main does not declare never reaches the page. Text from other people stays a string.

import {
  META_ADS_RANGES,
  META_ADS_STATUSES,
  type MetaAdsChangeResult,
  type MetaAdsChildren,
  type MetaAdsDay,
  type MetaAdsFailure,
  type MetaAdsOverview,
  type MetaAdsRow,
  TEAMS_AGENT_LEVELS,
  TEAMS_CHAT_KINDS,
  TEAMS_FAILURES,
  type TeamsChannelsInfo,
  type TeamsChat,
  type TeamsMessage,
  type TeamsMessages,
  type TeamsOverview,
  type TeamsPolicy,
  type TeamsSendResult,
  type TeamsSendSetting,
  type TeamsTarget,
} from "@openbot/contracts/ipc";
import {
  type DynamicRecord,
  isBoolean,
  isDynamicRecord,
  isNumber,
  isOneOf,
  isString,
} from "@openbot/contracts/runtime-values";

/** The link of a device-code sign-in is a Microsoft address. Any other one is refused, so the page never offers to open it. */
function isMicrosoftLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)(microsoft\.com|microsoftonline\.com|live\.com)$/.test(url.hostname);
  } catch {
    return false;
  }
}

const REASONS = ["permission", "rate", "network", "unknown"] as const;
const nullableNumber = (value: unknown): value is number | null => value === null || isNumber(value);

function records(value: unknown, label: string): DynamicRecord[] {
  if (!Array.isArray(value) || !value.every(isDynamicRecord)) throw new Error(`Invalid ${label}.`);
  return value;
}

function failure(value: DynamicRecord): MetaAdsFailure | null {
  if (value.state === "not-connected" || value.state === "token-expired") return { state: value.state };
  if (value.state === "error" && isOneOf(REASONS, value.reason)) return { state: "error", reason: value.reason };
  return null;
}

function row(value: DynamicRecord): MetaAdsRow {
  if (
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.accountId) ||
    !isOneOf(META_ADS_STATUSES, value.status) ||
    !isNumber(value.spend) ||
    !isNumber(value.impressions) ||
    !isNumber(value.clicks) ||
    !isNumber(value.purchases) ||
    !nullableNumber(value.revenue)
  ) {
    throw new Error("Invalid Meta Ads row.");
  }
  return {
    id: value.id,
    name: value.name,
    accountId: value.accountId,
    status: value.status,
    spend: value.spend,
    impressions: value.impressions,
    clicks: value.clicks,
    purchases: value.purchases,
    revenue: value.revenue,
  };
}

function day(value: DynamicRecord): MetaAdsDay {
  if (!isString(value.date) || !isString(value.accountId) || !isNumber(value.spend) || !nullableNumber(value.revenue)) {
    throw new Error("Invalid Meta Ads day.");
  }
  return { date: value.date, accountId: value.accountId, spend: value.spend, revenue: value.revenue };
}

export function decodeMetaAdsOverview(value: unknown): MetaAdsOverview {
  if (!isDynamicRecord(value)) throw new Error("Invalid Meta Ads overview.");
  const failed = failure(value);
  if (failed) return failed;
  const changes = value.changes;
  if (
    value.state !== "ready" ||
    !isNumber(value.fetchedAt) ||
    !isOneOf(META_ADS_RANGES, value.range) ||
    !isDynamicRecord(changes) ||
    !isBoolean(changes.enabled) ||
    !nullableNumber(changes.dailyCap) ||
    !isBoolean(value.truncated)
  ) {
    throw new Error("Invalid Meta Ads overview.");
  }
  return {
    state: "ready",
    fetchedAt: value.fetchedAt,
    range: value.range,
    accounts: records(value.accounts, "Meta Ads accounts").map((account) => {
      if (
        !isString(account.id) ||
        !isString(account.name) ||
        !isString(account.currency) ||
        !isBoolean(account.active)
      ) {
        throw new Error("Invalid Meta Ads account.");
      }
      return { id: account.id, name: account.name, currency: account.currency, active: account.active };
    }),
    campaigns: records(value.campaigns, "Meta Ads campaigns").map(row),
    daily: records(value.daily, "Meta Ads days").map(day),
    changes: { enabled: changes.enabled, dailyCap: changes.dailyCap },
    truncated: value.truncated,
    failedAccounts: records(value.failedAccounts, "Meta Ads failed accounts").map((account) => {
      if (!isString(account.id) || !isString(account.name)) throw new Error("Invalid Meta Ads failed account.");
      return { id: account.id, name: account.name };
    }),
  };
}

export function decodeMetaAdsChildren(value: unknown): MetaAdsChildren {
  if (!isDynamicRecord(value)) throw new Error("Invalid Meta Ads items.");
  const failed = failure(value);
  if (failed) return failed;
  if (value.state !== "ready") throw new Error("Invalid Meta Ads items.");
  return { state: "ready", rows: records(value.rows, "Meta Ads items").map(row) };
}

export function decodeMetaAdsChangeResult(value: unknown): MetaAdsChangeResult {
  if (!isDynamicRecord(value)) throw new Error("Invalid Meta Ads change.");
  if (value.ok === true) return { ok: true };
  if (
    value.ok === false &&
    isOneOf(["disabled", "refused", "limit", "failed"], value.reason) &&
    isString(value.detail)
  ) {
    return { ok: false, reason: value.reason, detail: value.detail };
  }
  throw new Error("Invalid Meta Ads change.");
}

function chat(value: DynamicRecord): TeamsChat {
  if (
    !isString(value.id) ||
    !isOneOf(TEAMS_CHAT_KINDS, value.kind) ||
    !isString(value.title) ||
    !isString(value.preview) ||
    !(value.lastActivity === null || isString(value.lastActivity))
  ) {
    throw new Error("Invalid Teams chat.");
  }
  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    preview: value.preview,
    lastActivity: value.lastActivity,
  };
}

function target(value: unknown): TeamsTarget {
  if (isDynamicRecord(value) && value.type === "chat" && isString(value.chatId))
    return { type: "chat", chatId: value.chatId };
  if (isDynamicRecord(value) && value.type === "channel" && isString(value.teamId) && isString(value.channelId)) {
    return { type: "channel", teamId: value.teamId, channelId: value.channelId };
  }
  throw new Error("Invalid Teams target.");
}

function decodeChannels(value: unknown): TeamsChannelsInfo {
  if (
    !isDynamicRecord(value) ||
    !isOneOf(["ready", "blocked", "off"], value.state) ||
    !isString(value.adminConsentUrl)
  ) {
    throw new Error("Invalid Teams channels.");
  }
  return {
    state: value.state,
    adminConsentUrl: value.adminConsentUrl,
    teams: records(value.teams, "Teams teams").map((team) => {
      if (!isString(team.id) || !isString(team.name)) throw new Error("Invalid Teams team.");
      return {
        id: team.id,
        name: team.name,
        channels: records(team.channels, "Teams channels").map((channel) => {
          if (!isString(channel.id) || !isString(channel.name)) throw new Error("Invalid Teams channel.");
          return { id: channel.id, name: channel.name };
        }),
      };
    }),
  };
}

export function decodeTeamsPolicy(value: unknown): TeamsPolicy {
  if (!isDynamicRecord(value)) throw new Error("Invalid Teams policy.");
  return {
    agents: records(value.agents, "Teams agents").map((agent) => {
      if (
        !isString(agent.agentId) ||
        !isOneOf(TEAMS_AGENT_LEVELS, agent.level) ||
        !isString(agent.instruction) ||
        !Array.isArray(agent.targets)
      ) {
        throw new Error("Invalid Teams agent policy.");
      }
      return {
        agentId: agent.agentId,
        level: agent.level,
        targets: agent.targets.map(target),
        instruction: agent.instruction,
      };
    }),
    automations: records(value.automations, "Teams automations").map((entry) => {
      if (
        !isString(entry.id) ||
        !isString(entry.agentId) ||
        !isString(entry.label) ||
        !isString(entry.instruction) ||
        !isString(entry.routineId) ||
        !isNumber(entry.frequencyMinutes) ||
        !isString(entry.createdAt)
      ) {
        throw new Error("Invalid Teams automation.");
      }
      return {
        id: entry.id,
        agentId: entry.agentId,
        target: target(entry.target),
        label: entry.label,
        instruction: entry.instruction,
        routineId: entry.routineId,
        frequencyMinutes: entry.frequencyMinutes,
        createdAt: entry.createdAt,
      };
    }),
  };
}

export function decodeTeamsOverview(value: unknown): TeamsOverview {
  if (
    !isDynamicRecord(value) ||
    !isBoolean(value.sendEnabled) ||
    !isNumber(value.sendLimitPerHour) ||
    !isOneOf(["ready", "not-connected", "session-expired", "error"], value.connection) ||
    !isBoolean(value.signInFailed) ||
    !(value.account === null || isString(value.account)) ||
    !(value.failure === null || isOneOf(TEAMS_FAILURES, value.failure))
  ) {
    throw new Error("Invalid Teams overview.");
  }
  const signIn = value.signIn;
  if (
    signIn !== null &&
    (!isDynamicRecord(signIn) ||
      !isString(signIn.uri) ||
      !isMicrosoftLink(signIn.uri) ||
      !isString(signIn.code) ||
      !isNumber(signIn.expiresAt))
  ) {
    throw new Error("Invalid Teams sign-in.");
  }
  return {
    sendEnabled: value.sendEnabled,
    sendLimitPerHour: value.sendLimitPerHour,
    connection: value.connection,
    signIn:
      signIn === null
        ? null
        : { uri: String(signIn.uri), code: String(signIn.code), expiresAt: Number(signIn.expiresAt) },
    signInFailed: value.signInFailed,
    account: value.account,
    chats: records(value.chats, "Teams chats").map(chat),
    failure: value.failure,
    channels: decodeChannels(value.channels),
  };
}

function message(value: DynamicRecord): TeamsMessage {
  if (
    !isString(value.id) ||
    !isString(value.from) ||
    !(value.at === null || isString(value.at)) ||
    !isString(value.text) ||
    !isBoolean(value.system)
  ) {
    throw new Error("Invalid Teams message.");
  }
  return { id: value.id, from: value.from, at: value.at, text: value.text, system: value.system };
}

export function decodeTeamsMessages(value: unknown): TeamsMessages {
  if (!isDynamicRecord(value)) throw new Error("Invalid Teams messages.");
  if (value.state === "error" && isOneOf([...TEAMS_FAILURES, "not-connected"], value.reason)) {
    return { state: "error", reason: value.reason };
  }
  if (value.state !== "ready") throw new Error("Invalid Teams messages.");
  return { state: "ready", messages: records(value.messages, "Teams messages").map(message) };
}

export function decodeTeamsSendResult(value: unknown): TeamsSendResult {
  if (!isDynamicRecord(value)) throw new Error("Invalid Teams send result.");
  if (value.ok === true) return { ok: true };
  if (
    value.ok === false &&
    isOneOf(["disabled", "limit", "not-connected", "failed"], value.reason) &&
    isString(value.detail)
  ) {
    return { ok: false, reason: value.reason, detail: value.detail };
  }
  throw new Error("Invalid Teams send result.");
}

export function decodeTeamsSendSetting(value: unknown): TeamsSendSetting {
  if (!isDynamicRecord(value) || !isBoolean(value.sendEnabled) || !isBoolean(value.signInAgain)) {
    throw new Error("Invalid Teams send setting.");
  }
  return { sendEnabled: value.sendEnabled, signInAgain: value.signInAgain };
}
