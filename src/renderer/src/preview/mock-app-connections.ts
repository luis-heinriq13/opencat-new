import {
  type AppConnectionChange,
  type AppConnectionStatus,
  NO_APP_CONNECTION,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";

/** The preview keeps the connection in memory. It starts with no agent, as a new install does. */
export function createMockAppConnections(): OpenBotDesktopApi["appConnections"] {
  let status: AppConnectionStatus = NO_APP_CONNECTION;
  const apply = (change: AppConnectionChange): AppConnectionStatus => {
    switch (change.action) {
      case "set-agent":
        return { ...status, configured: true, agentId: change.agentId, enabled: true, reply: "auto" };
      case "turn-on":
        return status.agentId === null ? status : { ...status, enabled: true, reply: "auto" };
      case "pause":
        return { ...status, reply: "pause" };
      case "disconnect":
        return { ...status, agentId: null, enabled: false };
    }
  };
  return {
    status: async () => status,
    change: async (change) => {
      status = apply(change);
      return status;
    },
  };
}
