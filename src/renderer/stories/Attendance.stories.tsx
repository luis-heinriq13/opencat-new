import { NO_APP_CONNECTION } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AttendancePanel } from "../src/features/attendance/AttendancePanel";
import { emptyAttendanceReport, MOCK_CONNECTION, mockAttendanceReport } from "../src/preview/mock-attendance";

/** The Attendance page with fictional counts. The port answers from the preview mock, so no real data is read. */
function AttendanceStory(props: { state?: "full" | "empty" | "paused"; narrow?: boolean }) {
  const state = () => props.state ?? "full";
  const now = Date.now();
  const port = {
    attendance: {
      resumeConversation: async () => {},
      report: async (period: "today" | "7d" | "30d") =>
        state() === "empty"
          ? emptyAttendanceReport(period, now)
          : mockAttendanceReport(
              period,
              now,
              state() === "paused" ? { ...MOCK_CONNECTION, reply: "pause" } : MOCK_CONNECTION,
            ),
    },
    appConnections: { change: async () => NO_APP_CONNECTION },
  };
  return (
    <main
      style={{
        width: props.narrow ? "390px" : "100%",
        height: "900px",
        overflow: "hidden",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <AttendancePanel port={port} agentName={() => "Atendente"} onOpenStore={fn()} onBack={fn()} />
    </main>
  );
}

const meta = {
  title: "Agents/Attendance",
  component: AttendanceStory,
  args: { state: "full", narrow: false },
} satisfies Meta<typeof AttendanceStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Full: Story = {};
export const Empty: Story = { args: { state: "empty" } };
export const Paused: Story = { args: { state: "paused" } };
export const Narrow: Story = { args: { narrow: true } };
export const Light: Story = { globals: { colorScheme: "light" } };
export const Dark: Story = { globals: { colorScheme: "dark" } };
