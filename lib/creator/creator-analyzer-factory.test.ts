import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCreatorAnalyzer } from "@/lib/creator/claude-creator-analyzer";
import { createCreatorAnalyzer } from "@/lib/creator/creator-analyzer-factory";

/**
 * What happens on a deployment with no key.
 *
 * **There is no stand-in, and that is the decision worth fixing.**
 * `createAIProvider` falls back to `DummyProvider` because a worker recording a
 * fixed line is visibly a placeholder. An editorial judgement is not: an
 * invented recommendation reads exactly like a real one, and somebody would
 * publish it. Absent beats fabricated, which is what
 * `createWorkerDraftGenerator` already decided.
 */

const original = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (original === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = original;
  }
});

describe("createCreatorAnalyzer", () => {
  it("returns nothing when there is no key", () => {
    expect(createCreatorAnalyzer()).toBeNull();
  });

  /** An empty string is a key nobody set, not a key that happens to be short. */
  it("returns nothing when the key is empty", () => {
    process.env.ANTHROPIC_API_KEY = "";

    expect(createCreatorAnalyzer()).toBeNull();
  });

  it("builds the real analyzer when a key is there", () => {
    process.env.ANTHROPIC_API_KEY = "not-a-real-key";

    expect(createCreatorAnalyzer()).toBeInstanceOf(ClaudeCreatorAnalyzer);
  });

  /**
   * Read per call rather than at import: nothing is built to hold on to, so a
   * deployment that gains the variable starts working on the next request
   * instead of the next restart.
   */
  it("notices a key that arrives later", () => {
    expect(createCreatorAnalyzer()).toBeNull();

    process.env.ANTHROPIC_API_KEY = "not-a-real-key";

    expect(createCreatorAnalyzer()).not.toBeNull();
  });
});
