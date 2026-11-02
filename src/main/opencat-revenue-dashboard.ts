// Receita: painel local de leitura. Cakto usa o conector local e Stripe é incluído quando o app
// compatível estiver instalado; cada fonte falha de forma independente e nenhum dado de comprador sai daqui.
import { pathToFileURL } from "node:url";
import type {
  RevenueCurrencyTotals,
  RevenueOrderRow,
  RevenueOverview,
  RevenueProviderStatus,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { bundledToolModule } from "./opencat-bundled-tool-path";

export const CAKTO_SERVER_NAME = "cakto";
const CAKTO_MODULE_FILE = "cakto-mcp.mjs";
const CACHE_MS = 90_000;

interface CaktoModuleExports {
  createCaktoTools?: (options: { env: DynamicRecord }) => unknown;
}

export interface CaktoTools {
  hasCredentials: boolean;
  get(path: string, query?: DynamicRecord): Promise<unknown>;
}

interface DashboardDependencies {
  environment: () => Readonly<Record<string, string>> | null;
  loadCaktoTools?: (environment: Readonly<Record<string, string>>) => Promise<CaktoTools | null>;
  now?: () => number;
}

function numberOf(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : 0;
}

function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 300) : fallback;
}

function records(value: unknown): DynamicRecord[] {
  const candidate =
    isDynamicRecord(value) && Array.isArray(value.results)
      ? value.results
      : isDynamicRecord(value) && Array.isArray(value.data)
        ? value.data
        : Array.isArray(value)
          ? value
          : [];
  return candidate.filter(isDynamicRecord);
}

function isCaktoTools(value: unknown): value is CaktoTools {
  return isDynamicRecord(value) && typeof value.get === "function" && typeof value.hasCredentials === "boolean";
}

export async function loadInstalledCaktoTools(
  environment: Readonly<Record<string, string>>,
): Promise<CaktoTools | null> {
  try {
    const loaded: CaktoModuleExports = await import(
      pathToFileURL(bundledToolModule(CAKTO_SERVER_NAME, CAKTO_MODULE_FILE)).href
    );
    if (typeof loaded.createCaktoTools !== "function") return null;
    const tools = loaded.createCaktoTools({ env: { ...environment } });
    return isCaktoTools(tools) ? tools : null;
  } catch {
    return null;
  }
}

function failure(error: unknown): RevenueProviderStatus["detail"] {
  const kind = isDynamicRecord(error) ? error.kind : undefined;
  if (kind === "permission" || kind === "rate") return kind;
  const name = error instanceof Error ? error.name : "";
  return name === "TypeError" || name === "TimeoutError" || name === "AbortError" ? "network" : "unknown";
}

export function createRevenueDashboard({
  environment,
  loadCaktoTools = loadInstalledCaktoTools,
  now = Date.now,
}: DashboardDependencies) {
  let signature = "";
  let tools: CaktoTools | null = null;
  let cached: RevenueOverview | null = null;

  async function currentTools(): Promise<CaktoTools | null> {
    const env = environment();
    if (!env || !(env.CAKTO_CLIENT_ID ?? "").trim() || !(env.CAKTO_CLIENT_SECRET ?? "").trim()) return null;
    const next = JSON.stringify(env);
    if (signature !== next || !tools) {
      signature = next;
      tools = await loadCaktoTools(env);
      cached = null;
    }
    return tools?.hasCredentials ? tools : null;
  }

  async function overview(refresh = false): Promise<RevenueOverview> {
    if (!refresh && cached && now() - cached.fetchedAt < CACHE_MS) return cached;
    const providers: RevenueProviderStatus[] = [];
    const totals: RevenueCurrencyTotals[] = [];
    const orders: RevenueOrderRow[] = [];
    const active = await currentTools();
    if (!active) providers.push({ provider: "cakto", state: "not-connected", detail: null });
    else {
      try {
        const [orderRaw, subscriptionRaw] = await Promise.all([
          active.get("/public_api/orders/", { limit: 100, ordering: "-paidAt" }),
          active.get("/public_api/subscriptions/", { limit: 100 }),
        ]);
        const byCurrency = new Map<string, RevenueCurrencyTotals>();
        for (const raw of records(orderRaw)) {
          const currency = textOf(raw.currency, "BRL").toUpperCase();
          const status = textOf(raw.status);
          const amount = numberOf(raw.amount ?? raw.totalAmount ?? raw.total_amount);
          const total = byCurrency.get(currency) ?? {
            currency,
            gross: 0,
            net: null,
            sales: 0,
            refunds: 0,
            activeSubscriptions: 0,
            cancellations: 0,
            recurring: null,
          };
          if (status === "paid" || status === "approved") {
            total.gross += amount;
            total.sales += 1;
          }
          if (status === "refunded") total.refunds += 1;
          byCurrency.set(currency, total);
          const productCandidate = isDynamicRecord(raw.product) ? raw.product.name : undefined;
          orders.push({
            id: textOf(raw.id, "—"),
            provider: "cakto",
            product: textOf(raw.productName ?? productCandidate, "Produto Cakto"),
            status,
            currency,
            amount,
            occurredAt: textOf(raw.paidAt ?? raw.createdAt) || null,
          });
        }
        for (const raw of records(subscriptionRaw)) {
          const currency = textOf(raw.currency, "BRL").toUpperCase();
          const total = byCurrency.get(currency) ?? {
            currency,
            gross: 0,
            net: null,
            sales: 0,
            refunds: 0,
            activeSubscriptions: 0,
            cancellations: 0,
            recurring: null,
          };
          const status = textOf(raw.status);
          if (status === "active") total.activeSubscriptions += 1;
          if (status === "canceled" || status === "cancelled") total.cancellations += 1;
          byCurrency.set(currency, total);
        }
        totals.push(...byCurrency.values());
        providers.push({ provider: "cakto", state: "ready", detail: null });
      } catch (error) {
        providers.push({ provider: "cakto", state: "error", detail: failure(error) });
      }
    }
    // Stripe remains separate until its own first-party connection exports a safe summary API.
    providers.push({ provider: "stripe", state: "not-connected", detail: null });
    cached = {
      state: "ready",
      fetchedAt: now(),
      providers,
      totals,
      orders: orders.sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "")).slice(0, 100),
    };
    return cached;
  }
  return { overview };
}
