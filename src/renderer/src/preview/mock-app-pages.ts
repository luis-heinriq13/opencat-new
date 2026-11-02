import type {
  MetaAdsDay,
  MetaAdsOverview,
  MetaAdsRow,
  OpenBotDesktopApi,
  TeamsAutomation,
  TeamsChat,
  TeamsMessage,
  TeamsOverview,
  TeamsPolicy,
} from "@openbot/contracts/ipc";

/** What the preview and the stories show. The data is fictional: no real account, person or message. */
export type MockAppPagesScenario =
  | "ready"
  | "read-only"
  | "empty"
  | "not-connected"
  | "token-expired"
  | "signing-in"
  | "channels-blocked";

const DAY = 86_400_000;

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

const ACCOUNTS = [
  { id: "act_1000001", name: "Loja Aurora", currency: "BRL", active: true },
  { id: "act_1000002", name: "Café Horizonte", currency: "BRL", active: true },
  { id: "act_1000003", name: "Estúdio Norte (USD)", currency: "USD", active: false },
];

const CAMPAIGN_NAMES = [
  "Vendas - Coleção de verão",
  "Remarketing 30 dias",
  "Lançamento do kit",
  "Tráfego para o blog",
  "Público parecido - compradores",
  "Black Friday antecipada",
  "Cadastro de leads",
  "Reconhecimento da marca",
];

function metaRows(): MetaAdsRow[] {
  return CAMPAIGN_NAMES.map((name, index) => {
    const account = ACCOUNTS[index % 3] ?? ACCOUNTS[0];
    const spend = Math.round((180 + noise(index + 1) * 2400) * 100) / 100;
    const clicks = Math.round(spend * (1.4 + noise(index + 9)));
    const purchases = index % 4 === 3 ? 0 : Math.round(spend / (35 + noise(index + 4) * 40));
    return {
      id: `${2000 + index}000`,
      name,
      accountId: account?.id ?? "act_1000001",
      status: index === 1 || index === 5 ? "paused" : index === 6 ? "issue" : index === 7 ? "ended" : "active",
      spend,
      impressions: clicks * (38 + Math.round(noise(index + 3) * 30)),
      clicks,
      purchases,
      revenue: purchases === 0 ? null : Math.round(purchases * (90 + noise(index + 6) * 160) * 100) / 100,
    };
  });
}

function metaDays(now: number): MetaAdsDay[] {
  return ACCOUNTS.flatMap((account, accountIndex) =>
    Array.from({ length: 14 }, (_, offset) => {
      const spend = Math.round((60 + noise(offset * 3 + accountIndex) * 260) * 100) / 100;
      return {
        date: new Date(now - (13 - offset) * DAY).toISOString().slice(0, 10),
        accountId: account.id,
        spend,
        revenue: accountIndex === 2 ? null : Math.round(spend * (1.2 + noise(offset + 20) * 2.4) * 100) / 100,
      };
    }),
  );
}

function metaOverview(scenario: MockAppPagesScenario, now: number): MetaAdsOverview {
  if (scenario === "not-connected") return { state: "not-connected" };
  if (scenario === "token-expired") return { state: "token-expired" };
  const empty = scenario === "empty";
  return {
    state: "ready",
    fetchedAt: now,
    range: "last_14d",
    accounts: empty ? ACCOUNTS.slice(0, 1) : ACCOUNTS,
    campaigns: empty ? [] : metaRows(),
    daily: empty ? [] : metaDays(now),
    changes: { enabled: scenario === "ready", dailyCap: scenario === "ready" ? 150 : null },
    truncated: false,
    failedAccounts: scenario === "ready" ? [{ id: "act_1000003", name: "Estúdio Norte (USD)" }] : [],
  };
}

function teamsChats(now: number): TeamsChat[] {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    {
      id: "19:demo-1@unq.gbl.spaces",
      kind: "oneOnOne",
      title: "Marina Alves",
      preview: "Pode me mandar o relatório até as 17h?",
      lastActivity: at(6),
    },
    {
      id: "19:demo-2@thread.v2",
      kind: "group",
      title: "Projeto Horizonte",
      preview: "Ana: reunião de alinhamento amanhã às 10h",
      lastActivity: at(95),
    },
    {
      id: "19:demo-3@thread.v2",
      kind: "group",
      title: "Suporte - plantão",
      preview: "Chamado 1042 foi encerrado.",
      lastActivity: at(1500),
    },
    {
      id: "19:demo-4@unq.gbl.spaces",
      kind: "oneOnOne",
      title: "Rafael Costa",
      preview: "Obrigado!",
      lastActivity: at(3200),
    },
    {
      id: "19:demo-5@thread.v2",
      kind: "meeting",
      title: "Revisão semanal",
      preview: "Gravação disponível",
      lastActivity: at(7000),
    },
  ];
}

function teamsMessages(chatId: string, now: number): TeamsMessage[] {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    { id: `${chatId}-1`, from: "Marina Alves", at: at(40), text: "Oi! Tudo bem? Viu o orçamento novo?", system: false },
    { id: `${chatId}-2`, from: "Você", at: at(32), text: "Vi sim. Ajusto hoje e te aviso.", system: false },
    { id: `${chatId}-3`, from: "", at: at(20), text: "Rafael entrou na conversa.", system: true },
    {
      id: `${chatId}-4`,
      from: "Marina Alves",
      at: at(6),
      text: "Pode me mandar o relatório até as 17h?\n<b>texto com marcação</b> aparece como texto simples.",
      system: false,
    },
  ];
}

