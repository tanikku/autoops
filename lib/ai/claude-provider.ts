import Anthropic from "@anthropic-ai/sdk";
import {
  type AIExecutionRequest,
  type AIProvider,
  type AIProviderMode,
  ProviderError,
  type ProviderErrorKind,
} from "@/lib/ai/provider";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;

/**
 * How long one request may take.
 *
 * The same ten minutes the SDK would have worked out for itself from
 * `MAX_TOKENS`, stated here so it is a decision rather than a default. Shorter
 * would cut off generations that are still going: sixteen thousand tokens can
 * legitimately take minutes.
 *
 * Setting it does mean the SDK stops calculating one, and with it stops
 * refusing token counts too large to finish in ten minutes. Raising
 * `MAX_TOKENS` past roughly 21,000 would need this raised — or the request
 * streamed — rather than being told so.
 */
const TIMEOUT_MS = 600_000;

/**
 * **No retries.** The SDK would otherwise try three times, and nobody chose
 * that: a timed-out generation is billed whether or not it is used, so the
 * default quietly turns one late worker into thirty minutes and three charges.
 *
 * Retrying is a policy, and AutoOps holds none here — the dispatcher does not,
 * and this is not the layer to smuggle one in. A failure is recorded as a
 * `failed` run and the worker comes round again at its next slot, which is the
 * same answer every other kind of failure gets.
 *
 * The cost is that a rate limit or a passing 5xx now fails the run rather than
 * being absorbed. That is visible in the run history, which is where a decision
 * to add a retry policy should come from.
 */
const MAX_RETRIES = 0;

/**
 * Sorts what the SDK throws into the kinds the rest of AutoOps knows about.
 *
 * **Reading `status` rather than matching every error class is deliberate.**
 * The SDK has a class per status and adds more over time; a `switch` on the
 * number covers the ones that do not exist yet and cannot drift out of date.
 * The two connection classes carry no status at all, which is why they are
 * checked first — and the timeout before its parent, since
 * `APIConnectionTimeoutError` extends `APIConnectionError` and the wrong order
 * would silently collapse the two.
 *
 * A `429` is separated from the other 4xx because it is the one client error
 * that says nothing about the request: the same call succeeds later. That
 * distinction is the whole reason this function exists.
 */
function classify(error: unknown): ProviderErrorKind {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "timeout";
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return "unreachable";
  }

  if (!(error instanceof Anthropic.APIError) || error.status === undefined) {
    return "unknown";
  }

  switch (error.status) {
    case 401:
    case 403:
      return "unauthorized";
    case 400:
    case 404:
    case 413:
    case 422:
      return "invalid-request";
    case 429:
      return "rate-limited";
    default:
      return error.status >= 500 ? "unavailable" : "unknown";
  }
}

export class ClaudeProvider implements AIProvider {
  readonly mode: AIProviderMode = "real";

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      timeout: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }

  async execute(request: AIExecutionRequest): Promise<string> {
    let message;

    try {
      message = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // **Absent rather than empty when there is no instruction.** A prompt
        // worker has none, and its request has to reach the model as the one it
        // reached before — a `system` of `undefined` would be a field that was
        // not there previously.
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: [{ role: "user", content: request.user }],
      });
    } catch (error) {
      // Anything that is not an `Error` is rethrown untouched: there is no
      // message to carry forward and nothing to classify, and passing it
      // through unchanged is what keeps `runRoutine`'s own fallback the thing
      // that handles it — exactly as before this wrapping existed.
      if (!(error instanceof Error)) {
        throw error;
      }

      // The SDK's error type goes no further than this line, but **its message
      // does**: `message` is passed through unchanged, so the string a failed
      // run records is the one it would have recorded before. The classified
      // `kind` rides alongside it, and the original stays as `cause`.
      throw new ProviderError(classify(error), error.message, { cause: error });
    }

    // A refusal arrives as a successful response, so it is a separate check
    // rather than a caught error — and it is the one failure here that is
    // about the prompt rather than about the provider.
    //
    // The wording is the one this threw before it had a kind to carry, and it
    // is kept verbatim for the same reason as above.
    if (message.stop_reason === "refusal") {
      throw new ProviderError(
        "refused",
        "Claude declined to answer this prompt.",
      );
    }

    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
}
