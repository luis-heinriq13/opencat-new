import { AgentAppsDialog } from "@openbot/ui/features/conversation/AgentAppsDialog";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const meta = {
  title: "Conversation/AgentAppsDialog",
  component: AgentAppsDialog,
  args: {
    open: true,
    apps: [{ id: "whatscat", name: "WhatsApp (não oficial)", state: "on" }],
    onOpenChange: fn(),
    onOpenApp: fn(),
    onConnect: fn(),
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof AgentAppsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** WhatsApp answers through this agent. The link opens its store page. */
export const Connected: Story = {};

/** The replies are paused: the agent stays connected and answers no one. */
export const Paused: Story = {
  args: { apps: [{ id: "whatscat", name: "WhatsApp (não oficial)", state: "paused" }] },
};

/** No app answers through this agent. Connect app opens the store. */
export const Empty: Story = { args: { apps: [] } };
