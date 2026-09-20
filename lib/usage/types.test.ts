import { describe, expect, it } from "vitest";
import {
  isUsageFeature,
  isUsageKind,
  isUsageOutcome,
  isUsageProvider,
  UNKNOWN_PROVIDER_USAGE,
  usageFeatures,
  usageKinds,
  usageOutcomes,
  usageProviders,
} from "@/lib/usage/types";

/**
 * The words the usage tables are written in.
 *
 * **Strings in the database, narrowed here**, so that adding a kind or a
 * provider is a line of code rather than a migration — the same choice
 * `RoutineKind` and `User.language` already made. What these fix is that the
 * lists are closed, that nothing is accepted by accident, and that the three
 * allowances have not quietly become one.
 */

describe("the allowances a plan counts", () => {
  /**
   * **Three, and they are not interchangeable.** One run can spend more than
   * one of them, and a run that never reaches a model spends none of the third
   * — which is the whole reason they are separate numbers.
   */
  it("names three", () => {
    expect([...usageKinds]).toEqual(["aiProcessing", "manualRun", "discovery"]);
  });

  it.each([...usageKinds])("recognises %o", (kind) => {
    expect(isUsageKind(kind)).toBe(true);
  });

  it.each([
    ["a feature name", "prompt"],
    ["the wrong case", "aiprocessing"],
    ["a plural", "manualRuns"],
    ["nothing", ""],
    ["a number", 1],
    ["absent", undefined],
  ])("refuses %s", (_label, value) => {
    expect(isUsageKind(value)).toBe(false);
  });
});

describe("which part of Koqentra called a model", () => {
  /**
   * **Six, and the last three write no run history at all.** A draft is a form
   * somebody is looking at and a Creator analysis is not a worker; without a
   * name here their cost is invisible, which is exactly what happened the last
   * time somebody tried to work out what a call costs.
   */
  it("names six", () => {
    expect([...usageFeatures]).toEqual([
      "prompt",
      "website",
      "discovery",
      "draft",
      "creator-analysis",
      "creator-memory",
    ]);
  });

  it.each([...usageFeatures])("recognises %o", (feature) => {
    expect(isUsageFeature(feature)).toBe(true);
  });

  /** The three that have no run must stay distinguishable from the three that do. */
  it("keeps the two Creator features apart from each other", () => {
    expect(isUsageFeature("creator")).toBe(false);
    expect(isUsageFeature("creator-analysis")).toBe(true);
    expect(isUsageFeature("creator-memory")).toBe(true);
  });

  it.each([
    ["a usage kind", "aiProcessing"],
    ["a routine kind spelled as a plural", "prompts"],
    ["an underscore instead of a dash", "creator_analysis"],
    ["nothing", ""],
  ])("refuses %s", (_label, value) => {
    expect(isUsageFeature(value)).toBe(false);
  });
});

describe("who was called", () => {
  it("names the one provider there is", () => {
    expect([...usageProviders]).toEqual(["anthropic"]);
  });

  it.each([
    ["a model name", "claude-opus-5"],
    ["the wrong case", "Anthropic"],
    ["one that does not exist here", "openai"],
  ])("refuses %s", (_label, value) => {
    expect(isUsageProvider(value)).toBe(false);
  });
});

describe("how a call ended", () => {
  /**
   * **Two, and neither of them says why.** `ProviderErrorKind` already answers
   * that, in the run history and the logs; for the question of what a call
   * used, every failure is the same failure.
   */
  it("names two", () => {
    expect([...usageOutcomes]).toEqual(["ok", "error"]);
  });

  it.each([
    ["a failure kind", "timeout"],
    ["a refusal", "refused"],
    ["a rate limit", "rate-limited"],
    ["a status", "success"],
  ])("refuses %s", (_label, value) => {
    expect(isUsageOutcome(value)).toBe(false);
  });
});

/**
 * **Null is not zero, and this is the distinction the whole table is built
 * on.** A provider that reports no cached reads has said something; a failed
 * call that reports nothing at all has not. Recording the second as `0` would
 * make a call whose cost is unknown indistinguishable from one that cost
 * nothing, and no later analysis could separate them again.
 */
describe("usage from a call that reported none", () => {
  it("is null in every field, never zero", () => {
    expect(UNKNOWN_PROVIDER_USAGE).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it.each(Object.entries(UNKNOWN_PROVIDER_USAGE))(
    "does not say zero for %s",
    (_field, value) => {
      expect(value).not.toBe(0);
    },
  );
});
