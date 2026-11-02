import {
  TEAMS_AGENT_LEVELS,
  type TeamsAgentLevel,
  type TeamsAgentPolicy,
  type TeamsAutomationInput,
  type TeamsPolicy,
  type TeamsTarget,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Checkbox, Label, NativeSelect, Textarea } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, createUniqueId, For, Show } from "solid-js";
import type { AppPageAgent } from "./AppAgentsSection";

export interface TeamsTargetChoice {
  target: TeamsTarget;
  /** Written by other people: shown as text only. */
  label: string;
}

const LEVEL_LABELS = {
  none: "appPages.teams.perm.level.none",
  read: "appPages.teams.perm.level.read",
  reply: "appPages.teams.perm.level.reply",
} as const satisfies Record<TeamsAgentLevel, AppTextKey>;

const FREQUENCIES = [
  { minutes: 5, label: "appPages.teams.auto.freq5" },
  { minutes: 15, label: "appPages.teams.auto.freq15" },
  { minutes: 60, label: "appPages.teams.auto.freq60" },
  { minutes: 1440, label: "appPages.teams.auto.freq1440" },
] as const satisfies readonly { minutes: number; label: AppTextKey }[];

const keyOf = (target: TeamsTarget): string => JSON.stringify(target);

interface Draft {
  level: TeamsAgentLevel;
  targets: TeamsTarget[];
  instruction: string;
  busy: boolean;
  notice: "saved" | "failed" | null;
}

interface FormState {
  drafts: Record<string, Draft>;
  agentId: string | null;
  targetKey: string | null;
  minutes: number;
  instruction: string;
  busy: boolean;
  outcome: "none" | "created" | "failed";
}

/**
 * "Agents with permission" of the Teams page: for each agent a level, the chats and channels it may use
 * and an instruction; then the automations. The owner changes all of it here and nowhere else.
 */
