import { type AppConnectionStatus, appConnectionState } from "@openbot/contracts/ipc";
import type { AppTranslate } from "@openbot/i18n";
import {
  Button,
  ConfirmDialog,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Pause,
  Play,
  SettingsSection,
} from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import { StatusPill } from "../settings/IntegrationLayout";
import type { MarketplaceAgent, MarketplaceAppAgent } from "./marketplace-model";
import { PluginIcon } from "./PluginIcon";

const STATE_PILL = {
  on: { status: "connected", label: "marketplace.whatscat.agent.on" },
  paused: { status: "attention", label: "marketplace.whatscat.agent.paused" },
  none: { status: "idle", label: "marketplace.whatscat.agent.none" },
} as const;

/** The line about which contacts the agent answers. It holds counts, never a number or a name. */
function contactsLine(status: AppConnectionStatus | undefined, t: AppTranslate): string {
  if (!status) return "";
  if (status.scope === "all") {
    return status.excludedCount > 0
      ? t("marketplace.whatscat.agent.contactsAllExcept", { count: status.excludedCount })
      : t("marketplace.whatscat.agent.contactsAll");
  }
  const count = status.chatCount + status.groupCount;
  return count > 0 ? t("marketplace.whatscat.agent.contacts", { count }) : t("marketplace.whatscat.agent.contactsNone");
}

/**
 * "Agent that answers" on the page of an app that talks to people, such as WhatsApp (not official): who
 * answers, whether the replies run or wait, and the agents to pick from. Picking an agent asks first,
 * because that agent then answers the allowed contacts on its own.
 */
export function AppAgentSection(props: { control: MarketplaceAppAgent; agents: readonly MarketplaceAgent[] }) {
  const { t } = useText();
  const [picked, setPicked] = createSignal<MarketplaceAgent | null>(null);
  const status = () => props.control.status();
  const state = () => {
    const current = status();
    return current ? appConnectionState(current) : "none";
  };
  const agentId = () => status()?.agentId ?? null;
  const current = () => props.agents.find((agent) => agent.id === agentId());
  const description = () => {
    const contacts = contactsLine(status(), t);
    switch (state()) {
      case "on":
        return t("marketplace.whatscat.agent.onDescription", { contacts });
      case "paused":
        return t("marketplace.whatscat.agent.pausedDescription", { contacts });
      case "none":
        return t("marketplace.whatscat.agent.noneDescription");
    }
  };

  return (
    <>
      <SettingsSection
        title={t("marketplace.whatscat.agent.title")}
        description={t("marketplace.whatscat.agent.description")}
      >
        <ItemGroup class="settings-modal-card">
          <Item class="settings-modal-row">
            <ItemMedia>
              <Show when={current()} fallback={<PluginIcon iconUrl={null} />}>
                {(agent) => (
                  <span class="integrations-agent-face" data-size="md">
                    <AgentAvatar agent={agent()} motion="idle" />
                  </span>
                )}
              </Show>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {agentId() === null
                  ? t("marketplace.whatscat.agent.noAgent")
                  : (current()?.name ?? t("marketplace.whatscat.agent.missing"))}
              </ItemTitle>
              <ItemDescription>{description()}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <StatusPill status={STATE_PILL[state()].status} label={t(STATE_PILL[state()].label)} />
              <Show when={state() === "on"}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={props.control.busy()}
                  onClick={() => void props.control.pause()}
                >
                  <Pause aria-hidden="true" />
                  {t("marketplace.whatscat.agent.pause")}
                </Button>
              </Show>
              <Show when={state() === "paused"}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={props.control.busy()}
                  onClick={() => void props.control.turnOn()}
                >
                  <Play aria-hidden="true" />
                  {t("marketplace.whatscat.agent.resume")}
                </Button>
              </Show>
            </ItemActions>
          </Item>
          <Item class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("marketplace.whatscat.agent.panelTitle")}</ItemTitle>
              <ItemDescription>{t("marketplace.whatscat.agent.panelDescription")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button type="button" variant="outline" size="sm" onClick={() => props.control.openPanel()}>
                {t("marketplace.whatscat.agent.openPanel")}
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>

      <SettingsSection title={t("marketplace.whatscat.agent.pickTitle")}>
        <ItemGroup class="settings-modal-card">
          <For
            each={props.agents}
            fallback={
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t("marketplace.whatscat.agent.noAgents")}</ItemDescription>
                </ItemContent>
              </Item>
            }
          >
            {(agent) => (
              <Item class="settings-modal-row">
                <ItemMedia>
                  <span class="integrations-agent-face" data-size="md">
                    <AgentAvatar agent={agent} motion="idle" />
                  </span>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{agent.name}</ItemTitle>
                  <ItemDescription>{agent.title}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Show
                    when={agent.id === agentId()}
                    fallback={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={props.control.busy()}
                        aria-label={t("marketplace.whatscat.agent.chooseNamed", { name: agent.name })}
                        onClick={() => setPicked(agent)}
                      >
                        {t("marketplace.whatscat.agent.choose")}
                      </Button>
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={props.control.busy()}
                      onClick={() => void props.control.disconnect()}
                    >
                      {t("marketplace.whatscat.agent.disconnect")}
                    </Button>
                  </Show>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>

      <ConfirmDialog
        open={picked() !== null}
        tone="default"
        title={t("marketplace.whatscat.agent.confirmTitle", { name: picked()?.name ?? "" })}
        description={t("marketplace.whatscat.agent.confirmDescription", { name: picked()?.name ?? "" })}
        confirmLabel={t("marketplace.whatscat.agent.confirm")}
        media={
          <Show when={picked()}>
            {(agent) => (
              <span class="integrations-agent-face" data-size="lg">
                <AgentAvatar agent={agent()} motion="idle" />
              </span>
            )}
          </Show>
        }
        onCancel={() => setPicked(null)}
        onConfirm={async () => {
          const agent = picked();
          if (!agent) return;
          if (await props.control.setAgent(agent.id)) setPicked(null);
        }}
      />
    </>
  );
}
