import { describe, expect, it } from "vitest";
import { DummyProvider } from "@/lib/ai/dummy-provider";

/**
 * The stand-in, and the one thing a caller has to be able to ask about it.
 *
 * **It answers everything.** That is fine where a fabricated answer is merely
 * confusing, and not fine where it would be stored as a summary of a change
 * nobody read — so it says what it is rather than leaving callers to guess from
 * its class name.
 */

const provider = new DummyProvider();

describe("the stand-in", () => {
  it("says that it does not reach a model", () => {
    expect(provider.mode).toBe("dummy");
  });

  it("still answers, which is what makes the mode necessary", async () => {
    expect(await provider.execute({ user: "anything" })).toBe(
      "Execution completed successfully.",
    );
  });

  /**
   * Its answer has never depended on what it was asked, and this sprint has not
   * changed that — the fixed sentence is what a prompt worker records when no
   * key is configured.
   */
  it("answers the same thing however it is asked", async () => {
    const answers = await Promise.all([
      provider.execute({ user: "one" }),
      provider.execute({ user: "two" }),
      provider.execute({ system: "a task", user: "three" }),
    ]);

    expect(new Set(answers).size).toBe(1);
  });
});
