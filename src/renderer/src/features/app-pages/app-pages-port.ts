import type { OpenBotDesktopApi, StartAgentTaskInput } from "@openbot/contracts/ipc";

/** What the Meta Ads and Teams pages reach in main. Read on each call: tests and stories replace `window.openbot` per case. */
export interface AppPagesPort {
  appPages: OpenBotDesktopApi["appPages"];
  /** Starts a task for an agent of the server. */
  startTask: (input: StartAgentTaskInput, serverId: string) => Promise<unknown>;
  openLink: (url: string) => Promise<unknown>;
  copyText: (text: string) => void;
}

export function appPagesPort(): AppPagesPort {
  return {
    appPages: window.openbot.appPages,
    startTask: (input, serverId) => window.openbot.agent.startTask(input, serverId),
    openLink: (url) => window.openbot.openUrl(url),
    copyText: (text) => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
  };
}
