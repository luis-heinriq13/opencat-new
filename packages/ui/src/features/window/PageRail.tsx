import { AppLogo, type AppLogoVariant, ProviderLogo } from "@openbot/brand";
import {
  Bot,
  Button,
  CalendarClock,
  ChartArea,
  DropdownMenu,
  Ellipsis,
  ListChecks,
  MotionTooltip,
  Pin,
  Puzzle,
  Settings,
  Store,
  TextAlignJustify,
  Waypoints,
  Workflow,
} from "@openbot/ui";
import { AccountUsageDetails } from "@openbot/ui/features/account/AccountUsageDetails";
import {
  type AccountUsageProviderRow,
  accountUsageRowKey,
  formatUsageResetIn,
} from "@openbot/ui/features/account/account-usage-view";
import { WhatsAppIcon } from "@openbot/ui/features/attendance/WhatsAppIcon";
import { CaktoMark, MetaMark, TeamsMark } from "@openbot/ui/features/settings/brand-marks";
import { useText } from "@openbot/ui/text";
import { Dynamic, type JSX } from "@solidjs/web";
import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

/** One rail button. Its name shows as a tooltip, unless it has a `card`: the card shows instead. */
function RailButton(props: {
  label: string;
  /** The hover name when it differs from `label`, such as the whole name that the open row clips. */
  tooltip?: string | undefined;
  /**
   * The name of the row on an open rail, next to the icon. Absent when the label itself serves.
   * The open rail also reads `copy`, the lines under the name.
   */
  rowLabel?: string | undefined;
  /** The lines under the row name, as the limit windows of a provider. Absent on page rows. */
  copy?: JSX.Element | undefined;
  card?: () => JSX.Element;
  current?: boolean;
  class?: string;
  onClick: (button: HTMLElement) => void;
  children: JSX.Element;
}) {
  const button = () => (
    <Button
      variant="ghost"
      type="button"
      class={props.class ? `window-rail-button ${props.class}` : "window-rail-button"}
      aria-label={props.label}
      aria-current={props.current ? "page" : undefined}
      onClick={(event) => props.onClick(event.currentTarget)}
    >
      {props.children}
      <span class="window-rail-text">
        <span class="window-rail-label">{props.rowLabel ?? props.label}</span>
        <Show when={props.copy}>{(copy) => <span class="window-rail-row-copy">{copy()}</span>}</Show>
      </span>
    </Button>
  );
  return (
    <Show when={props.card} fallback={<MotionTooltip content={props.tooltip ?? props.label}>{button()}</MotionTooltip>}>
      {(card) => (
        <MotionTooltip
          content={card()()}
          class="ui-popover-menu-surface account-usage-popover window-rail-usage-card"
          placement="right-end"
          openDelay={250}
          closeDelay={75}
        >
          {button()}
        </MotionTooltip>
      )}
    </Show>
  );
}

/** Two tracks in a 34px box, with 4.5px between their centers. */
const RING = { size: 34, stroke: 2.25, spacing: 4.5 };

/**
 * The limits of one provider as concentric rings: the outer ring is the longest window, the inner
 * ring the shortest. Each arc shows how much is left, in the tone of that window. The hover card
 * shows the windows with their reset times. `shared` are the readings that count the same quota, such
 * as Cursor on a merged Grok plan: the card lists them, with no ring of their own. The ring draws the
 * reading with the least left, so a shared reading that runs out first still shows.
 */