function mockChannels(scenario: MockAppPagesScenario): TeamsOverview["channels"] {
  const adminConsentUrl = "https://login.microsoftonline.com/organizations/adminconsent?client_id=00000000-demo";
  if (scenario === "channels-blocked") return { state: "blocked", adminConsentUrl, teams: [] };
  return {
    state: "ready",
    adminConsentUrl,
    teams: [
      {
        id: "team-1",
        name: "Operação",
        channels: [
          { id: "19:geral@thread.tacv2", name: "Geral" },
          { id: "19:alertas@thread.tacv2", name: "Alertas" },
        ],
      },
    ],
  };
}

function teamsOverview(scenario: MockAppPagesScenario, sendEnabled: boolean, now: number): TeamsOverview {
  const base = {
    sendEnabled,
    sendLimitPerHour: 20,
    signIn: null,
    signInFailed: false,
    account: null,
    chats: [],
    failure: null,
    channels: mockChannels(scenario),
  };
  if (scenario === "not-connected") return { ...base, connection: "not-connected" };
  if (scenario === "signing-in") {
    return {
      ...base,
      connection: "not-connected",
      signIn: { uri: "https://microsoft.com/devicelogin", code: "B7XQ4K2PD", expiresAt: now + 900_000 },
    };
  }
  if (scenario === "token-expired") return { ...base, connection: "session-expired" };
  return { ...base, connection: "ready", account: "Luiza Demo", chats: scenario === "empty" ? [] : teamsChats(now) };
}

export function createMockAppPages(scenario: MockAppPagesScenario = "ready"): OpenBotDesktopApi["appPages"] {
  const now = Date.now();
  let sendEnabled = scenario === "ready";
  let policy: TeamsPolicy = {
    agents: [
      {
        agentId: "agent-1",
        level: "reply",
        targets: [{ type: "channel", teamId: "team-1", channelId: "19:alertas@thread.tacv2" }],
        instruction: "Avise o time quando a fila passar de 20 chamados. Seja breve.",
      },
    ],
    automations: [
      {
        id: "a0",
        agentId: "agent-1",
        target: { type: "channel", teamId: "team-1", channelId: "19:alertas@thread.tacv2" },
        label: "Operação / Alertas",
        instruction: "Resuma o que chegar e avise se a fila passar de 20.",
        routineId: "demo",
        frequencyMinutes: 15,
        createdAt: new Date(now).toISOString(),
      },
    ],
  };
  return {
    metaOverview: async (query) => {
      const overview = metaOverview(scenario, now);
      return overview.state === "ready" ? { ...overview, range: query.range } : overview;
    },
    metaChildren: async (query) => {
      const seed = Number(query.parentId.slice(0, 4));
      const rows: MetaAdsRow[] = Array.from({ length: query.level === "adset" ? 3 : 4 }, (_, index) => {
        const spend = Math.round((40 + noise(seed + index) * 500) * 100) / 100;
        const clicks = Math.round(spend * 1.6);
        const purchases = Math.round(spend / 55);
        return {
          id: `${query.parentId}${index + 1}`,
          name: `${query.level === "adset" ? "Conjunto" : "Anúncio"} ${index + 1}`,
          accountId: query.accountId,
          status: index === 2 ? "paused" : "active",
          spend,
          impressions: clicks * 40,
          clicks,
          purchases,
          revenue: purchases === 0 ? null : purchases * 120,
        };
      });
      return { state: "ready", rows };
    },
    metaChange: async () => ({ ok: true }),
    teamsOverview: async () => teamsOverview(scenario, sendEnabled, now),
    teamsMessages: async (target) => ({
      state: "ready",
      messages: teamsMessages(target.type === "chat" ? target.chatId : target.channelId, now),
    }),
    teamsSend: async () => (sendEnabled ? { ok: true } : { ok: false, reason: "disabled", detail: "" }),
    teamsRetryChannels: async () => teamsOverview(scenario, sendEnabled, now),
    teamsPolicy: async () => policy,
    teamsSavePolicy: async (agent) => {
      policy = { ...policy, agents: [...policy.agents.filter((entry) => entry.agentId !== agent.agentId), agent] };
      return policy;
    },
    teamsCreateAutomation: async (input) => {
      const automation: TeamsAutomation = {
        id: `a${policy.automations.length + 1}`,
        routineId: "demo",
        createdAt: new Date(now).toISOString(),
        ...input,
      };
      policy = { ...policy, automations: [...policy.automations, automation] };
      return policy;
    },
    teamsStopAutomation: async (id) => {
      policy = { ...policy, automations: policy.automations.filter((entry) => entry.id !== id) };
      return policy;
    },
    teamsSignIn: async () => teamsOverview("signing-in", sendEnabled, now),
    teamsSetSendEnabled: async (enabled) => {
      sendEnabled = enabled;
      return { sendEnabled, signInAgain: scenario === "ready" };
    },
  };
}
