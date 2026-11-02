import type { TeamsOverview, TeamsPolicy } from "@openbot/contracts/ipc";
import type { AppPageAgent } from "@openbot/ui/features/app-pages/AppAgentsSection";
import { TeamsView } from "@openbot/ui/features/app-pages/TeamsView";
import { createEffect, createStore, onSettled } from "solid-js";
import { type AppPagesPort, appPagesPort } from "./app-pages-port";

/** While a sign-in waits, the page asks every tick whether the owner finished it. An idle page reads again now and then. */
const POLL_MS = 4_000;
const IDLE_TICKS = 15;

interface TeamsPanelState {
  overview: TeamsOverview | null;
  refreshing: boolean;
  policy: TeamsPolicy | null;
}

/**
 * The Microsoft Teams page of the desktop window. Main holds the session and reads the Graph; this
 * container asks for a reading, runs the sign-in and the send, and passes everything to the shared view.
 */
export function TeamsPanel(props: {
  serverId: string;
  agents: readonly AppPageAgent[];
  onOpenTasks: () => void;
  onBack: () => void;
  /** Tests and stories give their own port. The default is the desktop bridge. */
  port?: AppPagesPort;
}) {
  const port = () => props.port ?? appPagesPort();
  const [state, setState] = createStore<TeamsPanelState>({ overview: null, refreshing: false, policy: null });
  let generation = 0;

  async function load(): Promise<void> {
    const request = ++generation;
    setState((draft) => {
      draft.refreshing = true;
    });
    let overview: TeamsOverview | null;
    let policy: TeamsPolicy | null;
    try {
      [overview, policy] = await Promise.all([port().appPages.teamsOverview(), port().appPages.teamsPolicy()]);
    } catch {
      overview = null;
      policy = null;
    }
    if (request !== generation) return;
    setState((draft) => {
      if (overview) draft.overview = overview;
      if (policy) draft.policy = policy;
      draft.refreshing = false;
    });
  }

  createEffect(
    () => props.serverId,
    () => {
      void load();
    },
  );
  onSettled(() => {
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      // A waiting sign-in is checked every tick; an idle page now and then.
      const waiting = state.overview?.signIn != null;
      if (!document.hidden && (waiting || ticks % IDLE_TICKS === 0)) void load();
    }, POLL_MS);
    return () => {
      generation++;
      window.clearInterval(timer);
    };
  });

  return (
    <TeamsView
      overview={state.overview}
      refreshing={state.refreshing}
      onRefresh={() => void load()}
      onBack={props.onBack}
      onSignIn={async () => {
        const overview = await port().appPages.teamsSignIn();
        setState((draft) => {
          draft.overview = overview;
        });
      }}
      loadMessages={(target) => port().appPages.teamsMessages(target)}
      policy={state.policy}
      onSavePolicy={async (policy) => {
        const saved = await port().appPages.teamsSavePolicy(policy);
        setState((draft) => {
          draft.policy = saved;
        });
        return true;
      }}
      onCreateAutomation={async (input) => {
        const saved = await port().appPages.teamsCreateAutomation(input);
        setState((draft) => {
          draft.policy = saved;
        });
        return true;
      }}
      onStopAutomation={async (id) => {
        const saved = await port().appPages.teamsStopAutomation(id);
        setState((draft) => {
          draft.policy = saved;
        });
      }}
      onRetryChannels={() => {
        void port()
          .appPages.teamsRetryChannels()
          .then((overview) =>
            setState((draft) => {
              draft.overview = overview;
            }),
          );
      }}
      onSend={(input) => port().appPages.teamsSend(input)}
      onSetSend={async (enabled) => {
        try {
          const saved = await port().appPages.teamsSetSendEnabled(enabled);
          await load();
          return saved;
        } catch {
          return null;
        }
      }}
      onCopy={(text) => port().copyText(text)}
      onOpenLink={(url) => void port().openLink(url)}
      agents={props.agents}
      onAsk={async (agentId, text) => {
        await port().startTask({ agentId, text }, props.serverId);
        return true;
      }}
      onOpenTasks={props.onOpenTasks}
    />
  );
}
