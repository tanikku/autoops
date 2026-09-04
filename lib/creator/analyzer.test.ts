import { describe, expect, it } from "vitest";
import {
  assertCreatorAnalysisRequestWithinLimits,
  type CreatorAnalysisRequest,
  creatorAnalysisLimits,
  creatorAnalysisSchema,
  creatorDraftLimits,
  isCreatorAnalysisRequestTooLarge,
  isInvalidCreatorAnalysisResponse,
  readCreatorAnalysis,
} from "@/lib/creator/analyzer";
import { creatorTargetChannels, editorialVerdicts } from "@/types";

/**
 * The contract on its own, with no provider anywhere near it.
 *
 * `lib/creator/claude-creator-analyzer.test.ts` checks the same rules through a
 * mocked client, which is where they actually apply. These reach the reader and
 * the limits directly, because both are ordinary functions and are cheaper to
 * pin down here — and because a rule that only exists inside one provider is a
 * rule the next provider would not inherit.
 */

const request = (
  overrides: Partial<CreatorAnalysisRequest> = {},
): CreatorAnalysisRequest => ({
  profile: { audience: "a", goals: "g", voiceInstructions: "v" },
  content: { sourceKind: "text", sourceUrl: null, title: null, body: "b" },
  feedback: [],
  ...overrides,
});

describe("the schema the model is held to", () => {
  /**
   * **The channel list has one home.** Reading it from `creatorTargetChannels`
   * means adding a channel is a change in `types/index.ts` and nowhere else;
   * a schema with its own hand-written list would drift silently.
   */
  it("requires exactly the channels the application knows", () => {
    expect(creatorAnalysisSchema.required).toEqual([...creatorTargetChannels]);
    expect(Object.keys(creatorAnalysisSchema.properties)).toEqual([
      ...creatorTargetChannels,
    ]);
  });

  it("closes both levels to anything else", () => {
    expect(creatorAnalysisSchema.additionalProperties).toBe(false);

    for (const channel of creatorTargetChannels) {
      const decision = creatorAnalysisSchema.properties[channel] as unknown as {
        additionalProperties: boolean;
        required: readonly string[];
        properties: {
          verdict: { enum: readonly string[] };
          draftBody: { type: readonly string[] };
        };
      };

      expect(decision.additionalProperties).toBe(false);
      expect([...decision.required]).toEqual(["verdict", "reason", "draftBody"]);
      expect([...decision.properties.verdict.enum]).toEqual([
        ...editorialVerdicts,
      ]);
      expect([...decision.properties.draftBody.type]).toEqual([
        "string",
        "null",
      ]);
    }
  });
});

describe("reading an answer", () => {
  const answer = {
    x: { verdict: "recommend", reason: "Stands alone.", draftBody: "A post." },
    reddit: { verdict: "skip", reason: "No community set.", draftBody: null },
    longform: { verdict: "recommend", reason: "Worth the room.", draftBody: "A piece." },
  };

  it("keeps every channel", () => {
    const result = readCreatorAnalysis(answer);

    expect(Object.keys(result)).toEqual([...creatorTargetChannels]);
    expect(result.x.draftBody).toBe("A post.");
    expect(result.reddit.draftBody).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "recommend"],
    ["an array", [answer]],
    ["a number", 3],
  ])("refuses %s", (_name, value) => {
    expect(() => readCreatorAnalysis(value)).toSatisfy(() => {
      try {
        readCreatorAnalysis(value);
        return false;
      } catch (error) {
        return isInvalidCreatorAnalysisResponse(error);
      }
    });
  });

  /**
   * **The pair a schema cannot enforce.** `draftBody: string | null` is
   * satisfied by a recommendation with nothing to publish and by a skip that
   * wrote one anyway; neither is an answer the application can act on.
   */
  it.each([
    ["recommend with no draft", { verdict: "recommend", reason: "Yes.", draftBody: null }],
    ["recommend with a blank draft", { verdict: "recommend", reason: "Yes.", draftBody: "\n " }],
    ["skip with a draft", { verdict: "skip", reason: "No.", draftBody: "A post." }],
    ["a blank reason", { verdict: "skip", reason: "   ", draftBody: null }],
    ["a missing reason", { verdict: "skip", draftBody: null }],
    ["an unknown verdict", { verdict: "later", reason: "Hmm.", draftBody: null }],
    ["a non-string verdict", { verdict: 1, reason: "Hmm.", draftBody: null }],
  ])("refuses %s", (_name, decision) => {
    expect(() => readCreatorAnalysis({ ...answer, x: decision })).toThrow();
  });

  /**
   * **Each channel is judged by its own ceiling.** These are sanity limits, not
   * posting limits — the `x` figure is not 280 and models nothing about how X
   * counts. What they catch is a "concise standalone post" that came back as an
   * essay, which the prompt asks against but cannot prevent.
   */
  it.each([...creatorTargetChannels])(
    "accepts a %s draft of exactly its limit and refuses one more",
    (channel) => {
      const at = (length: number) => ({
        ...answer,
        [channel]: {
          verdict: "recommend",
          reason: "Fine.",
          draftBody: "d".repeat(length),
        },
      });

      expect(
        readCreatorAnalysis(at(creatorDraftLimits[channel]))[channel].draftBody,
      ).toHaveLength(creatorDraftLimits[channel]);

      expect(() => readCreatorAnalysis(at(creatorDraftLimits[channel] + 1))).toThrow();
    },
  );

  it("gives long-form more room than a short post", () => {
    expect(creatorDraftLimits.x).toBeLessThan(creatorDraftLimits.reddit);
    expect(creatorDraftLimits.reddit).toBeLessThan(creatorDraftLimits.longform);
  });

  it("normalises the case and spacing of a verdict", () => {
    const result = readCreatorAnalysis({
      ...answer,
      x: { verdict: "  RECOMMEND\n", reason: "Yes.", draftBody: "A post." },
      reddit: { verdict: "Skip", reason: "No.", draftBody: null },
    });

    expect(result.x.verdict).toBe("recommend");
    expect(result.reddit.verdict).toBe("skip");
  });

  /** Reading is not a place to invent a channel that was not answered. */
  it.each([...creatorTargetChannels])("refuses an answer missing %s", (channel) => {
    const partial: Record<string, unknown> = { ...answer };
    delete partial[channel];

    expect(() => readCreatorAnalysis(partial)).toThrow();
  });
});

