/** Brand marks for integrations. The file imports only plain paths, so the public site can use it without the shared UI root. */

import {
  DISCORD_MARK_PATH,
  GITHUB_MARK_PATH,
  ONEPASSWORD_MARK_PATH,
  SLACK_MARK_PATH,
  TELEGRAM_MARK_PATH,
} from "@openbot/brand/connector-mark-shape";
import type { JSX } from "@solidjs/web";

/** GitHub's mark. Lucide has no brand icons, so the path is GitHub's own. */
export function GitHubMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={GITHUB_MARK_PATH} />
    </svg>
  );
}

/** Slack's mark, for the same reason. */
export function SlackMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={SLACK_MARK_PATH} />
    </svg>
  );
}

/** Discord's mark, for the same reason. */
export function DiscordMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={DISCORD_MARK_PATH} />
    </svg>
  );
}

/** Telegram's mark, for the same reason. */
export function TelegramMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={TELEGRAM_MARK_PATH} />
    </svg>
  );
}

/** 1Password's mark, for the same reason. */
export function OnePasswordMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={ONEPASSWORD_MARK_PATH} />
    </svg>
  );
}

const X_MARK_PATH =
  "M17.5 3h3.2l-7 8 8.2 10h-6.4l-5-6.5L4.7 21H1.5l7.5-8.5L1.1 3h6.5l4.5 6 5.4-6Zm-1.1 16h1.8L7.6 4.9H5.7L16.4 19Z";

/** The X mark, for the same reason. The public site footer draws the same path. */
export function XMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={X_MARK_PATH} />
    </svg>
  );
}

/**
 * Antigravity's route has no brand mark in the app, so it gets a neutral arch with a base line. It takes
 * its color from `currentColor`, like the provider marks on the settings list.
 */
export function AntigravityMark(props: { class?: JSX.SvgSVGAttributes<SVGSVGElement>["class"] }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20 10.2 5.6c.7-1.6 2.9-1.6 3.6 0L20 20" />
      <path d="M8.5 15.5c2.2-1.6 4.8-1.6 7 0" />
    </svg>
  );
}

/** The Meta infinity loop. One stroke, so the rail draws it in `currentColor` and the store in Meta blue. */
export function MetaMark(props: { class?: string | undefined; colored?: boolean | undefined }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.colored ? "#0866FF" : "currentColor"}
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 12c1.6-2.9 3-5 5-5 2.2 0 3.7 2.4 3.7 5s-1.3 5-3.4 5c-2.2 0-3.7-2.4-5.3-5Zm0 0c-1.6-2.9-3-5-5-5-2.2 0-3.7 2.4-3.7 5s1.3 5 3.4 5c2.2 0 3.7-2.4 5.3-5Z" />
    </svg>
  );
}

/** A Teams-like mark: a chat tile with a T, and a second person behind it. */
export function TeamsMark(props: { class?: string | undefined; colored?: boolean | undefined }) {
  const tile = () => (props.colored ? "#5059C9" : "currentColor");
  const person = () => (props.colored ? "#7B83EB" : "currentColor");
  return (
    <svg class={props.class} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="18" cy="6.5" r="2.5" fill={person()} />
      <path
        d="M15.5 10.5h6a.5.5 0 0 1 .5.5v4.2a3.4 3.4 0 0 1-3.4 3.4h-.1a3.4 3.4 0 0 1-3.4-3.4V11a.5.5 0 0 1 .4-.5Z"
        fill={person()}
      />
      <rect x="2" y="5" width="13.5" height="14" rx="2.2" fill={tile()} />
      <path
        d="M5.2 9.2h7.1M8.75 9.2v6.3"
        stroke={props.colored ? "#fff" : undefined}
        style={props.colored ? undefined : { stroke: "var(--background, #fff)" }}
        stroke-width="1.9"
        stroke-linecap="round"
        fill="none"
      />
    </svg>
  );
}


/** The Cakto card/payment mark. */
export function CaktoMark(props: { class?: string | undefined; colored?: boolean | undefined }) {
  const color = () => (props.colored ? "#00E599" : "currentColor");
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color()}
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <line x1="6" y1="15" x2="10" y2="15" />
    </svg>
  );
}
