import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TeamsPanel } from "../src/features/app-pages/TeamsPanel";
import { createMockAppPages, type MockAppPagesScenario } from "../src/preview/mock-app-pages";

const AGENTS = [
  { id: "agent-1", name: "Assistente de reuniões" },
  { id: "agent-2", name: "Atendente" },
];

/** The Teams page with fictional chats and messages. The port answers from the preview mock: nothing real is read or sent. */
function TeamsStory(props: { scenario?: MockAppPagesScenario; narrow?: boolean }) {
  const port = {
    appPages: createMockAppPages(props.scenario ?? "ready"),
    startTask: async () => ({}),
    openLink: async () => undefined,
    copyText: fn(),
  };
  return (
    <main
      style={{
        width: props.narrow ? "390px" : "100%",
        height: "960px",
        overflow: "hidden",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <TeamsPanel serverId="local" agents={AGENTS} port={port} onOpenTasks={fn()} onBack={fn()} />
    </main>
  );
}

const meta = {
  title: "Apps/Teams page",
  component: TeamsStory,
  args: { scenario: "ready", narrow: false },
} satisfies Meta<typeof TeamsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Sending is on: the box under the messages sends as the owner. */
export const Ready: Story = {};
/** Sending is off: the box is disabled and the settings switch turns it on. */
export const SendOff: Story = { args: { scenario: "read-only" } };
/** The device-code sign-in: the link and the code, with Copy and Open. */
export const SigningIn: Story = { args: { scenario: "signing-in" } };
export const NotConnected: Story = { args: { scenario: "not-connected" } };
export const SessionExpired: Story = { args: { scenario: "token-expired" } };
/** The organization has not approved the channel permissions: chats work, and the channel area names the administrator link. */
export const ChannelsBlocked: Story = { args: { scenario: "channels-blocked" } };
export const NoChats: Story = { args: { scenario: "empty" } };
export const Narrow: Story = { args: { narrow: true } };
export const Light: Story = { globals: { colorScheme: "light" } };
export const Dark: Story = { globals: { colorScheme: "dark" } };
