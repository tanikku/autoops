import { describe, expect, it } from "vitest";
import {
  normalizeAnthropicUsage,
  UNKNOWN_AI_USAGE,
  type NormalizedAIUsage,
} from "@/lib/ai/usage";

/**
 * Anthropic's four numbers, renamed.
 *
 * **The mapping is the subject, and one row of it is the reason these exist.**
 * `cache_creation_input_tokens` becomes `cacheWriteTokens`: Anthropic names the
 * tokens after the creating, Koqentra after what they are. Getting that pair
 * the wrong way round would swap the cheapest tokens with the most expensive
 * ones, and nothing downstream could tell.
 *
 * **The other subject is that null is not zero.** A provider reporting no
 * cached reads has said something; a call that reported nothing at all has not.
 * Every assertion below that checks for `null` is checking that a gap was not
 * quietly filled in.
 */

const full = {
  input_tokens: 1_200,
  output_tokens: 340,
  cache_read_input_tokens: 512,
  cache_creation_input_tokens: 64,
};

describe("a call the provider reported in full", () => {
  it("carries every number across unchanged", () => {
    expect(normalizeAnthropicUsage(full)).toEqual({
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 512,
      cacheWriteTokens: 64,
    });
  });

  /**
   * Stated on its own because the two cache fields are the ones a reader is
   * most likely to transpose, and because they cost different amounts.
   */
  it("reads cache creation as a write, not a read", () => {
    const usage = normalizeAnthropicUsage({
      ...full,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 999,
    });

    expect(usage.cacheReadTokens).toBe(1);
    expect(usage.cacheWriteTokens).toBe(999);
  });

  it("keeps a reported zero as zero", () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe("a call that said less than everything", () => {
  /**
   * The ordinary case: a request with no caching reports both cache fields as
   * null, and **null is what is kept**. Zero would claim the cache was consulted
   * and found empty.
   */
  it("keeps a null cache field as null", () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 1_200,
      output_tokens: 340,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });

    expect(usage.cacheReadTokens).toBeNull();
    expect(usage.cacheWriteTokens).toBeNull();
    expect(usage.inputTokens).toBe(1_200);
  });

  /**
   * **The two the SDK types as non-nullable are read through the same guard.**
   * A type is a promise about a shape, and this is the one place where being
   * wrong about it would be written down as a measurement.
   */
  it("does not invent a number for a field that is missing", () => {
    expect(normalizeAnthropicUsage({ output_tokens: 340 })).toEqual({
      inputTokens: null,
      outputTokens: 340,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
  ])("reports nothing at all when the usage is %s", (_label, usage) => {
    expect(normalizeAnthropicUsage(usage)).toEqual(UNKNOWN_AI_USAGE);
  });

  it("is all nulls when nothing is known, and never all zeroes", () => {
    expect(UNKNOWN_AI_USAGE).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });

    expect(UNKNOWN_AI_USAGE).not.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

/**
 * **What leaves is four fields, and only four.** A provider adding a number to
 * its own report should not silently become a number Koqentra stores: that is a
 * decision, and a decision needs a column.
 */
describe("what crosses the boundary", () => {
  it("carries nothing but the four token counts", () => {
    const usage = normalizeAnthropicUsage({
      ...full,
      // Real fields of the deployed SDK's `Usage`, deliberately not mapped.
      service_tier: "standard",
      inference_geo: "us",
      server_tool_use: { web_search_requests: 3 },
      output_tokens_details: { reasoning_tokens: 7 },
    } as never);

    expect(Object.keys(usage)).toEqual([
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ]);
  });

  /** The normalized shape is Koqentra's own, assignable without a cast. */
  it("produces the shape the rest of Koqentra reads", () => {
    const usage: NormalizedAIUsage = normalizeAnthropicUsage(full);

    expect(usage.inputTokens).toBe(1_200);
  });
});
