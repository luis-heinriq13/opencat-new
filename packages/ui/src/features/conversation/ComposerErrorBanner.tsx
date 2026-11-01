import { Button } from "@openbot/ui";
import { findVerificationLink } from "@openbot/user-errors";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { ComposerNotice } from "./ComposerNotice";

/**
 * The chat-scoped error banner. Every error that names an agent belongs here rather than in a
 * `toast.*`, which stays for global failures that name no agent.
 *
 * Errors are keyed by `composerDraftKey({ agentId, serverId })`, so switching chats shows only the
 * target chat's error and dismissing one never clears another. There is no auto-dismiss: the error
 * stands for its chat until the user closes it or a send succeeds.
 *
 * Sign-in and usage notices have their own components. Dismissing a usage reading does not clear
 * a provider error here. `tone` is `warning` for an error that a model change fixes; it defaults to
 * `danger`. `title` names the provider and model of the run that failed.
 *
 * A Google account verification link in the message (Gemini asks for it) leaves the text and becomes
 * two actions: open it, which `onOpenLink` does through the host's safe external link path, and copy
 * it. Without `onOpenLink` the banner offers only the copy.
 */
export function ComposerErrorBanner(props: {
  message: string;
  title?: string | undefined;
  tone?: "warning" | "danger";
  /** The code of the failure behind the message. */
  reference?: string | null | undefined;
  onShown?: () => void;
  conversationKey?: string | null;
  onDismiss: () => void;
  action?: JSX.Element;
  /** Opens a link in the system browser, through the host's safe external link path. */
  onOpenLink?: ((url: string) => void) | undefined;
}): JSX.Element {
  const { t } = useText();
  const link = () => findVerificationLink(props.message);
  const body = () => {
    const found = link();
    if (!found) return props.message;
    const text = `${props.message.slice(0, found.start)}${props.message.slice(found.end)}`.trim();
    return text.replace(/[\s:]+$/u, "") || props.message;
  };
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    setCopied(true);
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(false), 1_500);
  };
  createEffect(
    () => `${props.conversationKey ?? ""}\u0000${props.message}`,
    () => props.onShown?.(),
  );
  return (
    <ComposerNotice
      tone={props.tone ?? "danger"}
      title={props.title}
      body={body()}
      reference={props.reference}
      conversationKey={props.conversationKey}
      action={
        <>
          <Show when={link()}>
            {(found) => (
              <>
                <Show when={props.onOpenLink}>
                  {(open) => (
                    <Button variant="outline" size="sm" type="button" onClick={() => open()(found().url)}>
                      {t("composer.verifyLink.open")}
                    </Button>
                  )}
                </Show>
                <Button variant="outline" size="sm" type="button" onClick={() => void copy(found().url)}>
                  {copied() ? t("composer.verifyLink.copied") : t("composer.verifyLink.copy")}
                </Button>
              </>
            )}
          </Show>
          {props.action}
        </>
      }
      onDismiss={() => props.onDismiss()}
    />
  );
}
