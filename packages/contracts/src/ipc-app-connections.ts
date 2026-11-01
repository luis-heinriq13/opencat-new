/** The apps whose connection to an agent the desktop app can read and change. */
export const APP_CONNECTION_APPS = ["whatsapp"] as const;
export type AppConnectionApp = (typeof APP_CONNECTION_APPS)[number];

/** `auto`: the agent answers the allowed contacts. `pause`: it answers no one until the user resumes. */
export const APP_CONNECTION_REPLY_MODES = ["auto", "pause"] as const;
export type AppConnectionReplyMode = (typeof APP_CONNECTION_REPLY_MODES)[number];

/** `selected`: only the listed contacts. `all`: every contact, also a new one, except the excluded. */
export const APP_CONNECTION_SCOPES = ["selected", "all"] as const;
export type AppConnectionScope = (typeof APP_CONNECTION_SCOPES)[number];

/**
 * Which agent answers for an app on this computer. It carries counts of the allowed chats and never
 * a phone number, a chat id or a name.
 */
export interface AppConnectionStatus {
  app: AppConnectionApp;
  /** The app keeps a connection file. False until the user picks an agent for the first time. */
  configured: boolean;
  /** The agent that answers, or null when no agent is connected. */
  agentId: string | null;
  /** The user turned the connection on. */
  enabled: boolean;
  reply: AppConnectionReplyMode;
  scope: AppConnectionScope;
  chatCount: number;
  groupCount: number;
  excludedCount: number;
}

export const NO_APP_CONNECTION: AppConnectionStatus = {
  app: "whatsapp",
  configured: false,
  agentId: null,
  enabled: false,
  reply: "auto",
  scope: "selected",
  chatCount: 0,
  groupCount: 0,
  excludedCount: 0,
};

/**
 * One change to a connection. `set-agent` connects the agent, turns the connection on and sets the
 * reply to `auto`. `turn-on` does the same for the agent that is already there. `pause` keeps the
 * agent and stops the replies. `disconnect` removes the agent and turns the connection off.
 */
export type AppConnectionChange =
  | { app: AppConnectionApp; action: "set-agent"; agentId: string }
  | { app: AppConnectionApp; action: "turn-on" | "pause" | "disconnect" };

/** What the user sees: no agent, answering, or not answering. */
export type AppConnectionState = "none" | "on" | "paused";

export function appConnectionState(status: AppConnectionStatus): AppConnectionState {
  if (status.agentId === null) return "none";
  return status.enabled && status.reply === "auto" ? "on" : "paused";
}