function UsageRings(props: {
  row: AccountUsageProviderRow;
  shared: readonly AccountUsageProviderRow[];
  /** The open rail shows the name of the account and its limit windows beside the ring. */
  expanded: boolean;
  onOpen: (button: HTMLElement) => void;
}) {
  const { t, format } = useText();
  const rows = () => [props.row, ...props.shared];
  const label = () =>
    t("app.rail.usageRings", {
      name: format.list(rows().map((row) => row.name)),
      windows: rows()
        .flatMap((row) => row.windows)
        .map((window) => t("account.usage.row.window", { window: window.label, percent: window.remainingPercent }))
        .join(", "),
    });
  const ringRow = () =>
    rows().reduce((lowest, row) => ((row.remainingPercent ?? 100) < (lowest.remainingPercent ?? 100) ? row : lowest));
  const windows = () => [...ringRow().ringWindows].reverse().slice(0, 2);
  const outerRadius = (RING.size - RING.stroke) / 2;
  return (
    <RailButton
      label={label()}
      // The account name, "Gemini · conta" for a second account, not the airy sentence of the label.
      rowLabel={props.row.name}
      tooltip={props.expanded ? props.row.name : undefined}
      copy={
        <Show when={props.expanded && props.row.windows.length > 0}>
          <UsageWindowLines windows={props.row.windows} />
        </Show>
      }
      card={() => (
        <AccountUsageDetails
          rows={rows()}
          loading={false}
          error={null}
          refreshActive={false}
          refreshDisabled
          onRefresh={() => undefined}
          title={<h2 class="account-usage-popover-title">{t("account.usage.title")}</h2>}
        />
      )}
      class="window-rail-usage"
      onClick={props.onOpen}
    >
      <svg class="window-rail-usage-ring" viewBox={`0 0 ${RING.size} ${RING.size}`} fill="none" aria-hidden="true">
        <For each={windows()} keyed={false}>
          {(window, index) => (
            <g>
              <circle
                class="window-rail-usage-track"
                cx={RING.size / 2}
                cy={RING.size / 2}
                r={outerRadius - index * RING.spacing}
                stroke-width={RING.stroke}
              />
              <Show when={window().remainingPercent > 0}>
                <circle
                  class="window-rail-usage-arc"
                  data-usage-tone={window().tone}
                  cx={RING.size / 2}
                  cy={RING.size / 2}
                  r={outerRadius - index * RING.spacing}
                  stroke-width={RING.stroke}
                  stroke-linecap="round"
                  pathLength={100}
                  stroke-dasharray={`${window().remainingPercent} 100`}
                />
              </Show>
            </g>
          )}
        </For>
      </svg>
      <ProviderLogo provider={props.row.provider} class="window-rail-usage-logo" />
    </RailButton>
  );
}

/** The reset countdown shows minutes, so a half-minute tick keeps it current. */
const USAGE_LINES_CLOCK_MS = 30_000;

/**
 * One line per limit window of one account, for the open rail: the name of the window, how much is
 * left and the time to renew, the same reading that the usage card shows. No new call to the
 * provider: the rows already carry the readings.
 */
function UsageWindowLines(props: { windows: readonly AccountUsageProviderRow["windows"][number][] }) {
  const text = useText();
  const [now, setNow] = createSignal(Date.now());
  const clock = window.setInterval(() => setNow(Date.now()), USAGE_LINES_CLOCK_MS);
  onCleanup(() => window.clearInterval(clock));
  return (
    <For each={props.windows}>
      {(usageWindow) => {
        const line = () => {
          const left = text.format.percent(usageWindow.remainingPercent / 100);
          const reset = formatUsageResetIn(usageWindow.resetsAt, now(), text);
          return reset
            ? text.t("app.rail.usageWindow", { window: usageWindow.label, percent: left, time: reset })
            : `${usageWindow.label} ${left}`;
        };
        return (
          <span
            class="window-rail-usage-line"
            data-usage-tone={usageWindow.tone}
            title={
              usageWindow.resetsAtLabel
                ? text.t("account.usage.resetsAt", { time: usageWindow.resetsAtLabel })
                : undefined
            }
          >
            {line()}
          </span>
        );
      }}
    </For>
  );
}

/** The answer of one custom agent to its usage prompt. OpenBot cannot read a percent from it. */
export interface CustomAgentUsageRailRow {
  id: string;
  name: string;
  text: string;
}

/**
 * The plan usage of one custom agent: the agent logo, with no ring. The hover card shows the answer
 * as the agent wrote it.
 */
