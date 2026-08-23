import { afterEach, describe, expect, it } from "vitest";
import { ClaudeWorkerDraftGenerator } from "@/lib/ai/claude-worker-draft-generator";
import { createWorkerDraftGenerator } from "@/lib/ai/worker-draft-factory";

/**
 * What an unconfigured deployment gets, which is nothing.
 *
 * **The execution factory answers with a stand-in and this one does not**, and
 * the difference is what the two would produce. A stand-in run records a fixed
 * sentence somebody reads and dismisses. A stand-in *draft* would be settings —
 * a name, a schedule, an instruction — filled into a form and saved by somebody
 * with every reason to think a model wrote them. The worker would be real.
 *
 * So there is nothing to test for a fabricated draft: the type says `null`, and
 * the only thing a caller can do with that is say the feature is unavailable.
 */

const original = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (original === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = original;
  }
});

describe("the worker draft generator", () => {
  it("exists when a key is configured", () => {
    process.env.ANTHROPIC_API_KEY = "not-a-real-key";

    expect(createWorkerDraftGenerator()).toBeInstanceOf(
      ClaudeWorkerDraftGenerator,
    );
  });

  it.each(["", undefined])(
    "does not exist when the key is %o",
    (value) => {
      if (value === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = value;
      }

      expect(createWorkerDraftGenerator()).toBeNull();
    },
  );

  /** No stand-in exists to fall back to, which is the point. */
  it("has nothing to fall back to", async () => {
    const factory = await import("@/lib/ai/worker-draft-factory");

    expect(Object.keys(factory)).toEqual(["createWorkerDraftGenerator"]);
  });
});
