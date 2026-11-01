import type { AppConnectionState } from "@openbot/contracts/ipc";
import {
  Button,
  Dialog,
  ExternalLink,
  IconButton,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Plug,
  X,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { StatusPill } from "../settings/IntegrationLayout";

/** An app that answers through the agent. `id` is its store page. */
export interface AgentConnectedApp {
  id: string;
  name: string;
  state: AppConnectionState;
}

export interface AgentAppsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: readonly AgentConnectedApp[];
  /** Opens the store page of the app. */
  onOpenApp: (id: string) => void;
  /** Opens the store, where the user connects an app. */
  onConnect: () => void;
}

/**
 * The apps that answer through one agent, each with its state and a link to its store page. The
 * agent settings open it from the Apps row. Everything comes in through props.
 */
export function AgentAppsDialog(props: AgentAppsDialogProps) {
  const { t } = useText();
  let content: HTMLDivElement | undefined;
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="agent-memories-overlay" />
        <Dialog.Content
          ref={(element) => (content = element)}
          class="agent-memories-modal"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content?.focus({ preventScroll: true });
          }}
        >
          <header class="agent-memories-header">
            <div class="agent-memories-heading">
              <Dialog.Title>{t("agentSettings.apps.title")}</Dialog.Title>
              <Dialog.Description class="sr-only">{t("agentSettings.apps.description")}</Dialog.Description>
            </div>
            <div class="agent-memories-header-actions">
              <IconButton
                label={t("agentSettings.apps.close")}
                variant="ghost"
                onClick={() => props.onOpenChange(false)}
              >
                <X />
              </IconButton>
            </div>
          </header>
          <div class="agent-memories-body">
            <Show
              when={props.apps.length > 0}
              fallback={<p class="agent-memory-state">{t("agentSettings.apps.empty")}</p>}
            >
              <ItemGroup class="settings-modal-card">
                <For each={props.apps}>
                  {(app) => (
                    <Item class="settings-modal-row">
                      <ItemMedia>
                        <Plug aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{app.name}</ItemTitle>
                        <ItemDescription>
                          <StatusPill
                            status={app.state === "on" ? "connected" : "attention"}
                            label={t(app.state === "on" ? "agentSettings.apps.on" : "agentSettings.apps.paused")}
                          />
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <IconButton
                          label={t("agentSettings.apps.openNamed", { name: app.name })}
                          variant="ghost"
                          onClick={() => props.onOpenApp(app.id)}
                        >
                          <ExternalLink />
                        </IconButton>
                      </ItemActions>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </Show>
            <Button type="button" variant="outline" size="sm" onClick={props.onConnect}>
              {t("agentSettings.apps.connect")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
