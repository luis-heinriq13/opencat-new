import { isUpdateActivePhase, MCP_SERVERS_CAPABILITY } from "@openbot/contracts/ipc";
import { AGENT_TASKS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-tasks-v1";
import { WHATSCAT_PANEL_URL } from "@openbot/ui/features/marketplace/marketplace-model";
import type { SidebarView } from "@openbot/ui/features/sidebar/sidebar-types";
import { PageRail, type PageRailPage } from "@openbot/ui/features/window/PageRail";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo } from "solid-js";
import { appPort } from "../../app-port";
import { useLayout } from "../../layout";
import { usePlatform } from "../../platform";
import { useChannels } from "../channels/channels-context";
import { useCustomAgents } from "../custom-agents/custom-agents-context";
import { serverCanAdminister, serverSupportsCapability } from "../servers/server-capabilities";
import { useServers } from "../servers/servers-context";
import { desktopMarketplaceCalls } from "../settings/marketplace-calls";
import { useSettings } from "../settings/settings-context";
import { useUpdates } from "../updates/updates-context";
import { useWhatsNew } from "../updates/whats-new-context";
import { usePlanLimitRows } from "../usage/plan-limit-rows";
import { RailHelpMenu } from "./RailHelpMenu";
import { heldMcpServers, installedPinnedApps, publishHeldMcpServers } from "./rail-apps";
import { useWindowPage } from "./window-page-context";

/**
 * The page rail of the desktop window. Agents, Routines, Workflows, Schedule, Attendance, Usage, Marketplace and
 * Settings change the page in the card.
 */
export function WorkspacePageRail(props: { hidden: boolean }) {
  const text = useText();
  const windowPage = useWindowPage();
  const { openAppSettings, setSkillsMarketplaceOpen, setPendingPluginSlug } = useSettings();
  const updates = useUpdates();
  const layout = useLayout();
  const channels = useChannels();
  const whatsNew = useWhatsNew();
  const { activeServer } = useServers();
  const platform = usePlatform();
  /** macOS draws the window buttons in the top row of the rail. Windows and Linux show the logo there. */
  const logo = () => {
    const info = platform.appInfo();
    return info && info.platform !== "darwin" ? { variant: info.variant } : undefined;
  };
  /** Agents and Routines show the same page; they set the list of the sidebar. */
  function showSidebarView(view: SidebarView) {
    windowPage.showAgents();
    // An open channel would stay in the middle with no row in the list.
    if (view === "routines") channels.close();
    layout.setSidebarView(view);
  }
  const usageRows = usePlanLimitRows();
  const { customAgentUsage } = useCustomAgents();
  /** The custom agents run on this computer, so a joined server does not show their usage. */
  const localAgentUsage = () => (activeServer()?.kind === "local" ? customAgentUsage() : []);
  /** The compact sidebar has no footer, so the update island does not show. The Settings button then marks the update. */
  const updateNotice = () => {
    const status = updates.status();
    const phase = status.phase;
    if (!layout.leftPanelCompact() || !isUpdateActivePhase(phase)) return undefined;
    return text.t(phase === "ready" || phase === "installing" ? "account.update.ready" : "account.update.available");
  };
  // An older joined server has no task routes.
  const tasksAvailable = () => {
    const server = activeServer();
    return !server || server.kind === "local" || serverSupportsCapability(server, AGENT_TASKS_CAPABILITY);
  };
  /**
   * The host whose apps the Marketplace installs: the one it installs to. A joined server where this
   * account is a member has none, and then no app shows in the rail.
   */
  const appServerId = createMemo(() => {
    const server = activeServer();
    return serverCanAdminister(server, "skills-admin-v1") && serverCanAdminister(server, MCP_SERVERS_CAPABILITY)
      ? server.id
      : undefined;
  });
  // The rail reads the rows on its own, so it needs no open Marketplace. A page change reads them
  // again: the settings pages also add and remove MCP servers.
  createEffect(
    () => ({ serverId: appServerId(), pinned: layout.railAppPins().length > 0, page: windowPage.page() }),
    ({ serverId, pinned }) => {
      if (!serverId || !pinned) return;
      void desktopMarketplaceCalls()
        .mcp.listMcpServers(serverId)
        .then(
          (held) => publishHeldMcpServers(serverId, held),
          () => undefined,
        );
    },
  );
  const pinnedApps = createMemo(() => {
    const serverId = appServerId();
    return serverId ? installedPinnedApps(layout.railAppPins(), heldMcpServers(serverId)) : [];
  });
  const isLocalHost = () => {
    const server = activeServer();
    return !server || server.kind === "local";
  };
  /** An interactive app opens its own panel. Every other app opens its store page, where it is set up. */
  function openApp(slug: string) {
    const app = pinnedApps().find((candidate) => candidate.slug === slug);
    // The panel is a local page: a joined server's app must not open this computer's one.
    if (app?.panel === "interactive" && slug === "whatscat" && isLocalHost()) {
      void appPort().openUrl(WHATSCAT_PANEL_URL);
      return;
    }
    // The Meta Ads and Teams pages read this computer's apps, so a joined server never opens them.
    if (app?.panel === "interactive" && isLocalHost()) {
      if (slug === "meta-ads") return windowPage.openMetaAds(null);
      if (slug === "teams") return windowPage.openTeams(null);
      if (slug === "cakto") return windowPage.openRevenue(null);
    }
    setPendingPluginSlug(slug);
    setSkillsMarketplaceOpen(true);
  }
  const current = (): PageRailPage | null => {
    const page = windowPage.page();
    if (page === "agents") return layout.sidebarView();
    return page === "server-settings" || page === "meta-ads" || page === "teams" || page === "revenue" ? null : page;
  };
  return (
    <PageRail
      hidden={props.hidden}
      current={current()}
      pinned={layout.railPinned()}
      onPinChange={layout.setRailPinned}
      apps={pinnedApps()}
      currentApp={
        windowPage.page() === "meta-ads" || windowPage.page() === "teams" || windowPage.page() === "revenue"
          ? windowPage.page()
          : null
      }
      onOpenApp={openApp}
      usageRows={usageRows()}
      customAgentUsage={localAgentUsage()}
      onAgents={() => showSidebarView("agents")}
      onRoutines={() => showSidebarView("routines")}
      // A joined server without workflows shows its notice on the page.
      onWorkflows={() => windowPage.openWorkflows(null)}
      onSchedule={windowPage.openSchedule}
      onAttendance={windowPage.openAttendance}
      onTasks={tasksAvailable() ? windowPage.openTasks : undefined}
      onUsage={windowPage.openUsage}
      onMarketplace={() => setSkillsMarketplaceOpen(true)}
      onSettings={(button) => (updateNotice() ? openAppSettings(button, "updates") : windowPage.openSettings(button))}
      settingsNotice={updateNotice()}
      logo={logo()}
      help={(expanded) => (
        <RailHelpMenu
          expanded={expanded}
          version={whatsNew.state.version}
          onOpenWhatsNew={whatsNew.reopen}
          onOpenLink={(destination) => void appPort().openExternal(destination)}
        />
      )}
    />
  );
}