describe("what may be sent", () => {
  it("accepts an ordinary request", () => {
    expect(() => assertCreatorAnalysisRequestWithinLimits(request())).not.toThrow();
  });

  it("accepts the largest allowed body", () => {
    expect(() =>
      assertCreatorAnalysisRequestWithinLimits(
        request({
          content: {
            sourceKind: "text",
            sourceUrl: null,
            title: null,
            body: "b".repeat(creatorAnalysisLimits.contentBody),
          },
        }),
      ),
    ).not.toThrow();
  });

  /**
   * **Fail closed rather than trim.** A trimmed body asks the model to judge
   * material nobody wrote, and a trimmed edit changes what somebody's edit
   * actually was — which is the signal the whole history exists to carry.
   */
  it("refuses one character past the limit, naming the field", () => {
    const failure = (() => {
      try {
        assertCreatorAnalysisRequestWithinLimits(
          request({
            content: {
              sourceKind: "text",
              sourceUrl: null,
              title: null,
              body: "b".repeat(creatorAnalysisLimits.contentBody + 1),
            },
          }),
        );
        return null;
      } catch (error) {
        return error as { field: string; message: string };
      }
    })();

    expect(failure).not.toBeNull();
    expect(isCreatorAnalysisRequestTooLarge(failure)).toBe(true);
    expect(failure?.field).toBe("content.body");
  });

  it("counts feedback entries as well as their contents", () => {
    const entry = {
      targetChannel: "x" as const,
      verdict: "skip" as const,
      decisionReason: "No.",
      draftBody: null,
      action: "approve" as const,
      editedBody: null,
      feedbackReason: null,
      contentTitle: "An earlier piece",
      contentExcerpt: "Its opening lines.",
    };

    expect(() =>
      assertCreatorAnalysisRequestWithinLimits(
        request({
          feedback: Array.from(
            { length: creatorAnalysisLimits.feedbackItems },
            () => entry,
          ),
        }),
      ),
    ).not.toThrow();

    expect(() =>
      assertCreatorAnalysisRequestWithinLimits(
        request({
          feedback: Array.from(
            { length: creatorAnalysisLimits.feedbackItems + 1 },
            () => entry,
          ),
        }),
      ),
    ).toThrow();
  });

  it("says which feedback entry was too large", () => {
    const failure = (() => {
      try {
        assertCreatorAnalysisRequestWithinLimits(
          request({
            feedback: [
              {
                targetChannel: "x",
                verdict: "recommend",
                decisionReason: "Fine.",
                draftBody: "original",
                action: "edit",
                editedBody: "e".repeat(
                  creatorAnalysisLimits.feedbackEditedBody + 1,
                ),
                feedbackReason: null,
                contentTitle: "An earlier piece",
                contentExcerpt: "Its opening lines.",
              },
            ],
          }),
        );
        return null;
      } catch (error) {
        return error as { field: string };
      }
    })();

    expect(failure?.field).toBe("feedback[0].editedBody");
  });

  /**
   * **The excerpt is bounded far below the body it comes from.** Twelve past
   * decisions each carrying a full article would bury the piece being judged
   * now, which is the one thing the request is actually about.
   */
  it("holds a past excerpt to its own, much smaller limit", () => {
    const entry = {
      targetChannel: "x" as const,
      verdict: "skip" as const,
      decisionReason: "No.",
      draftBody: null,
      action: "reject" as const,
      editedBody: null,
      feedbackReason: null,
      contentTitle: null,
    };

    expect(creatorAnalysisLimits.feedbackContentExcerpt).toBeLessThan(
      creatorAnalysisLimits.contentBody,
    );

    expect(() =>
      assertCreatorAnalysisRequestWithinLimits(
        request({
          feedback: [
            {
              ...entry,
              contentExcerpt: "e".repeat(
                creatorAnalysisLimits.feedbackContentExcerpt,
              ),
            },
          ],
        }),
      ),
    ).not.toThrow();

    const failure = (() => {
      try {
        assertCreatorAnalysisRequestWithinLimits(
          request({
            feedback: [
              {
                ...entry,
                contentExcerpt: "e".repeat(
                  creatorAnalysisLimits.feedbackContentExcerpt + 1,
                ),
              },
            ],
          }),
        );
        return null;
      } catch (error) {
        return error as { field: string };
      }
    })();

    expect(failure?.field).toBe("feedback[0].contentExcerpt");
  });

  it("ignores absent optional fields rather than measuring them", () => {
    expect(() =>
      assertCreatorAnalysisRequestWithinLimits(
        request({
          content: { sourceKind: "text", sourceUrl: null, title: null, body: "b" },
          feedback: [
            {
              targetChannel: "longform",
              verdict: "skip",
              decisionReason: "No.",
              draftBody: null,
              action: "reject",
              editedBody: null,
              feedbackReason: null,
              contentTitle: null,
              contentExcerpt: "Its opening lines.",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});
