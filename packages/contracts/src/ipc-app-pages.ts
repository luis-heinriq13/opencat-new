/**
 * The pages of two installed apps, Meta Ads and Microsoft Teams. Main reads the Meta Graph API and
 * the Microsoft Graph API with the token that the app keeps; no token, refresh token or secret crosses
 * to the renderer. Names, titles and message text come from other people: the renderer shows them as
 * plain text only.
 */

/** The periods of the Meta Ads page. Each one is a Graph `date_preset` of the Meta Ads server. */
export const META_ADS_RANGES = [
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_30d",
  "this_month",
  "last_month",
] as const;
export type MetaAdsRange = (typeof META_ADS_RANGES)[number];

/** What the page says about an item: it spends, it is paused, it has a problem, or it is over. */
export const META_ADS_STATUSES = ["active", "paused", "issue", "ended"] as const;
export type MetaAdsStatus = (typeof META_ADS_STATUSES)[number];

export interface MetaAdsAccount {
  id: string;
  name: string;
  /** ISO 4217. Amounts of different currencies are never added. */
  currency: string;
  active: boolean;
}

/** A campaign, an ad set or an ad with its results for the period. Rates are computed from these sums. */
export interface MetaAdsRow {
  id: string;
  name: string;
  accountId: string;
  status: MetaAdsStatus;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  /** Purchase value, or null when the account reports none. */
  revenue: number | null;
}

export interface MetaAdsDay {
  /** YYYY-MM-DD in the time zone of the account. */
  date: string;
  accountId: string;
  spend: number;
  revenue: number | null;
}

/** Whether the page may pause and resume, by the same rule as the server: a daily cap must be set. */
export interface MetaAdsChangePolicy {
  enabled: boolean;
  dailyCap: number | null;
}

export type MetaAdsFailure =
  | { state: "not-connected" }
  | { state: "token-expired" }
  | { state: "error"; reason: "permission" | "rate" | "network" | "unknown" };

export interface MetaAdsReady {
  state: "ready";
  /** Epoch ms of the reading. A cached answer keeps its first time. */
  fetchedAt: number;
  range: MetaAdsRange;
  accounts: MetaAdsAccount[];
  campaigns: MetaAdsRow[];
  daily: MetaAdsDay[];
  changes: MetaAdsChangePolicy;
  /** The page shows a part: more accounts or campaigns exist than the page reads. */
  truncated: boolean;
}
export type MetaAdsOverview = MetaAdsFailure | MetaAdsReady;

export interface MetaAdsQuery {
  range: MetaAdsRange;
  /** Skip the short cache. Main still keeps a minimum time between two readings. */
  refresh?: boolean | undefined;
}

export interface MetaAdsChildrenQuery {
  level: "adset" | "ad";
  /** The campaign (for ad sets) or the ad set (for ads). */
  parentId: string;
  /** The account of the parent, so each row names it. */
  accountId: string;
  range: MetaAdsRange;
  refresh?: boolean | undefined;
}
export type MetaAdsChildren = MetaAdsFailure | { state: "ready"; rows: MetaAdsRow[] };

export interface MetaAdsChange {
  id: string;
  action: "pause" | "resume";
}
export type MetaAdsChangeResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "refused" | "limit" | "failed"; detail: string };

// ---- Microsoft Teams ----

export const TEAMS_CHAT_KINDS = ["oneOnOne", "group", "meeting", "other"] as const;
export type TeamsChatKind = (typeof TEAMS_CHAT_KINDS)[number];

export interface TeamsChat {
  id: string;
  kind: TeamsChatKind;
  /** The topic, else the other members. Written by other people. */
  title: string;
  /** Plain text of the last message. */
  preview: string;
  lastActivity: string | null;
}

export interface TeamsMessage {
  id: string;
  from: string;
  at: string | null;
  /** Plain text. The page never renders it as markup. */
  text: string;
  /** A message of the system, such as a member who joined. */
  system: boolean;
}

export interface TeamsSignInCode {
  uri: string;
  code: string;
  expiresAt: number;
}

export const TEAMS_FAILURES = ["permission", "rate", "network", "unknown"] as const;
export type TeamsFailure = (typeof TEAMS_FAILURES)[number];

export interface TeamsOverview {
  /** TEAMS_PERMITIR_ENVIO is `sim` in the settings of the Teams server. */
  sendEnabled: boolean;
  sendLimitPerHour: number;
  /** `not-connected`: no session. `session-expired`: the saved session no longer works. */
  connection: "ready" | "not-connected" | "session-expired" | "error";
  signIn: TeamsSignInCode | null;
  signInFailed: boolean;
  /** The signed-in account as the Microsoft Graph names it, or null. */
  account: string | null;
  chats: TeamsChat[];
  failure: TeamsFailure | null;
}

export type TeamsMessages =
  | { state: "ready"; messages: TeamsMessage[] }
  | { state: "error"; reason: TeamsFailure | "not-connected" };

export interface TeamsSendInput {
  chatId: string;
  text: string;
}
export type TeamsSendResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "limit" | "not-connected" | "failed"; detail: string };

/** The answer to a change of the send setting. The new permissions need a new sign-in. */
export interface TeamsSendSetting {
  sendEnabled: boolean;
  /** The saved session predates the change: the owner signs in again to accept the new permissions. */
  signInAgain: boolean;
}
