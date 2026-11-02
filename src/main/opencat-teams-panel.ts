// OpenCat: the data behind the Teams page. Main reads the Microsoft Graph with the session of the
// "teams" app, through the same module that the app's MCP server runs (`~/.opencat/teams`): its
// device-code sign-in, Keychain session, request limits, error mapping and hourly send limit stay in
// one place. The session never leaves main. Sending needs TEAMS_PERMITIR_ENVIO=sim in the saved server
// settings and goes through the module's own send tool, so its rules and limit apply.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TEAMS_CHAT_KINDS,
  type TeamsChat,
  type TeamsFailure,
  type TeamsMessage,
  type TeamsMessages,
  type TeamsOverview,
  type TeamsSendInput,
  type TeamsSendResult,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";

export const TEAMS_SERVER_NAME = "teams";
export const TEAMS_SEND_VARIABLE = "TEAMS_PERMITIR_ENVIO";
export const TEAMS_MODULE = join(homedir(), ".opencat", TEAMS_SERVER_NAME, "teams-mcp.mjs");
const TEAMS_LIMIT_FILE = join(homedir(), ".opencat", TEAMS_SERVER_NAME, "envios.json");
export const TEAMS_SEND_LIMIT_PER_HOUR = 20;
const TEAMS_CACHE_MS = 30_000;
const CHAT_PAGE = 30;
const MESSAGE_PAGE = 30;

/** What the installed module exports. */
interface TeamsModuleExports {
  createTeamsTools(options: { env: Record<string, string>; limitFile: string }): unknown;
  htmlToText(html: unknown): string;
}

export interface TeamsModuleTools {
  graph(path: string): Promise<unknown>;
  callTool(name: string, args: DynamicRecord): Promise<unknown>;
  readonly sendEnabled: boolean;
  pendingSignIn(): { userCode: string; uri: string; expiresAt: number } | null;
  lastSignInError(): string | null;
  hasSession(): Promise<boolean>;
}

export interface TeamsModule {
  tools: TeamsModuleTools;
  htmlToText: (html: unknown) => string;
}

export interface TeamsPanelDependencies {
  /** The environment of the saved "teams" server, or null when that server is not installed and on. */
  environment: () => Readonly<Record<string, string>> | null;
  /** Builds the tools of the module for one environment. Null when the module is not installed. */
  loadModule: (environment: Readonly<Record<string, string>>) => Promise<TeamsModule | null>;
  now?: () => number;
}

function isTeamsTools(value: unknown): value is TeamsModuleTools {
  return (
    isDynamicRecord(value) &&
    typeof value.graph === "function" &&
    typeof value.callTool === "function" &&
    typeof value.pendingSignIn === "function" &&
    typeof value.hasSession === "function" &&
    typeof value.sendEnabled === "boolean"
  );
}

/** Loads the installed module. An older install without the structured members reads as not installed. */
export async function loadInstalledTeamsModule(
  environment: Readonly<Record<string, string>>,
): Promise<TeamsModule | null> {
  try {
    const imported: TeamsModuleExports = await import(pathToFileURL(TEAMS_MODULE).href);
    if (typeof imported.createTeamsTools !== "function" || typeof imported.htmlToText !== "function") return null;
    const created = imported.createTeamsTools({ env: { ...environment }, limitFile: TEAMS_LIMIT_FILE });
    if (!isTeamsTools(created)) return null;
    return { tools: created, htmlToText: (html) => imported.htmlToText(html) };
  } catch {
    return null;
  }
}

