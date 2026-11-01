import type { AppConnectionChange, AppConnectionStatus } from "@openbot/contracts/ipc";
import type { MarketplaceAppAgent } from "@openbot/ui/features/marketplace/marketplace-model";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal } from "solid-js";
import type { MarketplaceCalls } from "./marketplace-calls";

const WHATSAPP = "whatsapp" as const;

export interface MarketplaceAppAgentOptions {
  /** Absent on a client that cannot reach this computer's apps. */
  calls: () => MarketplaceCalls["appConnections"];
  /** The Marketplace is open and this computer keeps the apps. */
  active: () => boolean;
  agentName: (agentId: string) => string;
  /** Runs `work`; a failure becomes the Marketplace error and the answer is undefined. */
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  setNotice: (notice: string) => void;
  openPanel: () => void;
}

/** The agent that answers on WhatsApp (not official), read when the Marketplace opens and after each change. */
export function createMarketplaceAppAgent(options: MarketplaceAppAgentOptions) {
  const { t } = useText();
  const [status, setStatus] = createSignal<AppConnectionStatus | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);

  createEffect(
    () => (options.active() ? options.calls() : undefined),
    (calls) => {
      if (!calls) return;
      let current = true;
      calls.status(WHATSAPP).then(
        (next) => {
          if (current) setStatus(next);
        },
        () => undefined,
      );
      return () => {
        current = false;
      };
    },
  );

  async function change(change: AppConnectionChange, notice: string): Promise<boolean> {
    const calls = options.calls();
    if (!calls || busy()) return false;
    setBusy(true);
    try {
      const next = await options.run(() => calls.change(change));
      if (!next) return false;
      setStatus(next);
      options.setNotice(notice);
      return true;
    } finally {
      setBusy(false);
    }
  }

  const control: MarketplaceAppAgent = {
    status,
    busy,
    setAgent: (agentId) =>
      change(
        { app: WHATSAPP, action: "set-agent", agentId },
        t("marketplace.whatscat.agent.noticeSet", { name: options.agentName(agentId) }),
      ),
    turnOn: () => change({ app: WHATSAPP, action: "turn-on" }, t("marketplace.whatscat.agent.noticeResumed")),
    pause: () => change({ app: WHATSAPP, action: "pause" }, t("marketplace.whatscat.agent.noticePaused")),
    disconnect: () =>
      change({ app: WHATSAPP, action: "disconnect" }, t("marketplace.whatscat.agent.noticeDisconnected")),
    openPanel: options.openPanel,
  };
  return { control, available: () => options.calls() !== undefined };
}