export function TeamsAgentsPermissions(props: {
  agents: readonly AppPageAgent[];
  policy: TeamsPolicy | null;
  choices: readonly TeamsTargetChoice[];
  onSave: (policy: TeamsAgentPolicy) => Promise<boolean>;
  onCreateAutomation: (input: TeamsAutomationInput) => Promise<boolean>;
  onStopAutomation: (id: string) => Promise<void>;
}) {
  const { t } = useText();
  const id = createUniqueId();
  const [state, setState] = createStore<FormState>({
    drafts: {},
    agentId: null,
    targetKey: null,
    minutes: 15,
    instruction: "",
    busy: false,
    outcome: "none",
  });

  const saved = (agentId: string): TeamsAgentPolicy =>
    props.policy?.agents.find((entry) => entry.agentId === agentId) ?? {
      agentId,
      level: "none",
      targets: [],
      instruction: "",
    };
  const draftOf = (agentId: string): Draft => state.drafts[agentId] ?? { ...saved(agentId), busy: false, notice: null };
  const label = (target: TeamsTarget): string =>
    props.choices.find((choice) => keyOf(choice.target) === keyOf(target))?.label ??
    (target.type === "chat" ? target.chatId : target.channelId);

  function edit(agentId: string, change: (draft: Draft) => void): void {
    setState((draft) => {
      const current = draft.drafts[agentId] ?? {
        ...saved(agentId),
        targets: [...saved(agentId).targets],
        busy: false,
        notice: null,
      };
      change(current);
      current.notice = null;
      draft.drafts[agentId] = current;
    });
  }

  async function save(agentId: string): Promise<void> {
    const draft = draftOf(agentId);
    setState((current) => {
      current.drafts[agentId] = { ...draft, targets: [...draft.targets], busy: true, notice: null };
    });
    let ok = false;
    try {
      ok = await props.onSave({ agentId, level: draft.level, targets: draft.targets, instruction: draft.instruction });
    } catch {
      ok = false;
    }
    setState((current) => {
      if (ok) delete current.drafts[agentId];
      else current.drafts[agentId] = { ...draft, targets: [...draft.targets], busy: false, notice: "failed" };
    });
    if (ok) {
      setState((current) => {
        current.drafts[agentId] = {
          ...saved(agentId),
          targets: [...saved(agentId).targets],
          busy: false,
          notice: "saved",
        };
      });
    }
  }

  /** The agents that can run an automation: at least the read level, and a chat or channel in the list. */
  const eligible = () =>
    props.agents.filter((agent) => {
      const entry = saved(agent.id);
      return entry.level !== "none" && entry.targets.length > 0;
    });
  const formAgent = () => state.agentId ?? eligible()[0]?.id ?? null;
  const formTargets = (): TeamsTarget[] => {
    const agentId = formAgent();
    return agentId ? saved(agentId).targets : [];
  };
  const formTarget = (): TeamsTarget | undefined =>
    formTargets().find((target) => keyOf(target) === state.targetKey) ?? formTargets()[0];

  const formTargetKey = (): string => {
    const target = formTarget();
    return target ? keyOf(target) : "";
  };

  async function create(): Promise<void> {
    const agentId = formAgent();
    const target = formTarget();
    const instruction = state.instruction.trim();
    if (!agentId || !target || instruction === "" || state.busy) return;
    setState((draft) => {
      draft.busy = true;
      draft.outcome = "none";
    });
    let ok = false;
    try {
      ok = await props.onCreateAutomation({
        agentId,
        target,
        label: label(target),
        frequencyMinutes: state.minutes,
        instruction,
      });
    } catch {
      ok = false;
    }
    setState((draft) => {
      draft.busy = false;
      draft.outcome = ok ? "created" : "failed";
      if (ok) draft.instruction = "";
    });
  }

  const agentName = (agentId: string) => props.agents.find((agent) => agent.id === agentId)?.name ?? agentId;

  return (
    <section class="app-page-card" aria-labelledby={`${id}-perm`}>
      <h3 id={`${id}-perm`}>{t("appPages.teams.agents.title")}</h3>
      <p class="app-page-muted">{t("appPages.teams.perm.honest")}</p>
      <Show when={props.agents.length > 0} fallback={<p class="app-page-muted">{t("appPages.agents.empty")}</p>}>
        <For each={props.agents}>
          {(agent) => (
            <fieldset class="app-page-guide app-page-agent-card">
              <legend class="app-page-legend">{agent.name}</legend>
              <Label for={`${id}-${agent.id}-level`}>{t("appPages.teams.perm.level")}</Label>
              <NativeSelect
                id={`${id}-${agent.id}-level`}
                size="sm"
                value={draftOf(agent.id).level}
                onChange={(event) => {
                  const level = TEAMS_AGENT_LEVELS.find((entry) => entry === event.currentTarget.value);
                  if (level) edit(agent.id, (draft) => (draft.level = level));
                }}
              >
                <For each={TEAMS_AGENT_LEVELS}>
                  {(level) => <option value={level}>{t(LEVEL_LABELS[level])}</option>}
                </For>
              </NativeSelect>
              <Show when={draftOf(agent.id).level !== "none"}>
                <span class="app-page-field-label">{t("appPages.teams.perm.targets")}</span>
                <Show when={draftOf(agent.id).targets.length === 0}>
                  <span class="app-page-muted">{t("appPages.teams.perm.noTargets")}</span>
                </Show>
                <div class="app-page-target-list">
                  <For each={props.choices}>
                    {(choice) => (
                      <div class="app-page-target">
                        <Checkbox
                          id={`${id}-${agent.id}-${keyOf(choice.target)}`}
                          checked={draftOf(agent.id).targets.some((target) => keyOf(target) === keyOf(choice.target))}
                          onChange={(event) => {
                            const on = event.currentTarget.checked;
                            edit(agent.id, (draft) => {
                              const rest = draft.targets.filter((target) => keyOf(target) !== keyOf(choice.target));
                              draft.targets = on ? [...rest, choice.target] : rest;
                            });
                          }}
                        />
                        <Label class="app-page-target-name" for={`${id}-${agent.id}-${keyOf(choice.target)}`}>
                          {choice.label}
                        </Label>
                      </div>
                    )}
                  </For>
                </div>
                <Label for={`${id}-${agent.id}-instruction`}>{t("appPages.teams.perm.instruction")}</Label>
                <Textarea
                  id={`${id}-${agent.id}-instruction`}
                  rows={3}
                  maxlength={2000}
                  value={draftOf(agent.id).instruction}
                  onValueChange={(value) => edit(agent.id, (draft) => (draft.instruction = value))}
                />
              </Show>
              <div class="app-page-actions">
                <Button type="button" size="sm" disabled={draftOf(agent.id).busy} onClick={() => void save(agent.id)}>
                  {t("appPages.teams.perm.save")}
                </Button>
                <Show when={draftOf(agent.id).notice}>
                  {(notice) => (
                    <span
                      class="app-page-status"
                      data-tone={notice() === "saved" ? "ok" : "error"}
                      role={notice() === "saved" ? "status" : "alert"}
                    >
                      {notice() === "saved" ? t("appPages.teams.perm.saved") : t("appPages.teams.perm.failed")}
                    </span>
                  )}
                </Show>
              </div>
            </fieldset>
          )}
        </For>

        <h3>{t("appPages.teams.auto.title")}</h3>
        <p class="app-page-muted">{t("appPages.teams.auto.note")}</p>
        <Show when={eligible().length > 0} fallback={<p class="app-page-muted">{t("appPages.teams.auto.needs")}</p>}>
          <div class="app-page-guide">
            <Label for={`${id}-auto-agent`}>{t("appPages.teams.auto.agent")}</Label>
            <NativeSelect
              id={`${id}-auto-agent`}
              size="sm"
              value={formAgent() ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setState((draft) => {
                  draft.agentId = value;
                  draft.targetKey = null;
                });
              }}
            >
              <For each={eligible()}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
            </NativeSelect>
            <Label for={`${id}-auto-target`}>{t("appPages.teams.auto.target")}</Label>
            <NativeSelect
              id={`${id}-auto-target`}
              size="sm"
              value={formTargetKey()}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setState((draft) => {
                  draft.targetKey = value;
                });
              }}
            >
              <For each={formTargets()}>{(target) => <option value={keyOf(target)}>{label(target)}</option>}</For>
            </NativeSelect>
            <Label for={`${id}-auto-frequency`}>{t("appPages.teams.auto.frequency")}</Label>
            <NativeSelect
              id={`${id}-auto-frequency`}
              size="sm"
              value={String(state.minutes)}
              onChange={(event) => {
                const minutes = Number(event.currentTarget.value);
                setState((draft) => {
                  draft.minutes = minutes;
                });
              }}
            >
              <For each={FREQUENCIES}>
                {(option) => <option value={String(option.minutes)}>{t(option.label)}</option>}
              </For>
            </NativeSelect>
            <Label for={`${id}-auto-instruction`}>{t("appPages.teams.auto.instruction")}</Label>
            <Textarea
              id={`${id}-auto-instruction`}
              rows={3}
              maxlength={2000}
              placeholder={t("appPages.teams.auto.placeholder")}
              value={state.instruction}
              onValueChange={(value) =>
                setState((draft) => {
                  draft.instruction = value;
                })
              }
            />
            <div class="app-page-actions">
              <Button
                type="button"
                disabled={state.busy || state.instruction.trim() === ""}
                onClick={() => void create()}
              >
                {t("appPages.teams.auto.create")}
              </Button>
              <Show when={state.outcome === "created"}>
                <span class="app-page-status" data-tone="ok" role="status">
                  {t("appPages.teams.auto.created")}
                </span>
              </Show>
              <Show when={state.outcome === "failed"}>
                <span class="app-page-status" data-tone="error" role="alert">
                  {t("appPages.teams.auto.failed")}
                </span>
              </Show>
            </div>
          </div>
        </Show>
        <Show
          when={(props.policy?.automations.length ?? 0) > 0}
          fallback={<p class="app-page-muted">{t("appPages.teams.auto.none")}</p>}
        >
          <ul class="app-page-automations">
            <For each={props.policy?.automations ?? []} keyed={(automation) => automation.id}>
              {(automation) => (
                <li class="app-page-automation">
                  <span class="app-page-automation-text">
                    <strong>{automation().label}</strong>
                    <span class="app-page-muted">
                      {agentName(automation().agentId)} ·{" "}
                      {t("appPages.teams.auto.every", { minutes: automation().frequencyMinutes })}
                    </span>
                    <span class="app-page-muted">{automation().instruction}</span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("appPages.teams.auto.stopLabel", { name: automation().label })}
                    onClick={() => void props.onStopAutomation(automation().id)}
                  >
                    {t("appPages.teams.auto.stop")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
