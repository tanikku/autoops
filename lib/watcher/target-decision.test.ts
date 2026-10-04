import { describe, expect, it } from "vitest";
import {
  InvalidWebsiteTargetDecisionError,
  isInvalidWebsiteTargetDecision,
  parseWebsiteTargetDecision,
  validateWebsiteTargetDecision,
} from "@/lib/watcher/target-decision";

/**
 * Reading the model's decision about a change.
 *
 * **Exactly two keys or nothing.** Every shape that is not the document asked
 * for is refused, so a run never acts on half an answer — it fails, the change
 * stays undealt-with, and the next run asks again.
 */

function refusal(text: string): unknown {
  try {
    parseWebsiteTargetDecision(text);
  } catch (error) {
    return error;
  }

  throw new Error("expected the answer to be refused");
}

describe("an answer that is the decision", () => {
  it("reads a change to tell", () => {
    expect(
      parseWebsiteTargetDecision('{"notify": true, "summary": "Rooms opened for May 2."}'),
    ).toEqual({ notify: true, summary: "Rooms opened for May 2." });
  });

  it("reads a change not to tell", () => {
    expect(
      parseWebsiteTargetDecision('{"notify": false, "summary": "Only May 3 changed."}'),
    ).toEqual({ notify: false, summary: "Only May 3 changed." });
  });

  it("trims the summary", () => {
    expect(
      parseWebsiteTargetDecision('{"notify": true, "summary": "  Rooms opened.  "}').summary,
    ).toBe("Rooms opened.");
  });

  it("accepts surrounding whitespace, which is still the whole document", () => {
    expect(
      parseWebsiteTargetDecision('\n {"notify": false, "summary": "No."} \n').notify,
    ).toBe(false);
  });
});

describe("an answer that is not", () => {
  it.each([
    ["notify missing", '{"summary": "Rooms opened."}'],
    ["notify as a string", '{"notify": "true", "summary": "Rooms opened."}'],
    ["summary missing", '{"notify": true}'],
    ["summary empty", '{"notify": true, "summary": ""}'],
    ["summary only whitespace", '{"notify": true, "summary": "   \\n "}'],
    ["summary not a string", '{"notify": true, "summary": 3}'],
    ["an extra key", '{"notify": true, "summary": "Rooms opened.", "reason": "x"}'],
    ["an array", '[{"notify": true, "summary": "Rooms opened."}]'],
    ["null", "null"],
    ["a code fence", '```json\n{"notify": true, "summary": "Rooms opened."}\n```'],
    ["text before the JSON", 'Here it is: {"notify": true, "summary": "Rooms opened."}'],
    ["text after the JSON", '{"notify": true, "summary": "Rooms opened."} Hope that helps.'],
    ["malformed JSON", '{"notify": true, "summary": "Rooms opened."'],
    ["a bare sentence", "Rooms opened for May 2."],
  ])("refuses %s", (_label, text) => {
    const error = refusal(text);

    expect(error).toBeInstanceOf(InvalidWebsiteTargetDecisionError);
    expect(isInvalidWebsiteTargetDecision(error)).toBe(true);
  });

  /** What was wrong is said; what the model wrote is not. */
  it("names the problem without quoting the answer", () => {
    const error = refusal('{"notify": "yes", "summary": "SECRET-PAGE-TEXT"}') as Error;

    expect(error.message).not.toContain("SECRET-PAGE-TEXT");
  });
});

describe("validating a value already parsed", () => {
  it("refuses a primitive", () => {
    expect(() => validateWebsiteTargetDecision(true)).toThrow(InvalidWebsiteTargetDecisionError);
  });

  it("accepts the two keys in either order", () => {
    expect(validateWebsiteTargetDecision({ summary: "x", notify: false })).toEqual({
      notify: false,
      summary: "x",
    });
  });
});
