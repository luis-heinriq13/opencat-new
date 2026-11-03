import { Badge, Button, ChevronRight, Dialog, Heading, IconButton, Link2, Monitor, Server, Text, X } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";

/** OpenCat: adds a server with no plans or payment. A server runs here or on the user\x27s own machine. */
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
        <Dialog.Overlay class="join-server-backdrop" data-motion="open">
          <Dialog.Content as="section" class="join-server-dialog free-add-server-dialog t-modal is-open">
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
                  <Button
                    variant="ghost"
                    class="free-add-server-card free-add-server-card-featured"
                    onClick={() => create()()}
                  >
                    <div class="free-add-server-card-icon">
                      <Monitor aria-hidden="true" />
                    </div>
                    <div class="free-add-server-card-body">
                      <div class="free-add-server-card-header">
                        <span class="free-add-server-card-title">{t("server.freeAdd.localTitle")}</span>
                        <Badge variant="new">{t("server.freeAdd.localBadge")}</Badge>
                      </div>
                      <p class="free-add-server-card-desc">{t("server.freeAdd.localDesc")}</p>
                    </div>
                    <div class="free-add-server-card-arrow" aria-hidden="true">
                      <ChevronRight />
                    </div>
                  </Button>
                )}
              </Show>

              <Button variant="ghost" class="free-add-server-card" onClick={() => props.onOpenSelfHostGuide()}>
                <div class="free-add-server-card-icon">
                  <Server aria-hidden="true" />
                </div>
                <div class="free-add-server-card-body">
                  <div class="free-add-server-card-header">
                    <span class="free-add-server-card-title">{t("server.freeAdd.selfHostTitle")}</span>
                  </div>
                  <p class="free-add-server-card-desc">{t("server.freeAdd.selfHostDesc")}</p>
                </div>
                <div class="free-add-server-card-arrow" aria-hidden="true">
                  <ChevronRight />
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
                    <div class="free-add-server-card-arrow" aria-hidden="true">
                      <ChevronRight />
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
