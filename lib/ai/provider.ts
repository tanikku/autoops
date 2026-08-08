export interface AIProvider {
  execute(prompt: string): Promise<string>;
}

/**
 * Why a provider could not produce an answer.
 *
 * **The point of the split is what it implies about trying again.** Today
 * nothing retries — the dispatcher holds no policy and the SDK's own retrying
 * is off — and this does not change that. What it changes is that the run
 * history stops being the only record: until now every failure arrived as one
 * undifferentiated `failed` row, so the argument for a retry policy had no
 * evidence to be built from. A rate limit and a refusal are the same row and
 * the same string.
 *
 * The values are deliberately coarse. A kind exists when it would lead
 * somewhere different — retry later, fix the configuration, fix the prompt —
 * not because the provider distinguishes it.
 */
export type ProviderErrorKind =
  /** The request took longer than the provider is allowed. Worth another slot. */
  | "timeout"
  /** Rate limited. The work is fine; the timing was not. */
  | "rate-limited"
  /** The provider itself failed — a 5xx. Nothing here is wrong. */
  | "unavailable"
  /** The network never reached it. Indistinguishable from the above to a worker. */
  | "unreachable"
  /** The key is missing, wrong, or not allowed to do this. Retrying cannot help. */
  | "unauthorized"
  /** The request was rejected as malformed — too long a prompt, most likely. */
  | "invalid-request"
  /** The model declined to answer. A property of the prompt, not of the run. */
  | "refused"
  /** Everything else, including anything thrown outside the provider. */
  | "unknown";

/**
 * What each kind could be shown as.
 *
 * Written for the owner of the worker, who can act on some of these and not
 * others, and **not** in the provider's vocabulary: nothing here names a
 * status code, a model, or an SDK. The ones a user can actually fix say so;
 * the rest say what happened and leave it there.
 *
 * **These are not what gets stored.** A failed run still records the
 * provider's own message, exactly as it did before — see `ProviderError`.
 */
const safeMessages: Record<ProviderErrorKind, string> = {
  timeout: "The AI provider took too long to respond.",
  "rate-limited": "The AI provider is rate limiting requests right now.",
  unavailable: "The AI provider is temporarily unavailable.",
  unreachable: "The AI provider could not be reached.",
  unauthorized: "AutoOps is not authorized to call the AI provider.",
  "invalid-request":
    "The AI provider rejected this request. The prompt may be too long.",
  refused: "The AI provider declined to answer this prompt.",
  unknown: "Execution failed.",
};

/** The sentence a kind could be reported with. */
export function safeMessageFor(kind: ProviderErrorKind): string {
  return safeMessages[kind];
}

/**
 * A provider failure, named.
 *
 * **This is where the SDK stops.** `lib/ai/*` is the only layer that knows
 * which SDK is underneath, and an `APIError` escaping it would make every
 * caller know too. The classification happens at the boundary and what leaves
 * is an ordinary `Error` that also says what kind of failure it was.
 *
 * **`message` stays the provider's own wording**, unchanged from what the SDK
 * threw. Everything that reads `error.message` today — `runRoutine`, which
 * writes it to `RunHistory.output` — therefore records exactly the string it
 * recorded before this type existed. Naming the failure is an observation, and
 * an observation that rewrote the rows it observed would be worth nothing.
 *
 * `safeMessage` is the wording that could be shown instead. **Nothing reads it
 * yet**, and that is the point: it is here so the sentence exists before
 * anything decides where it belongs — a column, a page, or neither.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** What this failure could be shown as. Derived from `kind`, never stored. */
  readonly safeMessage: string;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.kind = kind;
    this.safeMessage = safeMessageFor(kind);
  }
}

/** The kind of a failure, for anything that has to describe one. */
export function providerErrorKind(error: unknown): ProviderErrorKind {
  return error instanceof ProviderError ? error.kind : "unknown";
}
