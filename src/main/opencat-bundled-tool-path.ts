// The Meta Ads and Teams pages run the same module as the apps' MCP servers. Main loads it from the
// signed application resources, never from `~/.opencat`: an agent can write that folder, and code that
// main imports runs with the privileges of the app. In development the repository copy is used.

import { join } from "node:path";
import { app } from "electron";

export function bundledToolModule(folder: string, file: string): string {
  return app.isPackaged ? join(process.resourcesPath, folder, file) : join(app.getAppPath(), "tools", folder, file);
}
