import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/** What the attendance page reaches in main: the report, and the connection that Pause and Resume change. */
export interface AttendancePort {
  attendance: Pick<OpenBotDesktopApi["attendance"], "report">;
  appConnections: Pick<OpenBotDesktopApi["appConnections"], "change">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function attendancePort(): AttendancePort {
  return window.openbot;
}
