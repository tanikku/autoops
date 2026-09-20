import { describe, expect, it } from "vitest";
import { DummyProvider } from "@/lib/ai/dummy-provider";

/**
 * The stand-in, and the two things a caller has to be able to ask about it.
 *
 * **It answers everything.** That is fine where a fabricated answer is merely
 * confusing, and not fine where it would be stored as a summary of a change
 * nobody read — so it says what it is rather than leaving callers to guess from
 * its class name.
 *
 * **It also reports no usage**, which became a second question the moment calls
 * started being counted. Nothing was sent and nothing was charged, so a row
 * saying otherwise would be an invented cost in the one table whose whole
 * purpose is to say what things really cost.
 */

const provider = new DummyProvider();

describe("the stand-in", () => {
  it("says that it does not reach a model", () => {
    expect(provider.mode).toBe("dummy");
  });

  it("still answers, which is what makes the mode necessary", async () => {
    expect((await provider.execute({ user: "anything" })).text).toBe(
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
      provider.execute({ system: "a task", user: "three" }),
      provider.execute({ user: "two" }),
    ]);

    expect(new Set(answers.map((answer) => answer.text)).size).toBe(1);
  });
});

/**
 * **Nothing here can be mistaken for a purchase.** Both fields are checked
 * rather than one: a caller reading `provider` and a caller reading `usage`
 * should each reach the same conclusion on their own.
 */
describe("what the stand-in says a call cost", () => {
  it("names itself rather than a provider", async () => {
    expect((await provider.execute({ user: "anything" })).provider).toBe("dummy");
  });

  it("reports no usage at all", async () => {
    expect((await provider.execute({ user: "anything" })).usage).toBeNull();
  });

  /**
   * Zeroes would be a claim that a call was made and cost nothing, which is a
   * different and untrue statement.
   */
  it("does not report zeroes", async () => {
    expect((await provider.execute({ user: "anything" })).usage).not.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  /** A name, not a model — nothing was asked of anything. */
  it("does not borrow a real model's name", async () => {
    const { model } = await provider.execute({ user: "anything" });

    expect(model).toBe("stand-in");
    expect(model).not.toContain("claude");
  });
});
