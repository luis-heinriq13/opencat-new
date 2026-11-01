// Which agent answers for an app on this computer. See `../opencat-app-connections.ts`.

import { changeAppConnection, readAppConnection } from "../opencat-app-connections";
import { parseAppConnectionApp, parseAppConnectionChange } from "./app-connection-inputs";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface AppConnectionIpcDependencies {
  /** The folder of the WhatsApp (not official) data. */
  dataDirectory: () => string;
}

export function appConnectionIpcHandlers({
  dataDirectory,
}: AppConnectionIpcDependencies): Pick<IpcGroupHandlers, "appConnections"> {
  return {
    appConnections: {
      status: payloadHandler(parseAppConnectionApp, () => readAppConnection(dataDirectory())),
      change: payloadHandler(parseAppConnectionChange, (change) => changeAppConnection(dataDirectory(), change)),
    },
  };
}
