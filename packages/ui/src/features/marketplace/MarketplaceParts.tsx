import type { MarketplaceSkillSummary } from "@openbot/contracts/ipc";
import type { MarketplaceListingLink } from "@openbot/contracts/marketplace-links";
import {
  ArrowRight,
  Button,
  Check,
  ErrorReference,
  IconButton,
  Link2,
  Plug,
  Puzzle,
  Skeleton,
  Sparkles,
  Text,
} from "@openbot/ui";
import { ReferenceChip } from "@openbot/ui/reference-chip";
import { SkillGradient } from "@openbot/ui/skill-gradient";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { CONNECTOR_LISTINGS } from "../connectors/connector-catalog";
import { CaktoMark, MetaMark, TeamsMark } from "../settings/brand-marks";
import { LogoTile } from "../settings/IntegrationLayout";
import type { MarketplaceListing } from "./marketplace-listing";
import type { MarketplaceApp, MarketplaceModel } from "./marketplace-model";

/** The part of a page that waits for the full listing: a status line, or the failure with Retry. */
export function DetailState(props: {
  status: "loading" | "loaded" | "failed";
  /** The code of the failed read, when it has one. */
  reference?: string | null | undefined;
  loadingLabel: string;
  onRetry: () => void;
  children: JSX.Element;
}) {
  const { t } = useText();
  return (
    <Switch>
      <Match when={props.status === "loading"}>
        <Text as="p" variant="body-sm" tone="muted" role="status">
          {props.loadingLabel}
        </Text>
      </Match>
      <Match when={props.status === "failed"}>
        <div class="marketplace-empty" role="alert">
          <Text as="p" variant="body-sm" tone="muted">
            {t("marketplace.loadFailed")}
          </Text>
          <ErrorReference reference={props.reference} />
          <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
            {t("common.retry")}
          </Button>
        </div>
      </Match>
      <Match when={props.status === "loaded"}>{props.children}</Match>
    </Switch>
  );
}

/** Copies the public page of a listing, as an app page copies its plugin's. */
export function CopyListingLink(props: { model: MarketplaceModel; link: MarketplaceListingLink }) {
  const { t } = useText();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => props.model.copyListingLink(props.link)}>
      <Link2 aria-hidden="true" />
      {t("plugin.copyLink")}
    </Button>
  );
}

/** A link named a listing that the Marketplace does not have. The list opens with this notice on top. */
export function MissingNotice(props: { children: string }) {
  return (
    <div class="marketplace-empty" role="alert">
      <Text as="p" variant="body-sm" tone="muted">
        {props.children}
      </Text>
    </div>
  );
}

/** A state that has no action: "Added", "Connected". */
export function Done(props: { children: JSX.Element }) {
  return (
    <span class="marketplace-done">
      <Check aria-hidden="true" />
      {props.children}
    </span>
  );
}

export function MenuCheck(props: { on: boolean }) {
  return (
    <span class="ui-menu-check" data-checked={props.on ? "" : undefined}>
      <Show when={props.on}>
        <Check aria-hidden="true" />
      </Show>
    </span>
  );
}

/** A skill's own icon, or a spark when it has none or the icon does not load. "row" is the tile of a list row. */
export function SkillMark(props: { skill: Pick<MarketplaceSkillSummary, "iconUrl">; size: "sm" | "row" | "md" }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const url = () => (props.skill.iconUrl && props.skill.iconUrl !== failed() ? props.skill.iconUrl : null);
  return (
    <span class="marketplace-skill-mark" data-size={props.size} data-kind={url() ? "icon" : "none"} aria-hidden="true">
      <SkillIcon url={url()} onError={setFailed} />
    </span>
  );
}

/** A skill's icon, or the sparkles when it has none or the icon does not load. */
export function SkillIcon(props: { url: string | null | undefined; onError?: (url: string) => void }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const url = () => (props.url && props.url !== failed() ? props.url : null);
  return (
    <Show when={url()} fallback={<Sparkles />} keyed>
      {(src) => (
        <img
          src={src}
          alt=""
          onError={() => {
            setFailed(src);
            props.onError?.(src);
          }}
        />
      )}
    </Show>
  );
}

/** The mark of an app, without its tile. */
const WHATSAPP_SLUGS: ReadonlySet<string> = new Set(["whatscat", "whatsapp-oficial"]);
const WHATSAPP_PATH =
  "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z";

