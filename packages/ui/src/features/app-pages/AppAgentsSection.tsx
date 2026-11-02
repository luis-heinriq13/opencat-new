import { Button, Label, Textarea } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, createUniqueId, For, Show } from "solid-js";

export interface AppPageAgent {
  id: string;
  name: string;
}

interface AskState {
  agentId: string | null;
  /** The text the owner typed, or null while the draft is still the one that the page suggests. */
  text: string | null;
  busy: boolean;
  outcome: "none" | "started" | "failed";
  startedName: string;
}

/**
 * "Agents with access" and the guidance box of an app page. The agents of a host share its apps, so the
 * list is every agent that the owner can ask. The owner reads and edits the draft, and only the button
 * starts a task with it.
 */
export function AppAgentsSection(props: {
  title: string;
  guideTitle: string;
  guideBody: string;
  /** The suggested text. It follows the page until the owner edits it. */
  draft: string;
  agents: readonly AppPageAgent[];
  /** Starts a task with the text. Resolves false when it did not start. */
  onAsk: (agentId: string, text: string) => Promise<boolean>;
  onOpenTasks: () => void;
}) {
  const { t } = useText();
  const textareaId = `app-page-draft-${createUniqueId()}`;
  const [state, setState] = createStore<AskState>({
    agentId: null,
    text: null,
    busy: false,
    outcome: "none",
    startedName: "",
  });
  const agentId = () => state.agentId ?? props.agents[0]?.id ?? null;
  const text = () => state.text ?? props.draft;

  async function ask(): Promise<void> {
    const id = agentId();
    const agent = props.agents.find((candidate) => candidate.id === id);
    const body = text().trim();
    if (!agent || body === "" || state.busy) return;
    setState((draft) => {
      draft.busy = true;
      draft.outcome = "none";
    });
    let started = false;
    try {
      started = await props.onAsk(agent.id, body);
    } catch {
      started = false;
    }
    setState((draft) => {
      draft.busy = false;
      draft.outcome = started ? "started" : "failed";
      draft.startedName = agent.name;
    });
  }

  return (
    <section class="app-page-card" aria-labelledby={`${textareaId}-title`}>
      <h3 id={`${textareaId}-title`}>{props.title}</h3>
      <p class="app-page-muted">{t("appPages.agents.hostWide")}</p>
      <Show when={props.agents.length > 0} fallback={<p class="app-page-muted">{t("appPages.agents.empty")}</p>}>
        <fieldset class="app-page-agent-list" aria-label={t("appPages.agents.pick")}>
          <For each={props.agents}>
            {(agent) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                class="app-page-agent"
                aria-pressed={agentId() === agent.id ? "true" : "false"}
                onClick={() =>
                  setState((draft) => {
                    draft.agentId = agent.id;
                  })
                }
              >
                {agent.name}
              </Button>
            )}
          </For>
        </fieldset>
        <div class="app-page-guide">
          <h4>{props.guideTitle}</h4>
          <p class="app-page-muted">{props.guideBody}</p>
          <Label for={textareaId}>{t("appPages.agents.draftLabel")}</Label>
          <Textarea
            id={textareaId}
            rows={4}
            value={text()}
            onValueChange={(value) =>
              setState((draft) => {
                draft.text = value;
              })
            }
          />
          <div class="app-page-actions">
            <Button
              type="button"
              disabled={state.busy || text().trim() === "" || agentId() === null}
              onClick={() => void ask()}
            >
              {state.busy ? t("appPages.agents.asking") : t("appPages.agents.ask")}
            </Button>
            <Show when={state.outcome === "started"}>
              <span class="app-page-status" role="status">
                {t("appPages.agents.started", { name: state.startedName })}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={props.onOpenTasks}>
                {t("appPages.agents.openTasks")}
              </Button>
            </Show>
            <Show when={state.outcome === "failed"}>
              <span class="app-page-status" data-tone="error" role="alert">
                {t("appPages.agents.failed")}
              </span>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}