function failureOf(error: unknown): TeamsFailure | "signin" {
  const kind = isDynamicRecord(error) ? error.kind : undefined;
  if (kind === "signin") return "signin";
  if (kind === "permission") return "permission";
  if (kind === "rate") return "rate";
  const name = error instanceof Error ? error.name : "";
  return name === "TypeError" || name === "TimeoutError" || name === "AbortError" ? "network" : "unknown";
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function values(data: unknown): DynamicRecord[] {
  return isDynamicRecord(data) && Array.isArray(data.value) ? data.value.filter(isDynamicRecord) : [];
}

function toolText(result: unknown): { text: string; isError: boolean } {
  const content = isDynamicRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = content.find(isDynamicRecord);
  return {
    text: first && typeof first.text === "string" ? first.text : "",
    isError: isDynamicRecord(result) && result.isError === true,
  };
}

export function createTeamsPanel({ environment, loadModule, now = Date.now }: TeamsPanelDependencies) {
  let signature = "";
  let loaded: TeamsModule | null = null;
  let chatsCache: { at: number; chats: TeamsChat[]; account: string | null } | null = null;

  async function current(): Promise<TeamsModule | null> {
    const env = environment();
    if (!env) return null;
    const next = JSON.stringify(env);
    if (next !== signature || !loaded) {
      // A new instance has no sign-in in progress, so one is kept while the settings do not change.
      loaded = await loadModule(env);
      signature = next;
      chatsCache = null;
    }
    return loaded;
  }

  const base = (module: TeamsModule | null): TeamsOverview => ({
    sendEnabled: module?.tools.sendEnabled ?? false,
    sendLimitPerHour: TEAMS_SEND_LIMIT_PER_HOUR,
    connection: "not-connected",
    signIn: null,
    signInFailed: false,
    account: null,
    chats: [],
    failure: null,
  });

  function chatOf(raw: DynamicRecord, module: TeamsModule): TeamsChat | null {
    const id = clip(raw.id, 200);
    if (!id) return null;
    const members = Array.isArray(raw.members)
      ? raw.members
          .filter(isDynamicRecord)
          .map((member) => clip(member.displayName, 80))
          .filter(Boolean)
          .join(", ")
      : "";
    const preview = isDynamicRecord(raw.lastMessagePreview) ? raw.lastMessagePreview : {};
    const body = isDynamicRecord(preview.body) ? preview.body : {};
    const kind = isOneOf(TEAMS_CHAT_KINDS, raw.chatType) ? raw.chatType : "other";
    return {
      id,
      kind,
      title: clip(raw.topic, 200) || members.slice(0, 200),
      preview: module.htmlToText(body.content).slice(0, 200),
      lastActivity: clip(preview.createdDateTime, 40) || clip(raw.lastUpdatedDateTime, 40) || null,
    };
  }

  async function overview(): Promise<TeamsOverview> {
    const module = await current();
    const result = base(module);
    if (!module) return result;
    const { tools } = module;
    const pending = tools.pendingSignIn();
    result.signIn = pending ? { code: pending.userCode, uri: pending.uri, expiresAt: pending.expiresAt } : null;
    result.signInFailed = tools.lastSignInError() !== null;
    if (!(await tools.hasSession())) return result;
    try {
      if (!chatsCache || now() - chatsCache.at > TEAMS_CACHE_MS) {
        const me = await tools.graph("/me?$select=displayName,userPrincipalName");
        const list = await tools.graph(
          `/me/chats?$top=${CHAT_PAGE}&$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime%20desc`,
        );
        chatsCache = {
          at: now(),
          account: isDynamicRecord(me) ? clip(me.displayName, 120) || clip(me.userPrincipalName, 120) || null : null,
          chats: values(list).flatMap((raw) => chatOf(raw, module) ?? []),
        };
      }
      return { ...result, connection: "ready", account: chatsCache.account, chats: chatsCache.chats };
    } catch (error) {
      chatsCache = null;
      const failure = failureOf(error);
      if (failure === "signin") return { ...result, connection: "session-expired" };
      return { ...result, connection: "error", failure };
    }
  }

  return {
    overview,

    async signIn(): Promise<TeamsOverview> {
      const module = await current();
      if (!module) return overview();
      const answer = toolText(await module.tools.callTool("teams_sign_in", {}));
      const state = await overview();
      // The Microsoft refused the sign-in: a work or school account is needed, or the organization blocks the app.
      return answer.isError && !state.signIn ? { ...state, failure: "permission", signInFailed: true } : state;
    },

    async messages(chatId: string): Promise<TeamsMessages> {
      const module = await current();
      if (!module || !(await module.tools.hasSession())) return { state: "error", reason: "not-connected" };
      try {
        const data = await module.tools.graph(`/me/chats/${encodeURIComponent(chatId)}/messages?$top=${MESSAGE_PAGE}`);
        const messages = values(data)
          .flatMap((raw): TeamsMessage[] => {
            const id = clip(raw.id, 200);
            if (!id) return [];
            const from = isDynamicRecord(raw.from) ? raw.from : {};
            const user = isDynamicRecord(from.user) ? from.user : {};
            const application = isDynamicRecord(from.application) ? from.application : {};
            const body = isDynamicRecord(raw.body) ? raw.body : {};
            const text = body.contentType === "html" ? module.htmlToText(body.content) : clip(body.content, 4000);
            return [
              {
                id,
                from: clip(user.displayName, 120) || clip(application.displayName, 120),
                at: clip(raw.createdDateTime, 40) || null,
                text: text.slice(0, 4000),
                system: raw.messageType !== undefined && raw.messageType !== "message",
              },
            ];
          })
          // The Graph answers the newest first; the page reads from the oldest.
          .reverse();
        return { state: "ready", messages };
      } catch (error) {
        const failure = failureOf(error);
        return { state: "error", reason: failure === "signin" ? "not-connected" : failure };
      }
    },

    async send(input: TeamsSendInput): Promise<TeamsSendResult> {
      const module = await current();
      if (!module?.tools.sendEnabled) return { ok: false, reason: "disabled", detail: "" };
      const answer = toolText(
        await module.tools.callTool("teams_enviar_mensagem", { chat_id: input.chatId, texto: input.text }),
      );
      if (!answer.isError) {
        chatsCache = null;
        return { ok: true };
      }
      const detail =
        answer.text
          .split("\n")
          .find((line) => line.trim() !== "" && !line.includes("<<<"))
          ?.slice(0, 300) ?? "";
      if (/^Limite de \d+ mensagens/.test(detail)) return { ok: false, reason: "limit", detail };
      if (/não está conectado|expirou/.test(detail)) return { ok: false, reason: "not-connected", detail };
      return { ok: false, reason: "failed", detail };
    },

    /** The saved settings changed. The next call builds the module again with them. */
    settingsChanged(): void {
      signature = "";
      loaded = null;
      chatsCache = null;
    },

    async hasSession(): Promise<boolean> {
      const module = await current();
      return module ? module.tools.hasSession() : false;
    },
  };
}
