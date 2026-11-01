import type { McpServerConfig } from "@openbot/contracts/ipc";
import { pluginPanel } from "@openbot/contracts/plugin-panel";
import { isPluginAppConfig } from "@openbot/ui/features/settings/marketplace-plugins";
import type { PageRailApp } from "@openbot/ui/features/window/PageRail";
import { createSignal } from "solid-js";
import { MARKETPLACE_PLUGINS } from "../settings/marketplace-plugin-catalog";

/**
 * The MCP servers that each host holds, as the last read saw them. The rail reads its own copy when a
 * host is selected, and the open Marketplace page publishes every read and every change of its own,
 * so an install or an uninstall shows in the rail at once. One module signal: the rail and the
 * Marketplace page are two trees, and neither owns the other.
 */
const [heldServers, setHeldServers] = createSignal<Readonly<Record<string, readonly McpServerConfig[]>>>({});

export function publishHeldMcpServers(serverId: string, servers: readonly McpServerConfig[]): void {
  setHeldServers((current) => ({ ...current, [serverId]: servers }));
}

/** The servers that the host `serverId` held at the last read, or undefined before the first one. */
export function heldMcpServers(serverId: string): readonly McpServerConfig[] | undefined {
  return heldServers()[serverId];
}

/** What the rail does for a pinned app. `interactive` opens the app's own panel, `connect` its store page. */
export interface RailApp extends PageRailApp {
  panel: "interactive" | "connect";
}

/**
 * The pinned apps that are installed on the host, in pin order. A pinned app that is not installed
 * is left out and stays pinned, so a reinstall brings its button back. Before the first read nothing
 * shows, rather than a button that may open nothing.
 */
export function installedPinnedApps(
  pins: readonly string[],
  servers: readonly McpServerConfig[] | undefined,
): RailApp[] {
  if (!servers) return [];
  return pins.flatMap((slug) => {
    const plugin = MARKETPLACE_PLUGINS.find((candidate) => candidate.slug === slug);
    if (!plugin) return [];
    if (!plugin.apps.every((app) => servers.some((held) => isPluginAppConfig(held, app)))) return [];
    return [{ slug, name: plugin.name, panel: pluginPanel(plugin.panel) }];
  });
}
