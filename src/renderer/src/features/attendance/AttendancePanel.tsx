import type { AttendancePeriod, AttendanceReport } from "@openbot/contracts/ipc";
import { AttendanceView } from "@openbot/ui/features/attendance/AttendanceView";
import { DEFAULT_MINUTES_PER_REPLY, parseMinutesPerReply } from "@openbot/ui/features/attendance/attendance-format";
import { createEffect, createStore, onSettled } from "solid-js";
import { type AttendancePort, attendancePort } from "./attendance-port";

const MINUTES_STORAGE_KEY = "opencat.attendance.minutesPerReply";
const PERIOD_STORAGE_KEY = "opencat.attendance.period";
/** The metrics file changes while the bridge answers, so the page reads it again now and then. */
const REFRESH_MS = 30_000;

function readMinutes(): number {
  try {
    return parseMinutesPerReply(window.localStorage.getItem(MINUTES_STORAGE_KEY));
  } catch {
    return DEFAULT_MINUTES_PER_REPLY;
  }
}

function readPeriod(): AttendancePeriod {
  try {
    const saved = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return saved === "today" || saved === "30d" ? saved : "7d";
  } catch {
    return "7d";
  }
}

interface AttendanceState {
  report: AttendanceReport | null;
  phase: "loading" | "ready" | "error";
  period: AttendancePeriod;
  minutes: number;
  busy: boolean;
  actionFailed: boolean;
}

/**
 * The Attendance page of the desktop window. Main reads the local metrics file and answers with counts,
 * times and hash labels; this container adds the period, the minutes per reply (saved on this computer)
 * and the Pause and Resume actions, and passes it all to the shared view.
 */
export function AttendancePanel(props: {
  agentName: (agentId: string) => string | null;
  onOpenStore: () => void;
  onBack: () => void;
  /** Tests and stories give their own port. The default is the desktop bridge. */
  port?: AttendancePort;
}) {
  const port = () => props.port ?? attendancePort();
  const [state, setState] = createStore<AttendanceState>({
    report: null,
    phase: "loading",
    period: readPeriod(),
    minutes: readMinutes(),
    busy: false,
    actionFailed: false,
  });
  let generation = 0;

  async function load(period: AttendancePeriod, background = false): Promise<void> {
    const request = ++generation;
    if (!background)
      setState((draft) => {
        draft.phase = "loading";
      });
    try {
      const report = await port().attendance.report(period);
      if (request !== generation) return;
      setState((draft) => {
        draft.report = report;
        draft.phase = "ready";
      });
    } catch {
      // A refresh that fails keeps the last report on screen.
      if (request !== generation || (background && state.report)) return;
      setState((draft) => {
        draft.phase = "error";
      });
    }
  }

  createEffect(
    () => state.period,
    (period) => {
      void load(period);
    },
  );
  onSettled(() => {
    const timer = window.setInterval(() => void load(state.period, true), REFRESH_MS);
    return () => {
      generation++;
      window.clearInterval(timer);
    };
  });

  async function change(action: "pause" | "turn-on"): Promise<void> {
    setState((draft) => {
      draft.busy = true;
      draft.actionFailed = false;
    });
    try {
      await port().appConnections.change({ app: "whatsapp", action });
      await load(state.period, true);
    } catch {
      setState((draft) => {
        draft.actionFailed = true;
      });
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }

  const agentName = () => {
    const agentId = state.report?.connection.agentId;
    return agentId ? props.agentName(agentId) : null;
  };

  return (
    <AttendanceView
      report={state.report}
      phase={state.phase}
      period={state.period}
      onPeriodChange={(period) => {
        try {
          window.localStorage.setItem(PERIOD_STORAGE_KEY, period);
        } catch {
          // Blocked storage keeps the choice for this window only.
        }
        setState((draft) => {
          draft.period = period;
        });
      }}
      agentName={agentName()}
      minutesPerReply={state.minutes}
      onMinutesPerReplyChange={(minutes) => {
        try {
          window.localStorage.setItem(MINUTES_STORAGE_KEY, String(minutes));
        } catch {
          // Blocked storage keeps the value for this window only.
        }
        setState((draft) => {
          draft.minutes = minutes;
        });
      }}
      busy={state.busy}
      actionFailed={state.actionFailed}
      onPause={() => void change("pause")}
      onResume={() => void change("turn-on")}
      onOpenStore={props.onOpenStore}
      onRetry={() => void load(state.period)}
      onBack={props.onBack}
    />
  );
}
