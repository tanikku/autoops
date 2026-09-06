import { describe, expect, it } from "vitest";
import type { CreatorFeedbackContext } from "@/lib/creator/analyzer";
import {
  assertUsableMemory,
  assertUsableMemorySummary,
  assertUsableStoredMemory,
  isUsableStoredMemory,
  creatorMemoryLimits,
  InvalidCreatorMemoryError,
  isInvalidCreatorMemory,
  memorySynthesisRequestSize,
  selectMemorySynthesisBatch,
} from "@/lib/creator/memory";

/**
 * The rules a derived summary is held to, with no provider anywhere near them.
 *
 * **Two of these matter more than the rest.** A summary is refused rather than
 * trimmed, because a cut inference reads exactly like a complete one; and a
 * synthesis batch is always an oldest-first prefix, because the caller names
 * the answers it sent by taking the same prefix of its own list.
 */

function feedback(overrides: Partial<CreatorFeedbackContext> = {}): CreatorFeedbackContext {
  return {
    targetChannel: "x",
    verdict: "recommend",
    decisionReason: "It stands on its own.",
    draftBody: "A short post.",
    action: "approve",
    editedBody: null,
    feedbackReason: null,
    contentTitle: "An earlier piece",
    contentExcerpt: "The opening lines.",
    ...overrides,
  };
}

/** Feedback whose serialized size is roughly `chars`. */
function bulky(chars: number): CreatorFeedbackContext {
  return feedback({ draftBody: "x".repeat(chars) });
}

describe("a summary a provider returned", () => {
  it("is kept when it says something", () => {
    expect(assertUsableMemorySummary("Has usually turned down promotion.")).toBe(
      "Has usually turned down promotion.",
    );
  });

  it("is kept at exactly the ceiling", () => {
    const summary = "x".repeat(creatorMemoryLimits.summary);

    expect(assertUsableMemorySummary(summary)).toBe(summary);
  });

  /**
   * **Refused, never trimmed.** A cut inference reads as a whole one, and every
   * later analysis would treat it as the conclusion that was drawn.
   */
  it("is refused one character past the ceiling", () => {
    expect(() =>
      assertUsableMemorySummary("x".repeat(creatorMemoryLimits.summary + 1)),
    ).toThrow(InvalidCreatorMemoryError);
  });

  /**
   * A model that answered with nothing has not concluded that there is nothing
   * to conclude; it has failed to answer, and storing that would move the
   * watermark past evidence nobody learned from.
   */
  it.each(["", "   ", "\n\t"])("is refused when it is only %o", (summary) => {
    expect(() => assertUsableMemorySummary(summary)).toThrow(
      InvalidCreatorMemoryError,
    );
  });

  it.each([null, undefined, 42, {}, []])("is refused when it is %o", (summary) => {
    expect(() => assertUsableMemorySummary(summary)).toThrow(
      InvalidCreatorMemoryError,
    );
  });

  /** A rule name is a diagnostic; the writing it describes is not. */
  it("names a rule and never the text", () => {
    const secret = "SECRET-SUMMARY-".repeat(1_000);

    const error = (() => {
      try {
        assertUsableMemorySummary(secret);
      } catch (thrown) {
        return thrown as InvalidCreatorMemoryError;
      }
      return null;
    })();

    expect(isInvalidCreatorMemory(error)).toBe(true);
    expect(error?.reason).toBe("summary-too-long");
    expect(error?.message).not.toContain("SECRET-SUMMARY");
  });
});

/**
 * **The stored row is read back, not trusted.** It was written by an earlier
 * run, and a count that is not a whole number describes a state nothing here
 * can reason about.
 */
