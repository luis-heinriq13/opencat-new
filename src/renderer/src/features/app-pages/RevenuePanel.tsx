import type { RevenueOverview } from "@openbot/contracts/ipc";
import { RevenueView } from "@openbot/ui/features/app-pages/RevenueView";
import { createStore, onSettled } from "solid-js";
import { type AppPagesPort, appPagesPort } from "./app-pages-port";

const REFRESH_MS = 120_000;

interface RevenuePanelState {
  overview: RevenueOverview | null;
  refreshing: boolean;
}

export function RevenuePanel(props: { onOpenApp: () => void; onBack: () => void; port?: AppPagesPort }) {
  const port = () => props.port ?? appPagesPort();
  const [state, setState] = createStore<RevenuePanelState>({ overview: null, refreshing: false });
  let request = 0;

  async function load(refresh: boolean) {
    const current = ++request;
    setState((draft) => {
      draft.refreshing = true;
    });
    try {
      const overview = await port().appPages.revenueOverview({ refresh });
      if (current === request) {
        setState((draft) => {
          draft.overview = overview;
          draft.refreshing = false;
        });
      }
    } catch {
      if (current === request) {
        setState((draft) => {
          draft.refreshing = false;
        });
      }
    }
  }

  onSettled(() => {
    void load(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(false);
    }, REFRESH_MS);
    return () => {
      request++;
      window.clearInterval(timer);
    };
  });

  return (
    <RevenueView
      overview={state.overview}
      refreshing={state.refreshing}
      onRefresh={() => void load(true)}
      onBack={props.onBack}
      onOpenApp={props.onOpenApp}
    />
  );
}
