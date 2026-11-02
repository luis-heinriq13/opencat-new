import type {
  TeamsChat,
  TeamsFailure,
  TeamsMessages,
  TeamsOverview,
  TeamsSendInput,
  TeamsSendResult,
  TeamsSendSetting,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  ArrowLeft,
  Button,
  Copy,
  ExternalLink,
  IconButton,
  Label,
  LogIn,
  RefreshCw,
  Send,
  SwitchField,
  Textarea,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createMemo, createStore, createUniqueId, For, Show } from "solid-js";
import { AppAgentsSection, type AppPageAgent } from "./AppAgentsSection";

export interface TeamsViewProps {
  /** The reading, or null before the first answer. */
  overview: TeamsOverview | null;
  refreshing: boolean;
  onRefresh: () => void;
  onBack: () => void;
  /** Starts the device-code sign-in. The page then shows the link and the code. */
  onSignIn: () => Promise<void>;
  loadMessages: (chatId: string) => Promise<TeamsMessages>;
  onSend: (input: TeamsSendInput) => Promise<TeamsSendResult>;
  /** Saves the send choice. Null when it could not be saved. */
  onSetSend: (enabled: boolean) => Promise<TeamsSendSetting | null>;
  onCopy: (text: string) => void;
  onOpenLink: (url: string) => void;
  agents: readonly AppPageAgent[];
  onAsk: (agentId: string, text: string) => Promise<boolean>;
  onOpenTasks: () => void;
}

const ERROR_LABELS = {
  permission: "appPages.teams.error.permission",
  rate: "appPages.teams.error.rate",
  network: "appPages.teams.error.network",
  unknown: "appPages.teams.error.unknown",
} as const satisfies Record<TeamsFailure, AppTextKey>;

const KIND_LABELS = {
  oneOnOne: "appPages.teams.kind.oneOnOne",
  group: "appPages.teams.kind.group",
  meeting: "appPages.teams.kind.meeting",
  other: "appPages.teams.kind.other",
} as const satisfies Record<TeamsChat["kind"], AppTextKey>;

const SEND_LABELS = {
  disabled: "appPages.teams.compose.disabled",
  limit: "appPages.teams.compose.limit",
  "not-connected": "appPages.teams.compose.notConnected",
  failed: "appPages.teams.compose.failed",
} as const satisfies Record<Exclude<TeamsSendResult, { ok: true }>["reason"], AppTextKey>;

interface TeamsState {
  chatId: string | null;
  messages: {
    phase: "idle" | "loading" | "ready" | "failed";
    data: Extract<TeamsMessages, { state: "ready" }>["messages"];
  };
  text: string;
  sending: boolean;
  sendNotice: { tone: "ok" | "error"; key: AppTextKey } | null;
  signingIn: boolean;
  copied: boolean;
  settingNotice: { tone: "ok" | "error"; key: AppTextKey } | null;
  settingBusy: boolean;
}

/**
 * The page of the Microsoft Teams app: chats, messages and a box to write as the owner. Names and message
 * text come from other people, so they render as text nodes only, with `white-space: pre-wrap` in the style.
 */
