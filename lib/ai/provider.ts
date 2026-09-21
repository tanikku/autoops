import type { NormalizedAIUsage } from "@/lib/ai/usage";

/**
 * Whether a provider actually calls a model.
 *
 * **Asked because one caller must refuse to run without one.** A website worker
 * that finds a change has to send it somewhere real: the stand-in would answer
 * with its fixed sentence, that sentence would be stored as the summary, and
 * the baseline would move past a change nobody ever read. A prompt worker
 * getting a fixed answer is a confusing run; a website worker getting one loses
 * the change.
 *
 * **It is a property of the provider, not a name.** Testing for a particular
 * class would mean revisiting every caller the first time a second real
 * provider exists — the question is "does this reach a model", and that is what
 * this answers.
 */
export type AIProviderMode = "real" | "dummy";

/**
 * What is sent to a model: an instruction, and the material to apply it to.
 *
 * **The split exists because one of the two is not trusted.** A website
 * worker's material is text fetched from somebody else's server, and putting it
 * in the same message as the instruction would mean the model reads both as
 * coming from the same place. Keeping them apart says which is which.
 *
 * Deliberately not a conversation. There is one instruction and one body of
 * material, and a general message list would be a shape nothing here needs.
 */
export type AIExecutionRequest = {
  /** The instruction. Omitted entirely by callers that have none. */
  system?: string;
  /** What the instruction is applied to. */
  user: string;
  /**
   * How long this one call may take.
   *
   * **Every caller in production names one, and they are all different.** A
   * website change is one step of a run that has already fetched a page; a
   * draft is somebody waiting at a form; a prompt worker's request is the whole
   * of its run. Each knows what it has to fit inside, and the provider knows
   * none of it — which is why the number arrives with the request rather than
   * being decided here.
   *
   * Omitted means the provider decides. That fallback is still what an unnamed
   * caller gets, and nothing in production is one.
   */
  timeoutMs?: number;
};

/**
 * Who answered, named rather than inferred.
 *
 * **`dummy` is one of the values, and that is the point.** A caller that has to
 * decide whether a call cost anything should be able to read the answer rather
 * than work it out from a mode, a class name, or the shape of what came back.
 */
export type AIProviderName = "anthropic" | "dummy";

/**
 * What a provider hands back.
 *
 * **It used to be the text alone**, and the text is still the product — every
 * caller reads `text` and stores exactly what it stored before. What is new is
 * the rest: the provider told Koqentra what the call used and Koqentra threw it
 * away, so nobody could say what a worker cost without reading an invoice.
 *
 * **`usage` is null when nothing was asked.** The stand-in reaches no model, so
 * there is no usage to report — and null here is what stops a fabricated answer
 * being written down as a call that happened.
 */
export type AIExecutionResult = {
  /** Exactly what `execute` returned before this type existed. */
  readonly text: string;
  readonly provider: AIProviderName;
  /** The model as the provider names it. */
  readonly model: string;
  /** What the call used, or null when no provider was reached. */
  readonly usage: NormalizedAIUsage | null;
};

export interface AIProvider {
  /** Whether this reaches a model. See `AIProviderMode`. */
  readonly mode: AIProviderMode;
  execute(request: AIExecutionRequest): Promise<AIExecutionResult>;
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
  unauthorized: "Koqentra is not authorized to call the AI provider.",
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
  /**
   * The request that was actually made, when one was.
   *
   * **Null means nothing left the machine**, and the distinction is the whole
   * reason this field exists: a request that was refused before it was sent
   * cost nothing, and recording it as a call would put an invented charge in
   * the ledger. A request that was sent and then failed cost whatever it cost,
   * which is usually unknown — hence a `usage` that is allowed to be null
   * inside an attempt that definitely happened.
   *
   * **It carries no response and no wording.** Provider, model, and four
   * numbers; the failure's own message is already on `message`, and the raw
   * response, headers and stack stay inside the adapter.
   */
  readonly attempt: ProviderAttempt | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options?: { cause?: unknown; attempt?: ProviderAttempt | null },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.kind = kind;
    this.safeMessage = safeMessageFor(kind);
    this.attempt = options?.attempt ?? null;
  }
}

/**
 * A provider request that was genuinely made, and what is known about it.
 *
 * **`usage` may be null while the attempt is real.** A transport failure
 * reports no tokens at all, and a call that reached a model and was refused
 * reports all of them; both were sent, both were billable, and only one can say
 * how much.
 */
export type ProviderAttempt = ProviderCallMetadata;

/**
 * What is known about one real call to a provider: who, which model, and what
 * it used.
 *
 * **The one shape every feature's bookkeeping is built from.** Six things call
 * a model and only three of them go through `AIProvider` — drafting and the two
 * Creator features have their own interfaces, for reasons that have nothing to
 * do with cost. Sharing this much and no more lets all six be recorded the same
 * way without any of them being folded into the others.
 *
 * **It is metadata, not a result.** There is no answer here, no draft, no
 * analysis and no summary; what a call produced belongs to the interface that
 * asked for it.
 */
export type ProviderCallMetadata = {
  readonly provider: AIProviderName;
  readonly model: string;
  readonly usage: NormalizedAIUsage | null;
};

/**
 * What a failure says about the request behind it.
 *
 * Null for anything that is not a `ProviderError`, and for a `ProviderError`
 * raised before a request was sent. **Callers use this to decide whether there
 * is a call to record at all**, rather than guessing from the kind — a
 * `not-configured` refusal and a timeout are both failures, and only one of
 * them cost money.
 */
export function providerAttemptOf(error: unknown): ProviderAttempt | null {
  return error instanceof ProviderError ? error.attempt : null;
}

/** The kind of a failure, for anything that has to describe one. */
export function providerErrorKind(error: unknown): ProviderErrorKind {
  return error instanceof ProviderError ? error.kind : "unknown";
}