function CustomAgentUsageButton(props: {
  row: CustomAgentUsageRailRow;
  /** The open rail shows the name of the agent and the start of its answer. */
  expanded: boolean;
  onOpen: (button: HTMLElement) => void;
}) {
  const { t } = useText();
  return (
    <RailButton
      label={t("app.rail.customAgentUsage", { name: props.row.name })}
      rowLabel={props.row.name}
      tooltip={props.expanded ? props.row.name : undefined}
      copy={
        <Show when={props.expanded && props.row.text.trim().length > 0}>
          <p class="window-rail-agent-usage-text window-rail-agent-usage-row">{props.row.text}</p>
        </Show>
      }
      card={() => (
        <div class="window-rail-agent-usage">
          <h2 class="account-usage-popover-title">{props.row.name}</h2>
          <p class="window-rail-agent-usage-text">{props.row.text}</p>
        </div>
      )}
      class="window-rail-usage"
      onClick={props.onOpen}
    >
      <ProviderLogo provider="acp" class="window-rail-usage-logo window-rail-agent-usage-logo" />
    </RailButton>
  );
}

/** The rail pages. Agents and Routines show the same page with a different sidebar list. */
export type PageRailPage =
  | "agents"
  | "routines"
  | "workflows"
  | "tasks"
  | "schedule"
  | "attendance"
  | "usage"
  | "marketplace"
  | "settings";

/** The pages that the user can pin to the rail, in rail order. Agents always shows. */
export const PAGE_RAIL_PINNABLE_PAGES = [
  "routines",
  "workflows",
  "tasks",
  "schedule",
  "attendance",
  "usage",
] as const satisfies readonly PageRailPage[];
export type PageRailPinnablePage = (typeof PAGE_RAIL_PINNABLE_PAGES)[number];

/**
 * An installed app that the user pinned to the rail. It has no icon address: the rail draws a mark
 * from the slug, so the rail sends no request to the vendor of an app.
 */
export interface PageRailApp {
  slug: string;
  name: string;
}

/** The WhatsApp apps keep the WhatsApp mark that the attendance page has. Other apps get a plug-in mark. */
const WHATSAPP_APP_SLUGS: ReadonlySet<string> = new Set(["whatscat", "whatsapp-oficial"]);

/** The mark of a pinned app: WhatsApp, Meta Ads and Teams have their own; the others get a plug-in mark. */
function railAppIcon(slug: string): Component<{ class?: string | undefined; "aria-hidden"?: "true" | undefined }> {
  if (WHATSAPP_APP_SLUGS.has(slug)) return WhatsAppIcon;
  if (slug === "meta-ads") return MetaMark;
  if (slug === "teams") return TeamsMark;
  if (slug === "cakto") return CaktoMark;
  return Puzzle;
}

export interface PageRailProps {
  hidden: boolean;
  /** The page in the card, or `null` while a page that the rail does not open shows. */
  current: PageRailPage | null;
  /** The pages that show as rail buttons. The More menu has all pages, with a pin for each one. */
  pinned: readonly PageRailPinnablePage[];
  onPinChange: (page: PageRailPinnablePage, pinned: boolean) => void;
  /** The installed apps that the user pinned, after the pinned pages. Absent where there are no apps. */
  apps?: readonly PageRailApp[] | undefined;
  /** The slug of the app whose page is open, or null. */
  currentApp?: string | null | undefined;
  onOpenApp?: ((slug: string) => void) | undefined;
  /** The plan limits of each provider account. Each one with a reported window shows as rings. */
  usageRows: readonly AccountUsageProviderRow[];
  /** The answers of the custom agents on this computer that have a usage prompt. Absent on the web. */
  customAgentUsage?: readonly CustomAgentUsageRailRow[] | undefined;
  onAgents: () => void;
  /** Absent when the server has no routines. */
  onRoutines?: (() => void) | undefined;
  /** Absent when the server has no workflows. */
  onWorkflows?: (() => void) | undefined;
  /** Absent where the server keeps no tasks. */
  onTasks?: ((button: HTMLElement) => void) | undefined;
  /** Absent where there is no schedule page. */
  onSchedule?: ((button: HTMLElement) => void) | undefined;
  /** Absent where there is no WhatsApp attendance page. */
  onAttendance?: ((button: HTMLElement) => void) | undefined;
  onUsage: (button: HTMLElement) => void;
  /** Absent while Marketplace cannot open. */
  onMarketplace?: (() => void) | undefined;
  onSettings: (button: HTMLElement) => void;
  /** A notice for the Settings button, such as an update, when no other place shows it. A dot marks it. */
  settingsNotice?: string | undefined;
  /**
   * The Help menu, between Marketplace and Settings. It receives whether the rail is open, so its
   * button can show its name beside the icon the way the rows do.
   */
  help: (expanded: boolean) => JSX.Element;
  /**
   * The OpenBot logo in the top row, for a window that has no macOS window buttons there. With
   * `href`, the logo is a link to the OpenBot site.
   */
  logo?: { variant: AppLogoVariant; href?: string | undefined } | undefined;
}

