import { Button, Dialog, Heading, IconButton, Link2, Monitor, Text, X } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";

function CloudServerIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 13a4.5 4.5 0 0 1-.5-8.9A7 7 0 0 1 18 6.5a5 5 0 0 1 1.8 9.5" />
      <rect x="7" y="11" width="10" height="3.5" rx="0.75" />
      <rect x="7" y="15.5" width="10" height="3.5" rx="0.75" />
      <rect x="7" y="20" width="10" height="3.5" rx="0.75" />
      <line x1="9.5" y1="12.75" x2="10.5" y2="12.75" />
      <line x1="9.5" y1="17.25" x2="10.5" y2="17.25" />
      <line x1="9.5" y1="21.75" x2="10.5" y2="21.75" />
    </svg>
  );
}

/** OpenCat: adds a server with no plans or payment. A server runs here or on the user's own machine. */
export function FreeAddServerDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreateLocal?: (() => void) | undefined;
  onJoinWithInvite?: (() => void) | undefined;
  onOpenSelfHostGuide: () => void;
}) {
  const { t } = useText();

  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay>
          <Dialog.Content as="section" class="free-add-server-dialog">
            <header class="free-add-server-header">
              <div class="free-add-server-titles">
                <Dialog.Title as={Heading} class="free-add-server-title">
                  {t("server.freeAdd.title")}
                </Dialog.Title>
                <Dialog.Description as={Text} class="free-add-server-description">
                  {t("server.freeAdd.description")}
                </Dialog.Description>
              </div>
              <IconButton
                class="free-add-server-close"
                label={t("common.close")}
                variant="ghost"
                onClick={props.onClose}
              >
                <X aria-hidden="true" />
              </IconButton>
            </header>

            <div class="free-add-server-cards">
              <Show when={props.onCreateLocal}>
                {(create) => (
                  <Button variant="ghost" class="free-add-server-card" onClick={() => create()()}>
                    <div class="free-add-server-card-icon">
                      <Monitor aria-hidden="true" />
                    </div>
                    <div class="free-add-server-card-body">
                      <div class="free-add-server-card-header">
                        <span class="free-add-server-card-title">{t("server.freeAdd.localTitle")}</span>
                        <span class="free-add-server-badge">{t("server.freeAdd.localBadge")}</span>
                      </div>
                      <p class="free-add-server-card-desc">{t("server.freeAdd.localDesc")}</p>
                    </div>
                  </Button>
                )}
              </Show>

              <Button variant="ghost" class="free-add-server-card" onClick={() => props.onOpenSelfHostGuide()}>
                <div class="free-add-server-card-icon">
                  <CloudServerIcon />
                </div>
                <div class="free-add-server-card-body">
                  <div class="free-add-server-card-header">
                    <span class="free-add-server-card-title">{t("server.freeAdd.selfHostTitle")}</span>
                  </div>
                  <p class="free-add-server-card-desc">{t("server.freeAdd.selfHostDesc")}</p>
                </div>
              </Button>

              <Show when={props.onJoinWithInvite}>
                {(join) => (
                  <Button variant="ghost" class="free-add-server-card" onClick={() => join()()}>
                    <div class="free-add-server-card-icon">
                      <Link2 aria-hidden="true" />
                    </div>
                    <div class="free-add-server-card-body">
                      <div class="free-add-server-card-header">
                        <span class="free-add-server-card-title">{t("server.freeAdd.joinTitle")}</span>
                      </div>
                      <p class="free-add-server-card-desc">{t("server.freeAdd.joinDesc")}</p>
                    </div>
                  </Button>
                )}
              </Show>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