export function TeamsView(props: TeamsViewProps) {
  const { t, format } = useText();
  const headingId = `app-page-teams-${createUniqueId()}`;
  const composeId = `${headingId}-compose`;
  const [state, setState] = createStore<TeamsState>({
    chatId: null,
    messages: { phase: "idle", data: [] },
    text: "",
    sending: false,
    sendNotice: null,
    signingIn: false,
    copied: false,
    settingNotice: null,
    settingBusy: false,
  });
  let generation = 0;

  const overview = () => props.overview;
  const ready = createMemo(() => {
    const current = props.overview;
    return current?.connection === "ready" ? current : null;
  });
  const selected = createMemo(() => ready()?.chats.find((chat) => chat.id === state.chatId) ?? null);

  const when = (iso: string | null): string => {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const sameDay = date.toDateString() === new Date().toDateString();
    return format.date(date, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit" });
  };

  async function open(chatId: string): Promise<void> {
    const request = ++generation;
    setState((draft) => {
      draft.chatId = chatId;
      draft.messages = { phase: "loading", data: [] };
      draft.sendNotice = null;
    });
    let answer: TeamsMessages;
    try {
      answer = await props.loadMessages(chatId);
    } catch {
      answer = { state: "error", reason: "unknown" };
    }
    if (request !== generation) return;
    setState((draft) => {
      draft.messages =
        answer.state === "ready" ? { phase: "ready", data: answer.messages } : { phase: "failed", data: [] };
    });
  }

  async function send(): Promise<void> {
    const chatId = state.chatId;
    const text = state.text.trim();
    if (!chatId || text === "" || state.sending) return;
    setState((draft) => {
      draft.sending = true;
      draft.sendNotice = null;
    });
    let result: TeamsSendResult;
    try {
      result = await props.onSend({ chatId, text });
    } catch {
      result = { ok: false, reason: "failed", detail: "" };
    }
    setState((draft) => {
      draft.sending = false;
      if (result.ok) {
        draft.text = "";
        draft.sendNotice = { tone: "ok", key: "appPages.teams.compose.sent" };
      } else {
        draft.sendNotice = { tone: "error", key: SEND_LABELS[result.reason] };
      }
    });
    if (result.ok) await open(chatId);
  }

  async function signIn(): Promise<void> {
    setState((draft) => {
      draft.signingIn = true;
    });
    try {
      await props.onSignIn();
    } finally {
      setState((draft) => {
        draft.signingIn = false;
      });
    }
  }

  async function setSend(enabled: boolean): Promise<void> {
    setState((draft) => {
      draft.settingBusy = true;
      draft.settingNotice = null;
    });
    let saved: TeamsSendSetting | null = null;
    try {
      saved = await props.onSetSend(enabled);
    } catch {
      saved = null;
    }
    setState((draft) => {
      draft.settingBusy = false;
      draft.settingNotice = saved
        ? {
            tone: "ok",
            key: saved.signInAgain ? "appPages.teams.settings.signInAgain" : "appPages.teams.settings.saved",
          }
        : { tone: "error", key: "appPages.teams.settings.failed" };
    });
  }

  function copyCode(code: string): void {
    props.onCopy(code);
    setState((draft) => {
      draft.copied = true;
    });
  }

  const failureKey = (): AppTextKey | null => {
    const failure = overview()?.failure;
    return failure ? ERROR_LABELS[failure] : null;
  };

  return (
    <section class="agent-usage app-page" aria-labelledby={headingId}>
      <header class="agent-usage-header">
        <div class="agent-usage-identity">
          <IconButton variant="ghost" label={t("common.back")} onClick={props.onBack}>
            <ArrowLeft />
          </IconButton>
          <h2 id={headingId}>
            {t("appPages.teams.title")}
            <Show when={ready()?.account}>
              {(account) => (
                <>
                  {" "}
                  <span aria-hidden="true">/</span> <span>{t("appPages.teams.account", { name: account() })}</span>
                </>
              )}
            </Show>
          </h2>
        </div>
        <div class="agent-usage-controls">
          <IconButton
            variant="outline"
            label={t("appPages.refresh")}
            disabled={props.refreshing}
            onClick={props.onRefresh}
          >
            <RefreshCw />
          </IconButton>
        </div>
      </header>
      <div class="agent-usage-body app-page-body">
        <Show when={props.overview === null}>
          <div class="agent-usage-loading" role="status">
            <span>{t("appPages.loading")}</span>
            <div class="agent-usage-placeholder" />
          </div>
        </Show>

        <Show when={props.overview && props.overview.connection !== "ready" && props.overview.connection !== "error"}>
          <section class="app-page-card" aria-label={t("appPages.teams.signIn.title")}>
            <h3>
              {overview()?.connection === "session-expired"
                ? t("appPages.teams.expired.title")
                : t("appPages.teams.signIn.title")}
            </h3>
            <p class="app-page-muted">
              {overview()?.connection === "session-expired"
                ? t("appPages.teams.expired.body")
                : t("appPages.teams.signIn.body")}
            </p>
            <Show when={overview()?.signInFailed && !overview()?.signIn}>
              <p class="app-page-status" data-tone="error" role="alert">
                {failureKey() ? t(failureKey() ?? "appPages.teams.error.unknown") : t("appPages.teams.signIn.failed")}
              </p>
            </Show>
            <Show
              when={overview()?.signIn}
              fallback={
                <div class="app-page-actions">
                  <Button type="button" disabled={state.signingIn} onClick={() => void signIn()}>
                    <LogIn aria-hidden="true" />
                    {t("appPages.teams.signIn.start")}
                  </Button>
                </div>
              }
            >
              {(code) => (
                <div class="app-page-code-box">
                  <p>{t("appPages.teams.signIn.step")}</p>
                  <p class="app-page-code-line">
                    <span class="app-page-muted">{t("appPages.teams.signIn.code")}</span>
                    <code class="app-page-code">{code().code}</code>
                  </p>
                  <p class="app-page-muted app-page-link-text">{code().uri}</p>
                  <div class="app-page-actions">
                    <Button type="button" variant="outline" onClick={() => copyCode(code().code)}>
                      <Copy aria-hidden="true" />
                      {state.copied ? t("common.copied") : t("appPages.teams.signIn.copyCode")}
                    </Button>
                    <Button type="button" onClick={() => props.onOpenLink(code().uri)}>
                      <ExternalLink aria-hidden="true" />
                      {t("appPages.teams.signIn.open")}
                    </Button>
                  </div>
                  <p class="app-page-status" role="status">
                    {t("appPages.teams.signIn.waiting")}
                  </p>
                </div>
              )}
            </Show>
          </section>
        </Show>

        <Show when={props.overview?.connection === "error"}>
          <div class="app-page-empty">
            <p role="alert">{t(failureKey() ?? "appPages.teams.error.unknown")}</p>
            <Button variant="secondary" onClick={props.onRefresh}>
              {t("common.retry")}
            </Button>
          </div>
        </Show>

        <Show when={ready()}>
          {(data) => (
            <div class="app-page-teams">
              <section class="app-page-card app-page-chats" aria-labelledby={`${headingId}-chats`}>
                <h3 id={`${headingId}-chats`}>{t("appPages.teams.chats.title")}</h3>
                <Show
                  when={data().chats.length > 0}
                  fallback={<p class="app-page-muted">{t("appPages.teams.chats.empty")}</p>}
                >
                  <ul class="app-page-chat-list">
                    <For each={data().chats}>
                      {(chat) => (
                        <li>
                          <Button
                            type="button"
                            variant="ghost"
                            class="app-page-chat"
                            aria-pressed={state.chatId === chat.id ? "true" : "false"}
                            onClick={() => void open(chat.id)}
                          >
                            <span class="app-page-chat-top">
                              <span class="app-page-chat-title">
                                {chat.title === "" ? t("appPages.teams.chats.untitled") : chat.title}
                              </span>
                              <span class="app-page-muted">{when(chat.lastActivity)}</span>
                            </span>
                            <span class="app-page-chat-kind">{t(KIND_LABELS[chat.kind])}</span>
                            <span class="app-page-chat-preview">{chat.preview}</span>
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <p class="app-page-muted">{t("appPages.teams.chats.channelsNote")}</p>
              </section>

              <section class="app-page-card app-page-thread" aria-label={t("appPages.teams.messages.untrusted")}>
                <Show when={selected()} fallback={<p class="app-page-muted">{t("appPages.teams.messages.pick")}</p>}>
                  {(chat) => (
                    <>
                      <h3>{chat().title === "" ? t("appPages.teams.chats.untitled") : chat().title}</h3>
                      <p class="app-page-muted">{t("appPages.teams.messages.untrusted")}</p>
                      <Show when={state.messages.phase === "loading"}>
                        <p class="app-page-muted" role="status">
                          {t("appPages.teams.messages.loading")}
                        </p>
                      </Show>
                      <Show when={state.messages.phase === "failed"}>
                        <p class="app-page-status" data-tone="error" role="alert">
                          {t("appPages.teams.messages.failed")}
                        </p>
                      </Show>
                      <Show when={state.messages.phase === "ready" && state.messages.data.length === 0}>
                        <p class="app-page-muted">{t("appPages.teams.messages.empty")}</p>
                      </Show>
                      <ul class="app-page-messages">
                        <For each={state.messages.data} keyed={(message) => message.id}>
                          {(message) => (
                            <li class="app-page-message" data-system={message().system ? "true" : undefined}>
                              <span class="app-page-message-head">
                                <strong>
                                  {message().system ? t("appPages.teams.messages.system") : message().from}
                                </strong>
                                <span class="app-page-muted">{when(message().at)}</span>
                              </span>
                              <span class="app-page-message-text">{message().text}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                      <div class="app-page-compose">
                        <Label for={composeId}>{t("appPages.teams.compose.label")}</Label>
                        <Textarea
                          id={composeId}
                          rows={3}
                          maxlength={4000}
                          disabled={!data().sendEnabled || state.sending}
                          placeholder={t("appPages.teams.compose.placeholder")}
                          value={state.text}
                          onValueChange={(value) =>
                            setState((draft) => {
                              draft.text = value;
                            })
                          }
                        />
                        <Show
                          when={data().sendEnabled}
                          fallback={<p class="app-page-muted">{t("appPages.teams.compose.disabled")}</p>}
                        >
                          <p class="app-page-risk" role="note">
                            <TriangleAlert aria-hidden="true" />
                            <span>{t("appPages.teams.compose.risk", { count: data().sendLimitPerHour })}</span>
                          </p>
                        </Show>
                        <div class="app-page-actions">
                          <Button
                            type="button"
                            disabled={!data().sendEnabled || state.sending || state.text.trim() === ""}
                            onClick={() => void send()}
                          >
                            <Send aria-hidden="true" />
                            {state.sending ? t("common.sending") : t("appPages.teams.compose.send")}
                          </Button>
                          <Show when={state.sendNotice}>
                            {(notice) => (
                              <span
                                class="app-page-status"
                                data-tone={notice().tone}
                                role={notice().tone === "ok" ? "status" : "alert"}
                              >
                                {t(notice().key)}
                              </span>
                            )}
                          </Show>
                        </div>
                      </div>
                    </>
                  )}
                </Show>
              </section>
            </div>
          )}
        </Show>

        <Show when={props.overview}>
          {(data) => (
            <section class="app-page-card" aria-labelledby={`${headingId}-settings`}>
              <h3 id={`${headingId}-settings`}>{t("appPages.teams.settings.title")}</h3>
              <SwitchField
                checked={data().sendEnabled}
                disabled={state.settingBusy}
                onChange={(checked) => void setSend(checked)}
                label={t("appPages.teams.settings.send")}
                description={t("appPages.teams.settings.sendHelp")}
              />
              <Show when={state.settingNotice}>
                {(notice) => (
                  <p
                    class="app-page-status"
                    data-tone={notice().tone}
                    role={notice().tone === "ok" ? "status" : "alert"}
                  >
                    {t(notice().key)}
                  </p>
                )}
              </Show>
            </section>
          )}
        </Show>

        <AppAgentsSection
          title={t("appPages.teams.agents.title")}
          guideTitle={t("appPages.teams.guide.title")}
          guideBody={t("appPages.teams.guide.body")}
          draft={t("appPages.teams.guide.draft")}
          agents={props.agents}
          onAsk={props.onAsk}
          onOpenTasks={props.onOpenTasks}
        />
      </div>
    </section>
  );
}
