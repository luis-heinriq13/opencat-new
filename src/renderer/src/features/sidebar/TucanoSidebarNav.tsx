import { useText } from "@openbot/ui/text";
import { For } from "solid-js";
import { useLayout } from "../../layout";
import { useChannels } from "../channels/channels-context";
import { useSettings } from "../settings/settings-context";
import { useWindowPage } from "../window/window-page-context";
import "./tucano-sidebar.css";

/**
 * OpenCat: the optional layout that lists the pages in the sidebar, instead of in the page rail. Each
 * row opens the same page as the rail, so nothing here holds its own state.
 */
export function TucanoSidebarNav() {
  const { t } = useText();
  const layout = useLayout();
  const windowPage = useWindowPage();
  const channels = useChannels();
  const { setSkillsMarketplaceOpen } = useSettings();
  const showRoutines = () => {
    windowPage.showAgents();
    channels.close();
    layout.setSidebarView("routines");
  };
  const showAgents = () => {
    windowPage.showAgents();
    layout.setSidebarView("agents");
  };
  const rows = (): { label: string; open: (button: HTMLElement) => void }[] => [
    { label: t("sidebar.tucano.agents"), open: showAgents },
    { label: t("sidebar.tucano.routines"), open: showRoutines },
    { label: t("sidebar.tucano.schedule"), open: (button) => windowPage.openSchedule(button) },
    { label: t("sidebar.tucano.tasks"), open: (button) => windowPage.openTasks(button) },
    { label: t("sidebar.tucano.skills"), open: () => setSkillsMarketplaceOpen(true) },
    { label: t("sidebar.tucano.usage"), open: (button) => windowPage.openUsage(button) },
    { label: t("sidebar.tucano.settings"), open: (button) => windowPage.openSettings(button) },
  ];
  return (
    <div class="tucano-sidebar-nav">
      <For each={rows()}>
        {(row) => (
          <button type="button" class="tucano-sidebar-row" onClick={(event) => row.open(event.currentTarget)}>
            {row.label}
          </button>
        )}
      </For>
    </div>
  );
}
