import { useText } from "@openbot/ui/text";
import { Loading, Match, Show, Switch } from "solid-js";
import { AgentUsagePanel, WorkflowsPage } from "../../lazy-views";
import { SkillsMarketplace } from "../../WorkspaceOverlays";
import { useAgents } from "../agents/agents-context";
import { MetaAdsPanel } from "../app-pages/MetaAdsPanel";
import { TeamsPanel } from "../app-pages/TeamsPanel";
import { RevenuePanel } from "../app-pages/RevenuePanel";
import { AttendancePanel } from "../attendance/AttendancePanel";
import { SchedulePanel } from "../schedule/SchedulePanel";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { useUsage } from "../usage/usage-context";
import { SettingsPage } from "./SettingsPage";
import { type SettingsKind, useWindowPage } from "./window-page-context";

/**
 * The page of the desktop window that covers the conversation: a settings page, usage, schedule,
 * workflows or the Marketplace. The tasks page shows in the middle pane, in `WorkspaceShell`.
 */
export function WindowPageView() {
  const { t } = useText();
  const windowPage = useWindowPage();
  const usage = useUsage();
  const { servers } = useServers();
  const { agentList } = useAgents();
  const { setSkillsMarketplaceOpen, setPendingPluginSlug } = useSettings();
  /** Every agent of the host can use its apps, so the pages list them all. */
  const pageAgents = () => agentList().map((agent) => ({ id: agent.id, name: agent.name }));
  const openApp = (slug: string) => {
    setPendingPluginSlug(slug);
    setSkillsMarketplaceOpen(true);
  };
  const settingsKind = (): SettingsKind | null => {
    const page = windowPage.page();
    if (page === "settings") return "personal";
    return page === "server-settings" ? "server" : null;
  };
  const hostName = (serverId: string) =>
    servers().find((server) => server.id === serverId)?.name ?? t("app.page.serverFallback");
  return (
    <Show
      when={settingsKind() ? null : usage.state.serverId}
      fallback={
        <Show when={settingsKind()} keyed fallback={<SkillsMarketplace />}>
          {(kind) => <SettingsPage kind={kind} />}
        </Show>
      }
    >
      {(serverId) => (
        <Switch
          fallback={
            <Loading>
              <AgentUsagePanel
                serverId={serverId()}
                hostName={hostName(serverId())}
                agentId={usage.state.agentId}
                onBack={usage.closeUsage}
              />
            </Loading>
          }
        >
          <Match when={usage.state.view === "schedule"}>
            <SchedulePanel serverId={serverId()} hostName={hostName(serverId())} onBack={usage.closeUsage} />
          </Match>
          <Match when={usage.state.view === "attendance"}>
            <AttendancePanel
              agentName={(agentId) => agentList().find((agent) => agent.id === agentId)?.name ?? null}
              onOpenStore={() => setSkillsMarketplaceOpen(true)}
              onBack={usage.closeUsage}
            />
          </Match>
          <Match when={usage.state.view === "meta-ads"}>
            <MetaAdsPanel
              serverId={serverId()}
              agents={pageAgents()}
              onOpenApp={() => openApp("meta-ads")}
              onOpenTasks={() => windowPage.openTasks(null)}
              onBack={usage.closeUsage}
            />
          </Match>
          <Match when={usage.state.view === "teams"}>
            <TeamsPanel
              serverId={serverId()}
              agents={pageAgents()}
              onOpenTasks={() => windowPage.openTasks(null)}
              onBack={usage.closeUsage}
            />
          </Match>
          <Match when={usage.state.view === "revenue"}>
            <RevenuePanel onOpenApp={() => openApp("cakto")} onBack={usage.closeUsage} />
          </Match>
          <Match when={usage.state.view === "workflows"}>
            <Loading>
              <WorkflowsPage serverId={serverId()} />
            </Loading>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
