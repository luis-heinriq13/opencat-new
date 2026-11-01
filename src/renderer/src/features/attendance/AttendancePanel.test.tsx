import { NO_APP_CONNECTION } from "@openbot/contracts/ipc";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { emptyAttendanceReport, MOCK_CONNECTION, mockAttendanceReport } from "../../preview/mock-attendance";
import { AttendancePanel } from "./AttendancePanel";

const NOW = new Date(2026, 5, 15, 14, 30).getTime();

function port(report: (period: "today" | "7d" | "30d") => ReturnType<typeof mockAttendanceReport>) {
  return {
    attendance: { report: vi.fn(async (period: "today" | "7d" | "30d") => report(period)) },
    appConnections: { change: vi.fn(async () => NO_APP_CONNECTION) },
  };
}

describe("AttendancePanel", () => {
  it("shows the hero number, the period and the lists from the report", async () => {
    const attendance = port((period) => mockAttendanceReport(period, NOW));
    render(() => (
      <AttendancePanel port={attendance} agentName={() => "Atendente"} onOpenStore={vi.fn()} onBack={vi.fn()} />
    ));

    expect(await screen.findByRole("heading", { name: /Atendente/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "7 days", pressed: true })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Provider failures" })).toBeTruthy();
    expect(screen.getAllByText("estimate").length).toBeGreaterThan(0);
  });

  it("pauses through the connection and reads the report again", async () => {
    const attendance = port((period) => mockAttendanceReport(period, NOW));
    render(() => (
      <AttendancePanel port={attendance} agentName={() => "Atendente"} onOpenStore={vi.fn()} onBack={vi.fn()} />
    ));
    (await screen.findByRole("button", { name: "Pause" })).click();
    await waitFor(() =>
      expect(attendance.appConnections.change).toHaveBeenCalledWith({ app: "whatsapp", action: "pause" }),
    );
  });

  it("offers Resume while the reply is paused", async () => {
    const attendance = port((period) => mockAttendanceReport(period, NOW, { ...MOCK_CONNECTION, reply: "pause" }));
    render(() => (
      <AttendancePanel port={attendance} agentName={() => "Atendente"} onOpenStore={vi.fn()} onBack={vi.fn()} />
    ));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("invites to the store when there is no data", async () => {
    const onOpenStore = vi.fn();
    const attendance = port((period) => emptyAttendanceReport(period, NOW));
    render(() => (
      <AttendancePanel port={attendance} agentName={() => null} onOpenStore={onOpenStore} onBack={vi.fn()} />
    ));
    (await screen.findByRole("button", { name: "Open the store" })).click();
    expect(onOpenStore).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});
