import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { MetaAdsPanel } from "../src/features/app-pages/MetaAdsPanel";
import { createMockAppPages, type MockAppPagesScenario } from "../src/preview/mock-app-pages";

const AGENTS = [
  { id: "agent-1", name: "Analista de anúncios" },
  { id: "agent-2", name: "Atendente" },
];

/** The Meta Ads page with fictional accounts and numbers. The port answers from the preview mock: nothing real is read or changed. */
function MetaAdsStory(props: { scenario?: MockAppPagesScenario; narrow?: boolean }) {
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
      <MetaAdsPanel serverId="local" agents={AGENTS} port={port} onOpenApp={fn()} onOpenTasks={fn()} onBack={fn()} />
    </main>
  );
}

const meta = {
  title: "Apps/Meta Ads page",
  component: MetaAdsStory,
  args: { scenario: "ready", narrow: false },
} satisfies Meta<typeof MetaAdsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Changes on: Pause and Resume show, each behind a confirmation that names the daily cap. */
export const Ready: Story = {};
/** No daily cap: the page only reads and says how to turn changes on. */
export const ReadOnly: Story = { args: { scenario: "read-only" } };
export const Empty: Story = { args: { scenario: "empty" } };
export const NotConnected: Story = { args: { scenario: "not-connected" } };
export const TokenExpired: Story = { args: { scenario: "token-expired" } };
export const Narrow: Story = { args: { narrow: true } };
export const Light: Story = { globals: { colorScheme: "light" } };
export const Dark: Story = { globals: { colorScheme: "dark" } };
