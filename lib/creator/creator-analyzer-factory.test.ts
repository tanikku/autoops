import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCreatorAnalyzer } from "@/lib/creator/claude-creator-analyzer";
import { ClaudeCreatorMemorySynthesizer } from "@/lib/creator/claude-memory-synthesizer";
import {
  createCreatorAnalyzer,
  createCreatorMemorySynthesizer,
} from "@/lib/creator/creator-analyzer-factory";

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

/**
 * The optional half, asked for separately.
 *
 * **Its absence is not the analyzer's absence.** Without a key neither exists,
 * and it is the analyzer being null that makes Creator unavailable — the
 * summariser being null only means the summary of older answers stays where it
 * was. Asking for them separately is what keeps a deployment that can judge a
 * piece of writing from being stopped by the step that is merely an
 * improvement.
 */
describe("createCreatorMemorySynthesizer", () => {
  it("returns nothing when there is no key", () => {
    expect(createCreatorMemorySynthesizer()).toBeNull();
  });

  it("returns nothing when the key is empty", () => {
    process.env.ANTHROPIC_API_KEY = "";

    expect(createCreatorMemorySynthesizer()).toBeNull();
  });

  it("builds one when there is a key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-not-a-real-key";

    expect(createCreatorMemorySynthesizer()).toBeInstanceOf(
      ClaudeCreatorMemorySynthesizer,
    );
  });

  /** Both read the same variable, so a deployment has both or neither. */
  it("appears and disappears with the analyzer", () => {
    expect(createCreatorAnalyzer()).toBeNull();
    expect(createCreatorMemorySynthesizer()).toBeNull();

    process.env.ANTHROPIC_API_KEY = "sk-not-a-real-key";

    expect(createCreatorAnalyzer()).toBeInstanceOf(ClaudeCreatorAnalyzer);
    expect(createCreatorMemorySynthesizer()).toBeInstanceOf(
      ClaudeCreatorMemorySynthesizer,
    );
  });

  /** Read on each call, so a variable added later works on the next request. */
  it("reads the key each time rather than once", () => {
    expect(createCreatorMemorySynthesizer()).toBeNull();

    process.env.ANTHROPIC_API_KEY = "sk-not-a-real-key";

    expect(createCreatorMemorySynthesizer()).not.toBeNull();
  });
});
