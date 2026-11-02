// The pages of the Meta Ads and Microsoft Teams apps. See `../opencat-meta-ads-dashboard.ts` and
// `../opencat-teams-panel.ts`. Both read the settings that the app's server holds on this computer;
// the renderer never receives a token or a session.

import type { McpServerConfig } from "@openbot/contracts/ipc";
import type { Effect } from "effect";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import {
  createMetaAdsDashboard,
  loadInstalledMetaAdsTools,
  META_ADS_SERVER_NAME,
  type MetaAdsDashboardDependencies,
} from "../opencat-meta-ads-dashboard";
import { CAKTO_SERVER_NAME, createRevenueDashboard } from "../opencat-revenue-dashboard";
import {
  createTeamsPanel,
  loadInstalledTeamsModule,
  TEAMS_SEND_VARIABLE,
  TEAMS_SERVER_NAME,
  type TeamsPanelDependencies,
} from "../opencat-teams-panel";
import {
  parseMetaAdsChange,
  parseMetaAdsChildrenQuery,
  parseMetaAdsQuery,
  parseSendEnabled,
  parseTeamsAgentPolicy,
  parseTeamsAutomation,
  parseTeamsAutomationId,
  parseTeamsSend,
  parseTeamsTarget,
} from "./app-page-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { isObject } from "./validation";

export interface AppPageIpcDependencies {
  service: Pick<AgentService, "listMcpServers" | "createRoutine"> & {
    deleteRoutine(input: { agentId: string; routineId: string }): Effect.Effect<unknown, { readonly cause: unknown }>;
    saveMcpServer(input: { config: McpServerConfig }): Effect.Effect<unknown, { readonly cause: unknown }>;
  };
  /** Tests give their own loaders. */
  loadMetaTools?: MetaAdsDashboardDependencies["loadTools"];
  loadTeamsModule?: TeamsPanelDependencies["loadModule"];
}

export function appPageIpcHandlers({
  service,
  loadMetaTools = loadInstalledMetaAdsTools,
  loadTeamsModule = loadInstalledTeamsModule,
}: AppPageIpcDependencies): Pick<IpcGroupHandlers, "appPages"> {
  /** The saved server of an app on this computer, when it is installed and on. */
  const savedServer = (name: string): McpServerConfig | undefined =>
    service.listMcpServers().find((server) => server.name === name && server.enabled && server.transport === "stdio");
  const environmentOf = (name: string) => (): Readonly<Record<string, string>> | null => {
    const server = savedServer(name);
    return server ? Object.fromEntries(server.env.map((pair) => [pair.key, pair.value])) : null;
  };
  const meta = createMetaAdsDashboard({ environment: environmentOf(META_ADS_SERVER_NAME), loadTools: loadMetaTools });
  const teams = createTeamsPanel({
    environment: environmentOf(TEAMS_SERVER_NAME),
    loadModule: loadTeamsModule,
    routines: {
      create: ({ agentId, name, instruction, timezone, anchorAt, minutes }) =>
        service.createRoutine({
          agentId,
          name,
          instruction,
          active: true,
          timezone,
          schedule: { kind: "interval", amount: minutes, unit: "minutes", anchorAt },
        }),
      remove: async (agentId, routineId) => {
        await runCauseEffect(service.deleteRoutine({ agentId, routineId }));
      },
    },
  });
  const revenue = createRevenueDashboard({ environment: environmentOf(CAKTO_SERVER_NAME) });
  const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    appPages: {
      metaOverview: payloadHandler(parseMetaAdsQuery, (query) => meta.overview(query)),
      metaChildren: payloadHandler(parseMetaAdsChildrenQuery, (query) => meta.children(query)),
      metaChange: payloadHandler(parseMetaAdsChange, (change) => meta.change(change)),
      revenueOverview: payloadHandler(
        (value): { refresh?: boolean | undefined } => {
          if (value === undefined) return {};
          if (!isObject(value) || (value.refresh !== undefined && value.refresh !== true && value.refresh !== false))
            throw new Error("A refresh value must be boolean.");
          return { refresh: value.refresh === true };
        },
        (query) => revenue.overview(query.refresh),
      ),
      teamsOverview: handler(() => teams.overview()),
      teamsMessages: payloadHandler(parseTeamsTarget, (target) => teams.messages(target)),
      teamsSend: payloadHandler(parseTeamsSend, (input) => teams.send(input)),
      teamsSignIn: handler(() => teams.signIn()),
      teamsRetryChannels: handler(() => teams.retryChannels()),
      teamsPolicy: handler(() => teams.policy()),
      teamsSavePolicy: payloadHandler(parseTeamsAgentPolicy, (policy) => teams.savePolicy(policy)),
      teamsCreateAutomation: payloadHandler(parseTeamsAutomation, (input) => teams.createAutomation(input, timezone())),
      teamsStopAutomation: payloadHandler(parseTeamsAutomationId, (id) => teams.stopAutomation(id)),
      // Writes only the TEAMS_PERMITIR_ENVIO pair of the saved Teams server and keeps every other field.
      // The new permissions need a new sign-in, so a saved session is reported to the page.
      teamsSetSendEnabled: payloadHandler(parseSendEnabled, async (enabled) => {
        const signInAgain = await teams.hasSession();
        // Read after the await: a token edited meanwhile must not be written back from an old snapshot.
        const server = savedServer(TEAMS_SERVER_NAME);
        if (!server) throw new Error("The Teams app is not installed.");
        const others = server.env.filter((pair) => pair.key !== TEAMS_SEND_VARIABLE);
        const env = enabled ? [...others, { key: TEAMS_SEND_VARIABLE, value: "sim" }] : others;
        await runCauseEffect(service.saveMcpServer({ config: { ...server, env } }));
        teams.settingsChanged();
        return { sendEnabled: enabled, signInAgain };
      }),
    },
  };
}