/** A page that the user can pin to the rail. */
interface RailPage {
  id: PageRailPinnablePage;
  label: string;
  icon: Component<{ class?: string | undefined; "aria-hidden"?: "true" | undefined }>;
  open: (button: HTMLElement) => void;
}

/**
 * The More button of the rail. Its menu lists every page that the user can pin. A row opens its page;
 * the pin at the end of the row pins or unpins it, and the menu stays open. When the open page has no
 * rail button, the More button shows as the current page.
 */
function RailMoreMenu(props: {
  pages: readonly RailPage[];
  current: PageRailPage | null;
  pinned: readonly PageRailPinnablePage[];
  onPinChange: (page: PageRailPinnablePage, pinned: boolean) => void;
}) {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLElement | undefined;
  // A pin adds or removes a rail button above More, so the trigger moves. The menu keeps the place
  // where it opened, so the row under the pointer stays the same.
  let anchor: DOMRect | undefined;
  const changeOpen = (next: boolean) => {
    anchor = next ? trigger?.getBoundingClientRect() : undefined;
    setOpen(next);
  };
  const pinned = (page: PageRailPinnablePage) => props.pinned.includes(page);
  const currentInMenu = () => props.pages.some((page) => page.id === props.current && !pinned(page.id));
  return (
    <DropdownMenu.Root
      placement="right-start"
      gutter={10}
      onOpenChange={changeOpen}
      getAnchorRect={(element?: HTMLElement) => anchor ?? element?.getBoundingClientRect()}
    >
      <MotionTooltip content={t("app.rail.more")} suppressed={open()}>
        <DropdownMenu.Trigger
          ref={(element: HTMLElement) => {
            trigger = element;
          }}
          class="window-rail-button"
          aria-label={t("app.rail.more")}
          aria-current={currentInMenu() ? "page" : undefined}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenu.Trigger>
      </MotionTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="agent-context-menu window-rail-more-menu" aria-label={t("app.rail.more")}>
          <For each={props.pages} keyed={(page) => page.id}>
            {(page) => (
              // The pin is its own menu item beside the page, so the keyboard reaches it.
              <div role="none" class="window-rail-more-row" data-pinned={pinned(page().id) ? "" : undefined}>
                <DropdownMenu.Item onSelectAfterClose={() => trigger && page().open(trigger)}>
                  <Dynamic component={page().icon} class="agent-context-icon size-4" aria-hidden="true" />
                  <span>{page().label}</span>
                </DropdownMenu.Item>
                <DropdownMenu.CheckboxItem
                  class="window-rail-more-pin"
                  closeOnSelect={false}
                  checked={pinned(page().id)}
                  onChange={(checked: boolean) => props.onPinChange(page().id, checked)}
                  aria-label={t("app.rail.pinPage", { name: page().label })}
                >
                  <Pin class="agent-context-icon size-4" aria-hidden="true" />
                </DropdownMenu.CheckboxItem>
              </div>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The logo in the top row of the rail, in line with the icons of the rail and the server logo of the sidebar. */
function RailLogo(props: { variant: AppLogoVariant; href: string | undefined }) {
  const { t } = useText();
  return (
    <div class="window-rail-logo">
      <Show when={props.href} fallback={<AppLogo variant={props.variant} />}>
        {(href) => (
          <MotionTooltip content={t("app.rail.website")}>
            <a
              class="window-rail-logo-link"
              href={href()}
              target="_blank"
              rel="noopener"
              aria-label={t("app.rail.website")}
            >
              <AppLogo variant={props.variant} />
            </a>
          </MotionTooltip>
        )}
      </Show>
    </div>
  );
}

/** Whether the rail shows its names and stays with them on this computer. */
const RAIL_EXPANDED_STORAGE_KEY = "openbot:rail-expanded";

function readRailExpanded(): boolean {
  try {
    return window.localStorage.getItem(RAIL_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * A window this narrow lets the open rail no longer take width away from the content: the open rail
 * covers it instead, and closes on a click outside it. The window does not draw the rail at all
 * below `720px`, so the overlay mode bridges up to there.
 */
const RAIL_OVERLAY_QUERY = "(max-width: 1080px)";

function readOverlayMode(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(RAIL_OVERLAY_QUERY).matches;
}

/**
 * The page rail at the left of the window, on desktop and on the web. Its buttons change the page in
 * the card. A usage ring shows the plan limits of one provider and opens the usage page.
 *
 * The three-line button at the head of the icon column opens and closes the rail. Open, it shows a
 * name beside every icon, and a provider's ring shows its windows with the time to renew. The choice
 * stays saved on this computer. On a narrow window it covers the content instead, and closes on a
 * click outside it.
 */
export function PageRail(props: PageRailProps) {
  const { t } = useText();
  // A saved open rail would cover the content of a narrow window on its own, so there it starts closed.
  const [expanded, setExpanded] = createSignal(readRailExpanded() && !readOverlayMode());
  const [overlayMode, setOverlayMode] = createSignal(readOverlayMode());
  const overlayOpen = () => expanded() && overlayMode();
  createEffect(
    () => null,
    () => {
      if (typeof window.matchMedia !== "function") return;
      const query = window.matchMedia(RAIL_OVERLAY_QUERY);
      const update = () => setOverlayMode(query.matches);
      update();
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    },
  );
  const saveExpanded = (next: boolean) => {
    try {
      window.localStorage.setItem(RAIL_EXPANDED_STORAGE_KEY, String(next));
    } catch {
      // The choice stays only for this session where the storage refuses it.
    }
  };
  const toggleRail = () => {
    setExpanded(!expanded());
    saveExpanded(!expanded());
  };
  const collapseRail = () => {
    setExpanded(false);
    saveExpanded(false);
  };
  /* An action on an overlay rail has chosen a page, so the rail leaves the content to it. */
  const closeOverlayAfterAction = () => {
    if (overlayOpen()) collapseRail();
  };
  /* Escape closes an overlay rail, as it closes a dialog. */
  createEffect(
    () => overlayOpen(),
    (open) => {
      if (!open) return;
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") collapseRail();
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    },
  );
  /**
   * One ring per reading, except a reading that counts the quota of another provider's own sign-in,
   * such as Cursor on a merged Grok plan: that ring's card lists it instead.
   */
  const rings = createMemo(() => {
    const rows = props.usageRows.filter((row) => row.reportsUsage && row.windows.length > 0);
    const owner = (row: AccountUsageProviderRow) =>
      rows.find((other) => other.accountId === null && other.provider === row.sharedQuotaWith);
    return rows
      .filter((row) => !owner(row))
      .map((row) => ({ row, shared: rows.filter((other) => owner(other) === row) }));
  });
  /** The pages that this server has, in rail order. */
  const pages = createMemo((): RailPage[] => {
    const list: RailPage[] = [];
    const { onRoutines, onWorkflows, onTasks, onSchedule, onAttendance } = props;
    if (onRoutines) {
      list.push({
        id: "routines",
        label: t("sidebar.view.routines"),
        icon: Workflow,
        open: () => onRoutines(),
      });
    }
    if (onWorkflows) {
      list.push({
        id: "workflows",
        label: t("app.rail.workflows"),
        icon: Waypoints,
        open: () => onWorkflows(),
      });
    }
    if (onTasks) {
      list.push({ id: "tasks", label: t("app.rail.tasks"), icon: ListChecks, open: onTasks });
    }
    if (onSchedule) {
      list.push({
        id: "schedule",
        label: t("app.rail.schedule"),
        icon: CalendarClock,
        open: onSchedule,
      });
    }
    if (onAttendance) {
      list.push({ id: "attendance", label: t("app.rail.attendance"), icon: WhatsAppIcon, open: onAttendance });
    }
    list.push({ id: "usage", label: t("app.rail.usage"), icon: ChartArea, open: props.onUsage });
    return list;
  });
  /** The rows of the page section: every page on an open rail, or the pinned ones on a closed rail. */
  const pageRows = createMemo(() => (expanded() ? pages() : pages().filter((page) => props.pinned.includes(page.id))));
  return (
    <nav
      class="window-rail"
      data-expanded={expanded() ? "" : undefined}
      data-overlay={overlayOpen() ? "" : undefined}
      aria-label={t("app.rail.label")}
      hidden={props.hidden}
    >
      <Show when={overlayOpen()}>
        <div class="window-rail-backdrop" aria-hidden="true" onClick={collapseRail} />
      </Show>
      <Show when={props.logo}>{(logo) => <RailLogo variant={logo().variant} href={logo().href} />}</Show>
      <div class="window-rail-group">
        <MotionTooltip content={expanded() ? t("app.rail.collapse") : t("app.rail.expand")} suppressed={expanded()}>
          <Button
            variant="ghost"
            type="button"
            class="window-rail-button window-rail-toggle"
            aria-label={expanded() ? t("app.rail.collapse") : t("app.rail.expand")}
            aria-expanded={expanded() ? "true" : "false"}
            onClick={toggleRail}
          >
            <TextAlignJustify aria-hidden="true" />
            <span class="window-rail-text">
              <span class="window-rail-label">{t("app.rail.label")}</span>
            </span>
          </Button>
        </MotionTooltip>
        <RailButton
          label={t("app.rail.agents")}
          current={props.current === "agents"}
          onClick={() => {
            closeOverlayAfterAction();
            props.onAgents();
          }}
        >
          <Bot aria-hidden="true" />
        </RailButton>
        <For each={pageRows()} keyed={(page) => page.id}>
          {(page) => (
            <RailButton
              label={page().label}
              current={props.current === page().id}
              onClick={(button) => {
                closeOverlayAfterAction();
                page().open(button);
              }}
            >
              <Dynamic component={page().icon} aria-hidden="true" />
            </RailButton>
          )}
        </For>
        <For each={props.apps ?? []} keyed={(app) => app.slug}>
          {(app) => (
            <RailButton
              label={app().name}
              current={props.currentApp === app().slug}
              onClick={() => {
                closeOverlayAfterAction();
                props.onOpenApp?.(app().slug);
              }}
            >
              <Dynamic component={railAppIcon(app().slug)} aria-hidden="true" />
            </RailButton>
          )}
        </For>
        {/* The open rail names every page, so the More menu of the closed rail has no place here. */}
        <Show when={!expanded()}>
          <RailMoreMenu pages={pages()} current={props.current} pinned={props.pinned} onPinChange={props.onPinChange} />
        </Show>
      </div>
      <div class="window-rail-group">
        <div class="window-rail-usage-scroll">
          {/* A status update builds new rows. The key keeps each ring, and its open hover card, mounted. */}
          <For each={rings()} keyed={(ring) => accountUsageRowKey(ring.row)}>
            {(ring) => (
              <UsageRings
                row={ring().row}
                shared={ring().shared}
                expanded={expanded()}
                onOpen={(button) => {
                  closeOverlayAfterAction();
                  props.onUsage(button);
                }}
              />
            )}
          </For>
          <For each={props.customAgentUsage ?? []} keyed={(row) => row.id}>
            {(row) => (
              <CustomAgentUsageButton
                row={row()}
                expanded={expanded()}
                onOpen={(button) => {
                  closeOverlayAfterAction();
                  props.onUsage(button);
                }}
              />
            )}
          </For>
        </div>
        <Show when={props.onMarketplace}>
          {(onMarketplace) => (
            <RailButton
              label={t("app.rail.marketplace")}
              current={props.current === "marketplace"}
              onClick={() => {
                closeOverlayAfterAction();
                onMarketplace()();
              }}
            >
              <Store aria-hidden="true" />
            </RailButton>
          )}
        </Show>
        {props.help(expanded())}
        <RailButton
          label={
            props.settingsNotice
              ? t("app.rail.settingsNotice", { notice: props.settingsNotice })
              : t("app.rail.settings")
          }
          current={props.current === "settings"}
          onClick={(button) => {
            closeOverlayAfterAction();
            props.onSettings(button);
          }}
        >
          <Settings aria-hidden="true" />
          <Show when={props.settingsNotice}>
            <span class="window-rail-notice" aria-hidden="true" />
          </Show>
        </RailButton>
      </div>
    </nav>
  );
}
