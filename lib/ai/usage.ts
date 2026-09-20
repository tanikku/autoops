/**
 * What a provider says a call used, in words that are not its own.
 *
 * **This is where the SDK's shape stops.** `lib/ai/*` is the only layer that
 * knows which SDK is underneath, and `Anthropic.Usage` escaping it would make
 * every reader of a token count learn that SDK's field names — and learn them
 * again the first time a second provider exists. What leaves here is four
 * numbers and their absence.
 *
 * **Absence is the subject of the whole file.** A provider that reports no
 * cached reads has said something; a call that reports nothing at all has not.
 * Writing the second down as `0` would make a call whose cost is unknown
 * indistinguishable from one that cost nothing, and no later analysis could
 * separate them again — so every field is nullable and nothing is invented.
 */

/** Tokens, as the rest of Koqentra counts them. Null means unknown. */
export type NormalizedAIUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
};

/** Usage from a call that reported none. */
export const UNKNOWN_AI_USAGE: NormalizedAIUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

/**
 * The part of Anthropic's `Usage` this reads.
 *
 * **Structural rather than imported**, which is what keeps the SDK type out of
 * the signature while still accepting the real one: the SDK's `Usage` has these
 * four among its fields, so it satisfies this without anything being cast.
 *
 * The four that are read are the four that are billed. `cache_creation`,
 * `output_tokens_details`, `server_tool_use`, `service_tier` and
 * `inference_geo` are deliberately not among them — none of them is a token
 * count, and a column for each would be a shape to keep in step with a
 * provider's roadmap.
 */
export type AnthropicUsageFields = {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
};

/**
 * A number, or nothing.
 *
 * **Anything that is not a number becomes null**, including `undefined` from a
 * field the deployed SDK does not send. The two that the SDK types as
 * non-nullable are read through here as well: a type is a promise about the
 * shape, and this is the one place where being wrong about it would be recorded
 * as a fact.
 */
function tokenCount(value: number | null | undefined): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Anthropic's usage, renamed.
 *
 * The mapping, stated once so it can be checked against the SDK:
 *
 * | Anthropic | Koqentra |
 * | --- | --- |
 * | `input_tokens` | `inputTokens` |
 * | `output_tokens` | `outputTokens` |
 * | `cache_read_input_tokens` | `cacheReadTokens` |
 * | `cache_creation_input_tokens` | **`cacheWriteTokens`** |
 *
 * **The last row is the one worth reading twice.** Anthropic names the tokens
 * that *created* a cache entry after the creation; Koqentra names them after
 * what they are — a write. Getting this pair the wrong way round would swap the
 * cheapest tokens with the most expensive ones, and nothing downstream could
 * tell.
 */
export function normalizeAnthropicUsage(
  usage: AnthropicUsageFields | null | undefined,
): NormalizedAIUsage {
  if (usage === null || usage === undefined) {
    return UNKNOWN_AI_USAGE;
  }

  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
  };
}
