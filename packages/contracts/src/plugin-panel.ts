/**
 * What an installed catalog app gives the user when it is pinned to the page rail.
 *
 * - `interactive`: the app has a panel of its own that the user works in, such as the WhatsApp
 *   (not official) panel where the number is connected. Main knows how to open it.
 * - `connect`: the app has only a connection to set up and use through agents. The rail opens its
 *   store page.
 *
 * The catalog states it per listing in `plugin.json`. A missing value, or a value that a newer
 * catalog adds, reads as `connect`, so an older app never opens a panel it does not have.
 */
export const PLUGIN_PANELS = ["interactive", "connect"] as const;
export type PluginPanel = (typeof PLUGIN_PANELS)[number];

export function isPluginPanel(value: unknown): value is PluginPanel {
  return PLUGIN_PANELS.some((panel) => panel === value);
}

/** The panel of a listing: the stated one, else `connect`. */
export function pluginPanel(value: unknown): PluginPanel {
  return isPluginPanel(value) ? value : "connect";
}