describe("a stored memory value", () => {
  it("is usable when both halves are", () => {
    expect(() =>
      assertUsableMemory({ summary: "A conclusion.", derivedFromCount: 8 }),
    ).not.toThrow();
  });

  it("is usable with a count of zero", () => {
    expect(() =>
      assertUsableMemory({ summary: "A conclusion.", derivedFromCount: 0 }),
    ).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "is refused when the count is %o",
    (derivedFromCount) => {
      expect(() =>
        assertUsableMemory({ summary: "A conclusion.", derivedFromCount }),
      ).toThrow(InvalidCreatorMemoryError);
    },
  );

  it("is refused when the summary is unusable", () => {
    expect(() =>
      assertUsableMemory({ summary: "   ", derivedFromCount: 3 }),
    ).toThrow(InvalidCreatorMemoryError);
  });
});

/**
 * **One rule, asked by two callers.**
 *
 * The analysis decides whether to send a stored summary to a model; the panel
 * on `/creator/new` decides whether to show somebody the same summary as what
 * the next analysis will be told. A second rule that differed even slightly
 * would let the page describe context the analysis had already refused, which
 * is the one thing that page must never do.
 */
describe("whether a stored summary is this account's memory", () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    summary: "Has usually turned down promotion.",
    derivedFromCount: 3,
    evidenceCount: 3,
    ...overrides,
  });

  it("is usable when the summary reads and the count matches", () => {
    expect(isUsableStoredMemory(stored())).toBe(true);
    expect(() => assertUsableStoredMemory(stored())).not.toThrow();
  });

  it("is not usable when there is none", () => {
    expect(isUsableStoredMemory(null)).toBe(false);
  });

  /**
   * A count and a set of memberships that disagree describe evidence nobody can
   * name. One of the two is wrong and nothing here can tell which, so it is
   * neither sent nor shown — and neither is it quietly corrected.
   */
  it.each([
    ["ahead of the memberships", 3, 2],
    ["behind the memberships", 2, 3],
  ])("is refused when the count is %s", (_name, derivedFromCount, evidenceCount) => {
    const memory = stored({ derivedFromCount, evidenceCount });

    expect(isUsableStoredMemory(memory)).toBe(false);
    expect(() => assertUsableStoredMemory(memory)).toThrow(
      InvalidCreatorMemoryError,
    );
  });

  /**
   * **The columns default to an empty string and a zero.** A row can exist
   * before anything has been incorporated into it, and that row is not a
   * conclusion about anybody.
   */
  it("is refused for a row that stands for nothing yet", () => {
    const seed = stored({ summary: "", derivedFromCount: 0, evidenceCount: 0 });

    expect(isUsableStoredMemory(seed)).toBe(false);
  });

  /** A count of zero is refused even where a summary somehow exists. */
  it("is refused when the count is zero", () => {
    const memory = stored({ derivedFromCount: 0, evidenceCount: 0 });

    expect(isUsableStoredMemory(memory)).toBe(false);
  });

  it.each([
    ["only whitespace", { summary: "   " }],
    ["past the ceiling", { summary: "x".repeat(creatorMemoryLimits.summary + 1) }],
    ["a fractional count", { derivedFromCount: 1.5, evidenceCount: 1.5 }],
    ["a negative count", { derivedFromCount: -1, evidenceCount: -1 }],
  ])("is refused when the summary is %s", (_name, overrides) => {
    expect(isUsableStoredMemory(stored(overrides))).toBe(false);
  });

  it("names a rule and never the writing", () => {
    const error = (() => {
      try {
        assertUsableStoredMemory(
          stored({ summary: "SECRET-SUMMARY", evidenceCount: 2 }),
        );
      } catch (thrown) {
        return thrown as InvalidCreatorMemoryError;
      }
      return null;
    })();

    expect(error?.reason).toBe("count-evidence-mismatch");
    expect(error?.message).not.toContain("SECRET-SUMMARY");
  });
});

/**
 * **A prefix, whole events, and never a gap.**
 *
 * What comes back has to be a prefix of what went in, because that is how the
 * caller works out which answers were sent — it takes the same prefix of the
 * candidates it read and writes one membership per answer. Skipping one to
 * reach a smaller one behind it would put the two lists out of step and record
 * memberships for answers the model never saw.
 */
describe("choosing one synthesis batch", () => {
  it("takes everything when everything fits", () => {
    const candidates = [feedback(), feedback(), feedback()];

    expect(selectMemorySynthesisBatch(null, candidates)).toHaveLength(3);
  });

  it("never takes more than one batch, however much is waiting", () => {
    const candidates = Array.from({ length: 40 }, () => feedback());

    expect(selectMemorySynthesisBatch(null, candidates)).toHaveLength(
      creatorMemoryLimits.synthesisFeedbackItems,
    );
  });

  it("takes exactly one when only one fits", () => {
    const candidates = [feedback(), bulky(creatorMemoryLimits.synthesisRequestChars)];

    expect(selectMemorySynthesisBatch(null, candidates)).toHaveLength(1);
  });

  it("takes the run that fits and stops there", () => {
    const third = Math.floor(creatorMemoryLimits.synthesisRequestChars / 3);
    const candidates = [bulky(third), bulky(third), bulky(third), bulky(third)];

    const batch = selectMemorySynthesisBatch(null, candidates);

    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(candidates.length);
    expect(
      memorySynthesisRequestSize({ previousSummary: null, feedback: batch }),
    ).toBeLessThanOrEqual(creatorMemoryLimits.synthesisRequestChars);
  });

  /**
   * **Nothing, rather than something out of order.** When even the oldest
   * outstanding answer cannot be sent alone, summarising past it would produce
   * a summary claiming to cover it.
   */
  it("takes nothing when the oldest alone is too large", () => {
    const candidates = [
      bulky(creatorMemoryLimits.synthesisRequestChars * 2),
      feedback(),
    ];

    expect(selectMemorySynthesisBatch(null, candidates)).toEqual([]);
  });

  it("keeps the oldest-first order it was given", () => {
    const candidates = [
      feedback({ contentTitle: "FIRST" }),
      feedback({ contentTitle: "SECOND" }),
      feedback({ contentTitle: "THIRD" }),
    ];

    expect(
      selectMemorySynthesisBatch(null, candidates).map((f) => f.contentTitle),
    ).toEqual(["FIRST", "SECOND", "THIRD"]);
  });

  /** Whole events only: nothing is shortened to make it fit. */
  it("shortens no answer to make room", () => {
    const draftBody = "x".repeat(1_000);
    const candidates = [feedback({ draftBody })];

    expect(selectMemorySynthesisBatch(null, candidates)[0].draftBody).toBe(
      draftBody,
    );
  });

  /** The previous summary is part of what is sent, so it is part of the size. */
  it("counts the previous summary against the same bound", () => {
    const half = Math.floor(creatorMemoryLimits.synthesisRequestChars / 2);
    const candidates = [bulky(half), bulky(half)];

    const withoutPrevious = selectMemorySynthesisBatch(null, candidates);
    const withPrevious = selectMemorySynthesisBatch("y".repeat(half), candidates);

    expect(withPrevious.length).toBeLessThan(withoutPrevious.length);
  });

  it("measures the document that is actually sent", () => {
    const request = { previousSummary: "before", feedback: [feedback()] };

    expect(memorySynthesisRequestSize(request)).toBe(
      JSON.stringify(request).length,
    );
  });
});
