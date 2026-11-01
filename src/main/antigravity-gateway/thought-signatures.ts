// Gemini returns a thought signature with a tool call and refuses the next step of the loop without
// it. The harness keeps only the OpenAI fields, so the gateway keeps the signature by tool call id.
// In memory and bounded: after a restart, a loop continues with the fallback in `translate.ts`.

const MAX_ENTRIES = 2_048;
const MAX_SIGNATURE_LENGTH = 256 * 1_024;
/** Signatures are base64 text, so their length is their size in bytes. */
const MAX_TOTAL_LENGTH = 32 * 1_024 * 1_024;

export type ModelFamily = "gemini" | "claude" | "other";

interface StoredSignature {
  readonly signature: string;
  readonly family: ModelFamily;
}

export class ThoughtSignatureStore {
  readonly #entries = new Map<string, StoredSignature>();
  #total = 0;

  put(toolCallId: string, signature: string, family: ModelFamily): void {
    if (signature.length > MAX_SIGNATURE_LENGTH) return;
    this.#drop(toolCallId);
    this.#entries.set(toolCallId, { signature, family });
    this.#total += signature.length;
    while (this.#entries.size > MAX_ENTRIES || this.#total > MAX_TOTAL_LENGTH) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#drop(oldest.value);
    }
  }

  #drop(toolCallId: string): void {
    const entry = this.#entries.get(toolCallId);
    if (!entry) return;
    this.#total -= entry.signature.length;
    this.#entries.delete(toolCallId);
  }

  /** A signature of another model family is refused by the model, so it reads as none. */
  get(toolCallId: string, family: ModelFamily): string | null {
    const entry = this.#entries.get(toolCallId);
    return entry?.family === family ? entry.signature : null;
  }
}
