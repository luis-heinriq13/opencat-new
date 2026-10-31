import { Button, Dialog, Heading, Text } from "@openbot/ui";
import { Show } from "solid-js";

/** OpenCat: adds a server with no plans or payment. A server runs here or on the user's own machine. */
export function FreeAddServerDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreateLocal?: (() => void) | undefined;
  onJoinWithInvite?: (() => void) | undefined;
  onOpenSelfHostGuide: () => void;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="join-server-backdrop" data-motion="open">
          <Dialog.Content as="section" class="join-server-dialog t-modal is-open">
            <Dialog.Title class="sr-only">Adicionar servidor</Dialog.Title>
            <Dialog.Description class="sr-only">Crie ou conecte um servidor sem custo.</Dialog.Description>
            <div style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "24px" }}>
              <Heading>Adicionar servidor</Heading>
              <Text>Crie neste computador ou instale no seu próprio servidor, sem plano nem pagamento.</Text>
              <Show when={props.onCreateLocal}>
                {(create) => <Button onClick={() => create()()}>Criar neste computador</Button>}
              </Show>
              <Button variant="outline" onClick={() => props.onOpenSelfHostGuide()}>
                Instalar no meu servidor (guia)
              </Button>
              <Show when={props.onJoinWithInvite}>
                {(join) => (
                  <Button variant="outline" onClick={() => join()()}>
                    Entrar com um convite
                  </Button>
                )}
              </Show>
              <Button variant="ghost" onClick={() => props.onClose()}>
                Cancelar
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
