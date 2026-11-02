import { META_ADS_RANGES, type MetaAdsOverview, type MetaAdsRange } from "@openbot/contracts/ipc";
import type { AppPageAgent } from "@openbot/ui/features/app-pages/AppAgentsSection";
import { MetaAdsView } from "@openbot/ui/features/app-pages/MetaAdsView";
import { createEffect, createStore, onSettled } from "solid-js";
import { type AppPagesPort, appPagesPort } from "./app-pages-port";

const RANGE_STORAGE_KEY = "opencat.metaAds.range";
/** The main process caches a reading for a short time, so a refresh now and then costs few calls. */
const REFRESH_MS = 120_000;

function readRange(): MetaAdsRange {
  try {
    const saved = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return META_ADS_RANGES.find((range) => range === saved) ?? "last_7d";
  } catch {
    return "last_7d";
  }
}

interface MetaAdsPanelState {
  overview: MetaAdsOverview | null;
  refreshing: boolean;
  range: MetaAdsRange;
}

/**
 * The Meta Ads page of the desktop window. Main reads the Business Manager data with the saved token;
 * this container picks the period, asks for a reading and passes it to the shared view. The token never
 * reaches this process.
 */
export function MetaAdsPanel(props: {
  serverId: string;
  agents: readonly AppPageAgent[];
  onOpenApp: () => void;
  onOpenTasks: () => void;
  onBack: () => void;
  /** Tests and stories give their own port. The default is the desktop bridge. */
  port?: AppPagesPort;
}) {
  const port = () => props.port ?? appPagesPort();
  const [state, setState] = createStore<MetaAdsPanelState>({ overview: null, refreshing: false, range: readRange() });
  let generation = 0;

  async function load(range: MetaAdsRange, refresh: boolean): Promise<void> {
    const request = ++generation;
    setState((draft) => {
      draft.refreshing = true;
    });
    let overview: MetaAdsOverview;
    try {
      overview = await port().appPages.metaOverview({ range, refresh });
    } catch {
      overview = { state: "error", reason: "unknown" };
    }
    if (request !== generation) return;
    setState((draft) => {
      draft.overview = overview;
      draft.refreshing = false;
    });
  }

  createEffect(
    () => state.range,
    (range) => {
      void load(range, false);
    },
  );
  onSettled(() => {
    const timer = window.setInterval(() => void load(state.range, false), REFRESH_MS);
    return () => {
      generation++;
      window.clearInterval(timer);
    };
  });

  return (
    <MetaAdsView
      overview={state.overview}
      refreshing={state.refreshing}
      range={state.range}
      onRangeChange={(range) => {
        try {
          window.localStorage.setItem(RANGE_STORAGE_KEY, range);
        } catch {
          // Blocked storage keeps the choice for this window only.
        }
        setState((draft) => {
          draft.range = range;
        });
      }}
      onRefresh={() => void load(state.range, true)}
      onBack={props.onBack}
      onOpenApp={props.onOpenApp}
      loadChildren={(query) => port().appPages.metaChildren({ ...query, range: state.range })}
      onChange={(change) => port().appPages.metaChange(change)}
      agents={props.agents}
      onAsk={async (agentId, text) => {
        await port().startTask({ agentId, text }, props.serverId);
        return true;
      }}
      onOpenTasks={props.onOpenTasks}
    />
  );
}
