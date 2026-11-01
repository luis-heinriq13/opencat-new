// The attendance report of the WhatsApp (not official) connection. See `../opencat-attendance-metrics.ts`.

import { ATTENDANCE_PERIODS, type AttendancePeriod } from "@openbot/contracts/ipc";
import { isOneOf } from "@openbot/contracts/runtime-values";
import { readAttendanceReport, resumeAttendanceConversation } from "../opencat-attendance-metrics";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface AttendanceIpcDependencies {
  /** The folder of the WhatsApp (not official) data. */
  dataDirectory: () => string;
}

export function parseAttendancePeriod(value: unknown): AttendancePeriod {
  if (!isOneOf(ATTENDANCE_PERIODS, value)) throw new Error("Unknown attendance period.");
  return value;
}

export function parseAttendanceConversation(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{4,8}$/.test(value)) throw new Error("Unknown attendance conversation.");
  return value;
}

export function attendanceIpcHandlers({
  dataDirectory,
}: AttendanceIpcDependencies): Pick<IpcGroupHandlers, "attendance"> {
  return {
    attendance: {
      report: payloadHandler(parseAttendancePeriod, (period) => readAttendanceReport(dataDirectory(), period)),
      resumeConversation: payloadHandler(parseAttendanceConversation, (ref) =>
        resumeAttendanceConversation(dataDirectory(), ref),
      ),
    },
  };
}
