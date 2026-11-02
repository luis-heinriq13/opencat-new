import type { RevenueOverview } from "@openbot/contracts/ipc";
import { ArrowLeft, Button, RefreshCw } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show, createMemo, createUniqueId } from "solid-js";

export function RevenueView(props: { overview: RevenueOverview | null; refreshing: boolean; onRefresh: () => void; onBack: () => void; onOpenApp: () => void }) {
  const { t, format } = useText();
  const headingId = `app-page-revenue-${createUniqueId()}`;
  const connected = createMemo(() => props.overview?.providers.some((provider) => provider.state === "ready") ?? false);
  const money = (amount: number, currency: string) => {
    try { return format.number(amount, { style: "currency", currency, maximumFractionDigits: 2 }); }
    catch { return `${format.number(amount, { maximumFractionDigits: 2 })} ${currency}`; }
  };
  return (
    <section class="agent-usage app-page" aria-labelledby={headingId}>
      <header class="agent-usage-header">
        <Button variant="ghost" size="icon" aria-label={t("appPages.revenue.back")} onClick={props.onBack}><ArrowLeft /></Button>
        <div><h2 id={headingId}>{t("appPages.revenue.title")}</h2><p>{t("appPages.revenue.subtitle")}</p></div>
        <Button variant="secondary" onClick={props.onRefresh} disabled={props.refreshing}><RefreshCw />{t("appPages.refresh")}</Button>
      </header>
      <div class="agent-usage-body app-page-body">
        <div class="app-page-risk">{t("appPages.revenue.readOnly")}</div>
        <Show when={props.overview} fallback={<p class="app-page-muted">{t("appPages.loading")}</p>}>
          <Show when={connected()} fallback={<div class="app-page-empty"><h3>{t("appPages.revenue.notConnected.title")}</h3><p>{t("appPages.revenue.notConnected.body")}</p><Button onClick={props.onOpenApp}>{t("appPages.revenue.notConnected.action")}</Button></div>}>
            <div class="app-page-kpis">
              <For each={props.overview?.totals ?? []}>{(total) => <>
                <div class="app-page-kpi"><span class="app-page-kpi-label">{t("appPages.revenue.gross")}</span><strong class="app-page-kpi-value">{money(total.gross, total.currency)}</strong></div>
                <div class="app-page-kpi"><span class="app-page-kpi-label">{t("appPages.revenue.sales")}</span><strong class="app-page-kpi-value">{format.number(total.sales)}</strong></div>
                <div class="app-page-kpi"><span class="app-page-kpi-label">{t("appPages.revenue.activeSubscriptions")}</span><strong class="app-page-kpi-value">{format.number(total.activeSubscriptions)}</strong></div>
              </>}</For>
            </div>
            <div class="app-page-card"><h3>{t("appPages.revenue.orders")}</h3><div class="app-page-table-wrap"><table class="app-page-table"><thead><tr><th>{t("appPages.revenue.product")}</th><th>{t("appPages.revenue.provider")}</th><th>{t("appPages.revenue.status")}</th><th>{t("appPages.revenue.amount")}</th></tr></thead><tbody><For each={props.overview?.orders ?? []}>{(order) => <tr><td>{order.product}</td><td>{order.provider}</td><td>{order.status}</td><td>{money(order.amount, order.currency)}</td></tr>}</For></tbody></table></div></div>
          </Show>
        </Show>
      </div>
    </section>
  );
}