export function AppMark(props: { app: MarketplaceApp }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const url = () => {
    const app = props.app;
    const icon = app.kind === "plugin" ? app.plugin.iconUrl : null;
    return icon && icon !== failed() ? icon : null;
  };
  return (
    <Switch fallback={<Puzzle aria-hidden="true" />}>
      <Match when={props.app.kind === "connector" ? CONNECTOR_LISTINGS[props.app.connector] : undefined} keyed>
        {(listing) => <listing.Mark />}
      </Match>
      <Match when={props.app.kind === "plugin" && WHATSAPP_SLUGS.has(props.app.plugin.slug)}>
        <svg viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
          <path d={WHATSAPP_PATH} />
        </svg>
      </Match>
      <Match when={props.app.kind === "plugin" && props.app.plugin.slug === "meta-ads"}>
        <MetaMark colored />
      </Match>
      <Match when={props.app.kind === "plugin" && props.app.plugin.slug === "teams"}>
        <TeamsMark colored />
      </Match>
      <Match when={props.app.kind === "plugin" && props.app.plugin.slug === "cakto"}>
        <CaktoMark colored />
      </Match>
      <Match when={url()} keyed>
        {(src) => <img src={src} alt="" onError={() => setFailed(src)} />}
      </Match>
      <Match when={props.app.kind === "custom"}>
        <Plug aria-hidden="true" />
      </Match>
    </Switch>
  );
}

/** The mark of an app, on its tile. */
export function AppLogo(props: { app: MarketplaceApp; size?: "md" | "lg" }) {
  return (
    <LogoTile size={props.size ?? "md"}>
      <AppMark app={props.app} />
    </LogoTile>
  );
}

/**
 * Example requests on the listing's gradient, each with a Try arrow. The caption says why the arrows
 * are off.
 */
export function TryCard(props: {
  seed: string;
  chip: { kind: "agent" | "skill" | "plugin"; name: string; icon: JSX.Element };
  requests: readonly { id: string; text: string }[];
  tryLabel: (request: string) => string;
  onTry?: ((id: string) => void) | undefined;
  caption?: string | undefined;
}) {
  return (
    <div class="marketplace-try">
      <div class="skill-preview-card marketplace-try-card">
        <SkillGradient name={props.seed} />
        <For each={props.requests}>
          {(request) => (
            <div class="skill-preview-request">
              <p>
                <ReferenceChip
                  kind={props.chip.kind}
                  name={props.chip.name}
                  icon={props.chip.icon}
                  class="skill-preview-chip"
                />{" "}
                {request.text}
              </p>
              <IconButton
                label={props.tryLabel(request.text)}
                size="icon-lg"
                variant="ghost"
                disabled={!props.onTry}
                onClick={() => props.onTry?.(request.id)}
              >
                <ArrowRight />
              </IconButton>
            </div>
          )}
        </For>
      </div>
      <Show when={props.caption}>
        {(caption) => (
          <Text as="p" variant="body-sm" tone="muted">
            {caption()}
          </Text>
        )}
      </Show>
    </div>
  );
}

/** A listing's first load, its failure, its rows, and "Load more" while the server has more. */
export function ListingPanel(props: {
  listing: MarketplaceListing<unknown>;
  loadingLabel: string;
  count: number;
  /** False: no "Load more", as on the Skills tab, where each group has its own page. */
  paged?: boolean;
  empty: JSX.Element;
  children: JSX.Element;
}) {
  const { t } = useText();
  const failure = () => (
    <div class="marketplace-empty" role="alert">
      <Text as="p" variant="body-sm" tone="muted">
        {props.listing.error()}
      </Text>
      <Button type="button" variant="outline" size="sm" onClick={props.listing.retry}>
        {t("common.retry")}
      </Button>
    </div>
  );
  return (
    <Show
      when={!props.listing.loading()}
      fallback={
        <div class="marketplace-grid" role="status" aria-label={props.loadingLabel}>
          <For each={Array.from({ length: 6 }, (_, index) => index)}>
            {() => (
              <div class="marketplace-card marketplace-card-skeleton" aria-hidden="true">
                <Skeleton class="marketplace-skeleton-mark" />
                <Skeleton class="marketplace-skeleton-line" />
                <Skeleton class="marketplace-skeleton-line" />
              </div>
            )}
          </For>
        </div>
      }
    >
      {/* A failed "Load more" keeps the rows that loaded. */}
      <Show when={!props.listing.error() || props.count > 0} fallback={failure()}>
        <div class="marketplace-stack">
          <Show when={props.count > 0 || props.listing.pending()} fallback={props.empty}>
            {props.children}
          </Show>
          <Show when={!props.listing.error()} fallback={failure()}>
            {/* A filter can hide each loaded row while a later page still holds a match. */}
            <Show when={props.paged !== false && props.listing.hasMore()}>
              <Button
                type="button"
                variant="outline"
                class="marketplace-load-more"
                data-cuelume-tap="navigate"
                loading={props.listing.loadingMore()}
                onClick={props.listing.loadMore}
              >
                {t("marketplace.loadMore")}
              </Button>
            </Show>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
