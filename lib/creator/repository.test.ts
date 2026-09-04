import { beforeEach, describe, expect, it, vi } from "vitest";
import { creatorAnalysisLimits } from "@/lib/creator/analyzer";

/**
 * Turning rows into evidence, and a finished analysis into rows.
 *
 * These reach the module with the database replaced, so what they fix is the
 * shape of the queries and the rules applied to what comes back — which is the
 * right boundary for the two things that actually go wrong here: reading the
 * *wrong twelve* rows, and letting a row that describes something impossible
 * become a fact a model is told.
 *
 * **That the transaction is atomic is not something a mock can show.** Rollback
 * is PostgreSQL's, and the same limit `lib/rate-limit.test.ts` records about
 * conditional updates. What is fixed here is that every write goes through one
 * transaction handle rather than the client, which is the part a mistake would
 * live in.
 */

const {
  profileFindUnique,
  profileUpsert,
  feedbackFindMany,
  feedbackCreate,
  decisionFindFirst,
  decisionCreate,
  contentItemCreate,
  draftCreate,
  transaction,
} = vi.hoisted(() => ({
  profileFindUnique: vi.fn(),
  profileUpsert: vi.fn(),
  feedbackFindMany: vi.fn(),
  feedbackCreate: vi.fn(),
  decisionFindFirst: vi.fn(),
  decisionCreate: vi.fn(),
  contentItemCreate: vi.fn(),
  draftCreate: vi.fn(),
  transaction: vi.fn(),
}));

const tx = {
  creatorProfile: { upsert: profileUpsert },
  contentItem: { create: contentItemCreate },
  editorialDecision: { create: decisionCreate },
  contentDraft: { create: draftCreate },
};

const prismaMock = {
  creatorProfile: { findUnique: profileFindUnique, upsert: profileUpsert },
  creatorFeedback: { findMany: feedbackFindMany, create: feedbackCreate },
  editorialDecision: { findFirst: decisionFindFirst, create: decisionCreate },
  contentItem: { create: contentItemCreate },
  contentDraft: { create: draftCreate },
  $transaction: transaction,
};

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const {
  createCreatorFeedback,
  EMPTY_CREATOR_PROFILE,
  excerptForHistory,
  isCreatorFeedbackAlreadyRecorded,
  isInvalidCreatorFeedbackHistory,
  readCreatorProfile,
  readDecisionForFeedback,
  readRecentFeedbackContext,
  saveCreatorAnalysis,
} = await import("@/lib/creator/repository");

const USER = "google-sub-1";
const OTHER = "google-sub-2";

beforeEach(() => {
  for (const mock of [
    profileFindUnique,
    profileUpsert,
    feedbackFindMany,
    feedbackCreate,
    decisionFindFirst,
    decisionCreate,
    contentItemCreate,
    draftCreate,
  ]) {
    mock.mockReset();
  }

  transaction.mockReset().mockImplementation((run: (client: unknown) => unknown) => run(tx));
  profileUpsert.mockResolvedValue({ id: "profile-1" });
  contentItemCreate.mockResolvedValue({ id: "content-1" });
  decisionCreate.mockResolvedValue({ id: "decision-1" });
  draftCreate.mockResolvedValue({ id: "draft-1" });
});

/** One stored answer, with only the parts a test cares about spelled out. */
function storedFeedback(overrides: Record<string, unknown> = {}) {
  const {
    decision: decisionOverrides = {},
    contentItem: contentOverrides = {},
    draft: draftOverride,
    ...rest
  } = overrides as Record<string, never> & {
    decision?: Record<string, unknown>;
    contentItem?: Record<string, unknown>;
    draft?: unknown;
  };

  return {
    id: "feedback-1",
    action: "approve",
    editedBody: null,
    reason: null,
    editorialDecision: {
      id: "decision-1",
      targetChannel: "x",
      verdict: "skip",
      reason: "Too thin on its own.",
      userId: USER,
      draft: draftOverride === undefined ? null : draftOverride,
      contentItem: {
        title: "An earlier piece",
        body: "The body of an earlier piece.",
        userId: USER,
        ...contentOverrides,
      },
      ...decisionOverrides,
    },
    ...rest,
  };
}

describe("reading a profile", () => {
  it("returns what the owner stated", async () => {
    profileFindUnique.mockResolvedValue({
      audience: "Solo founders",
      goals: "Be useful",
      voiceInstructions: "Plain sentences",
    });

    await expect(readCreatorProfile(USER)).resolves.toEqual({
      audience: "Solo founders",
      goals: "Be useful",
      voiceInstructions: "Plain sentences",
    });
  });

  /**
   * Somebody analysing their first piece has never opened a settings screen.
   * Refusing them would make an optional feature a prerequisite.
   */
  it("answers with empty preferences when there is no profile", async () => {
    profileFindUnique.mockResolvedValue(null);

    await expect(readCreatorProfile(USER)).resolves.toEqual(EMPTY_CREATOR_PROFILE);
  });

  /** A read must not be what creates the row — see `saveCreatorAnalysis`. */
  it("creates nothing while reading", async () => {
    profileFindUnique.mockResolvedValue(null);

    await readCreatorProfile(USER);

    expect(profileUpsert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("asks only for its own account", async () => {
    profileFindUnique.mockResolvedValue(null);

    await readCreatorProfile(USER);

    expect(profileFindUnique.mock.calls[0][0].where).toEqual({ userId: USER });
  });
});

describe("reading the history", () => {
  /**
   * **The mistake this query exists to avoid.** `ORDER BY createdAt ASC` with a
   * limit returns the *oldest* twelve, which on any established account is the
   * opposite set to the one wanted. The read is descending; the reversal
   * happens afterwards, in memory.
   */
  it("asks for the newest first and takes twelve", async () => {
    feedbackFindMany.mockResolvedValue([]);

    await readRecentFeedbackContext(USER);

    const query = feedbackFindMany.mock.calls[0][0];

    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(query.take).toBe(creatorAnalysisLimits.feedbackItems);
    expect(query.take).toBe(12);
  });

  /**
   * Two rows written in the same millisecond would otherwise come back in
   * whatever order the planner chose, and "the latest twelve" would differ
   * between two identical requests.
   */
  it("breaks ties in the same direction it sorts", async () => {
    feedbackFindMany.mockResolvedValue([]);

    await readRecentFeedbackContext(USER);

    const [primary, secondary] = feedbackFindMany.mock.calls[0][0].orderBy;

    expect(primary.createdAt).toBe("desc");
    expect(secondary.id).toBe("desc");
  });

  it("hands the analyzer oldest first", async () => {
    feedbackFindMany.mockResolvedValue([
      storedFeedback({ decision: { reason: "NEWEST" } }),
      storedFeedback({ decision: { reason: "MIDDLE" } }),
      storedFeedback({ decision: { reason: "OLDEST" } }),
    ]);

    const history = await readRecentFeedbackContext(USER);

    expect(history.map((entry) => entry.decisionReason)).toEqual([
      "OLDEST",
      "MIDDLE",
      "NEWEST",
    ]);
  });

  /**
   * **Every level, not just the feedback row.** The denormalised `userId`
   * columns are an application invariant: no composite foreign key makes a
   * decision's owner match its content's. One row belonging to somebody else
   * reaching this payload would put another account's unpublished writing in
   * front of a model.
   */
  it("scopes the feedback, the decision and the content to one owner", async () => {
    feedbackFindMany.mockResolvedValue([]);

    await readRecentFeedbackContext(USER);

    expect(feedbackFindMany.mock.calls[0][0].where).toEqual({
      userId: USER,
      editorialDecision: {
        userId: USER,
        contentItem: { userId: USER },
      },
    });
  });

  it.each([
    ["a decision belonging to somebody else", { decision: { userId: OTHER } }],
    ["content belonging to somebody else", { contentItem: { userId: OTHER } }],
    [
      "a draft belonging to somebody else",
      {
        decision: { verdict: "recommend" },
        draft: { body: "A draft.", userId: OTHER },
      },
    ],
  ])("refuses %s even if the query returned it", async (_name, overrides) => {
    feedbackFindMany.mockResolvedValue([storedFeedback(overrides)]);

    await expect(readRecentFeedbackContext(USER)).rejects.toSatisfy(
      isInvalidCreatorFeedbackHistory,
    );
  });

  /**
   * **Narrowed, never coerced.** Turning an unrecognised channel into `x` would
   * invent a fact about what somebody once decided — and the invention would
   * then be learned from.
   */
  it.each([
    ["an unknown channel", { decision: { targetChannel: "mastodon" } }],
    ["an unknown verdict", { decision: { verdict: "maybe" } }],
    ["an unknown action", { action: "undo" }],
    ["an empty decision reason", { decision: { reason: "   " } }],
  ])("stops on %s rather than guessing", async (_name, overrides) => {
    feedbackFindMany.mockResolvedValue([storedFeedback(overrides)]);

    await expect(readRecentFeedbackContext(USER)).rejects.toSatisfy(
      isInvalidCreatorFeedbackHistory,
    );
  });

  /** Combinations that describe something which cannot have happened. */
  it.each([
    [
      "a recommendation with no draft",
      { decision: { verdict: "recommend" }, draft: null },
    ],
    [
      "a skip that carries a draft",
      { decision: { verdict: "skip" }, draft: { body: "A draft.", userId: USER } },
    ],
    [
      "an edit of a skip",
      { action: "edit", editedBody: "Rewritten.", decision: { verdict: "skip" } },
    ],
    [
      "an edit with nothing edited",
      {
        action: "edit",
        editedBody: "   ",
        decision: { verdict: "recommend" },
        draft: { body: "A draft.", userId: USER },
      },
    ],
    [
      "an approval carrying edited text",
      { action: "approve", editedBody: "Rewritten." },
    ],
    [
      "a rejection carrying edited text",
      { action: "reject", editedBody: "Rewritten." },
    ],
  ])("stops on %s", async (_name, overrides) => {
    feedbackFindMany.mockResolvedValue([storedFeedback(overrides)]);

    await expect(readRecentFeedbackContext(USER)).rejects.toSatisfy(
      isInvalidCreatorFeedbackHistory,
    );
  });

  it("names no private text when it refuses", async () => {
    feedbackFindMany.mockResolvedValue([
      storedFeedback({
        decision: { targetChannel: "mastodon" },
        contentItem: { body: "SECRET UNPUBLISHED BODY" },
      }),
    ]);

    const failure = await readRecentFeedbackContext(USER).catch((error) => error);

    expect(failure.message).not.toContain("SECRET UNPUBLISHED BODY");
    expect(failure.decisionId).toBe("decision-1");
  });

  /** The whole reason grounding fields exist: a skip has no draft to read. */
  it("carries what a rejected skip was about", async () => {
    feedbackFindMany.mockResolvedValue([
      storedFeedback({
        action: "reject",
        reason: "  This was worth posting.  ",
        decision: { targetChannel: "reddit", verdict: "skip" },
        contentItem: { title: "The skipped piece", body: "Its opening lines." },
      }),
    ]);

    const [entry] = await readRecentFeedbackContext(USER);

    expect(entry).toEqual({
      targetChannel: "reddit",
      verdict: "skip",
      decisionReason: "Too thin on its own.",
      draftBody: null,
      action: "reject",
      editedBody: null,
      feedbackReason: "This was worth posting.",
      contentTitle: "The skipped piece",
      contentExcerpt: "Its opening lines.",
    });
  });

  it("keeps both halves of an edit", async () => {
    feedbackFindMany.mockResolvedValue([
      storedFeedback({
        action: "edit",
        editedBody: "EDITED",
        decision: { verdict: "recommend" },
        draft: { body: "ORIGINAL", userId: USER },
      }),
    ]);

    const [entry] = await readRecentFeedbackContext(USER);

    expect(entry.draftBody).toBe("ORIGINAL");
    expect(entry.editedBody).toBe("EDITED");
  });

  it("reads a whitespace-only reason as nothing said", async () => {
    feedbackFindMany.mockResolvedValue([storedFeedback({ reason: "   " })]);

    const [entry] = await readRecentFeedbackContext(USER);

    expect(entry.feedbackReason).toBeNull();
  });
});

/**
 * **Not the truncation the analyzer refuses to do.** That rule protects the
 * piece being judged now, where cutting changes what the model was asked about.
 * This is a past item being quoted to explain an earlier decision.
 */
describe("shortening past material", () => {
  it("leaves anything within the limit alone", () => {
    expect(excerptForHistory("  Short enough.  ", 100)).toBe("Short enough.");
  });

  it("never exceeds the limit, ellipsis included", () => {
    for (const limit of [4, 10, 50, creatorAnalysisLimits.feedbackContentExcerpt]) {
      expect(excerptForHistory("x".repeat(limit * 3), limit).length).toBeLessThanOrEqual(
        limit,
      );
    }
  });

  it("says that something was left off", () => {
    expect(excerptForHistory("x".repeat(50), 10).endsWith("…")).toBe(true);
  });

  /** The same body always produces the same excerpt — no model, no randomness. */
  it("is deterministic", () => {
    const body = "The same paragraph, ".repeat(50);

    expect(excerptForHistory(body, 80)).toBe(excerptForHistory(body, 80));
  });

  /**
   * Cutting between the halves of a surrogate pair leaves half a character
   * behind, which is a mojibake bug waiting for its first emoji.
   */
  it("does not cut a character in half", () => {
    const excerpt = excerptForHistory("😀".repeat(40), 11);

    expect(excerpt.length).toBeLessThanOrEqual(11);
    expect(Array.from(excerpt).every((point) => point === "😀" || point === "…")).toBe(
      true,
    );
  });

  /**
   * **The metric has to be the one that gets checked later.**
   *
   * `creatorAnalysisLimits` is enforced with `String.length`, which counts
   * UTF-16 code units; an emoji is one code point and two of those. A budget
   * spent per code point would let `"😀".repeat(1_500)` out of here at a
   * reported 1,500 and have `assertCreatorAnalysisRequestWithinLimits` reject
   * it at 3,000 — an excerpt this layer built being the thing that fails the
   * request. These pin the unit rather than the character.
   */
  describe("measured the way the limit is measured", () => {
    const lengths = (text: string, limit: number) => {
      const excerpt = excerptForHistory(text, limit);
      return { excerpt, units: excerpt.length, points: Array.from(excerpt).length };
    };

    it("counts ASCII, where the two metrics agree", () => {
      const { units, points } = lengths("x".repeat(500), 100);

      expect(units).toBeLessThanOrEqual(100);
      expect(units).toBe(points);
    });

    /** Japanese sits in the BMP: one code point, one unit, like ASCII. */
    it("counts BMP characters such as Japanese", () => {
      const { excerpt, units } = lengths("日本語の本文。".repeat(200), 300);

      expect(units).toBeLessThanOrEqual(300);
      expect(excerpt.endsWith("…")).toBe(true);
    });

    /**
     * The case the two metrics disagree on, at the real limit. Counting code
     * points here would report 1,999 and produce a 3,997-unit string.
     */
    it("counts an astral character as the two units it is", () => {
      const limit = creatorAnalysisLimits.feedbackContentExcerpt;
      const { excerpt, units, points } = lengths("😀".repeat(limit), limit);

      expect(units).toBeLessThanOrEqual(limit);
      expect(points).toBeLessThan(units);
      expect(excerpt.endsWith("…")).toBe(true);
    });

    it("holds a title to the title limit in the same units", () => {
      const limit = creatorAnalysisLimits.feedbackContentTitle;

      expect(
        excerptForHistory("😀".repeat(limit), limit).length,
      ).toBeLessThanOrEqual(limit);
    });

    /** A surviving lone surrogate is what a half-cut character looks like. */
    it.each([1, 2, 3, 4, 11, 99, 300, 2_000])(
      "leaves no half character behind at limit %i",
      (limit) => {
        const excerpt = excerptForHistory("😀a😀日😀".repeat(500), limit);

        expect(excerpt.length).toBeLessThanOrEqual(limit);
        expect(excerpt).not.toContain("�");

        for (const unit of excerpt) {
          const code = unit.codePointAt(0) ?? 0;
          // Iterating a string yields whole code points, so a value left in
          // the surrogate range is one half of a pair with no partner.
          expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
        }
      },
    );

    it("gives the same answer every time, whatever is in the text", () => {
      const text = "😀 日本語 ascii ".repeat(400);

      expect(excerptForHistory(text, 2_000)).toBe(excerptForHistory(text, 2_000));
    });
  });
});

describe("saving an analysis", () => {
  const result = {
    x: { verdict: "recommend" as const, reason: "Stands alone.", draftBody: "A post." },
    reddit: { verdict: "skip" as const, reason: "No community set.", draftBody: null },
    longform: {
      verdict: "recommend" as const,
      reason: "Worth the room.",
      draftBody: "A piece.",
    },
  };

  const persistence = {
    userId: USER,
    title: "A title",
    body: "A body.",
    result,
  };

  it("writes everything inside one transaction", async () => {
    await saveCreatorAnalysis(persistence);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("always records three decisions, one per channel", async () => {
    await saveCreatorAnalysis(persistence);

    expect(decisionCreate).toHaveBeenCalledTimes(3);
    expect(
      decisionCreate.mock.calls.map((call) => call[0].data.targetChannel),
    ).toEqual(["x", "reddit", "longform"]);
  });

  /** A skip with a draft would be a post nobody decided to write. */
  it("writes a draft only where it recommended", async () => {
    await saveCreatorAnalysis(persistence);

    expect(draftCreate).toHaveBeenCalledTimes(2);
    expect(draftCreate.mock.calls.map((call) => call[0].data.body)).toEqual([
      "A post.",
      "A piece.",
    ]);
  });

  it("files everything under the owner it was given", async () => {
    await saveCreatorAnalysis(persistence);

    expect(contentItemCreate.mock.calls[0][0].data.userId).toBe(USER);

    for (const call of decisionCreate.mock.calls) {
      expect(call[0].data.userId).toBe(USER);
    }

    for (const call of draftCreate.mock.calls) {
      expect(call[0].data.userId).toBe(USER);
    }
  });

  it("stores pasted text as pasted text", async () => {
    await saveCreatorAnalysis(persistence);

    const { data } = contentItemCreate.mock.calls[0][0];

    expect(data.sourceKind).toBe("text");
    expect(data.sourceUrl).toBeNull();
    expect(data.body).toBe("A body.");
  });

  /**
   * **The one thing this path must never do.** It is judging a piece of
   * writing; rewriting stated preferences from here would collapse the
   * separation between what somebody said and what a model concluded.
   */
  it("creates a profile if absent and never overwrites one", async () => {
    await saveCreatorAnalysis(persistence);

    const [{ where, create, update }] = profileUpsert.mock.calls[0];

    expect(where).toEqual({ userId: USER });
    expect(create).toEqual({ userId: USER, ...EMPTY_CREATOR_PROFILE });
    expect(update).toEqual({});
  });

  it("returns the content item it created", async () => {
    contentItemCreate.mockResolvedValue({ id: "content-42" });

    await expect(saveCreatorAnalysis(persistence)).resolves.toEqual({
      contentItemId: "content-42",
    });
  });

  /**
   * Rollback itself is PostgreSQL's, not something a mock can demonstrate. What
   * is fixed here is that a failure anywhere inside leaves through the
   * transaction rather than being swallowed and half-committed.
   */
  it("lets a failed write out rather than finishing without it", async () => {
    draftCreate.mockRejectedValue(new Error("connection terminated"));

    await expect(saveCreatorAnalysis(persistence)).rejects.toThrow(
      "connection terminated",
    );
  });
});

describe("finding a decision to answer", () => {
  /**
   * Scoped in the same query that finds it, so somebody else's decision is
   * indistinguishable from one that does not exist. Telling them apart would
   * confirm the existence of another account's work to anyone guessing ids.
   */
  it("looks only within the owner's own work", async () => {
    decisionFindFirst.mockResolvedValue(null);

    await readDecisionForFeedback(USER, "decision-1");

    expect(decisionFindFirst.mock.calls[0][0].where).toEqual({
      id: "decision-1",
      userId: USER,
      contentItem: { userId: USER },
    });
  });

  it("answers with nothing when there is no such decision", async () => {
    decisionFindFirst.mockResolvedValue(null);

    await expect(readDecisionForFeedback(USER, "decision-1")).resolves.toBeNull();
  });

  it("reports whether a draft is there to edit", async () => {
    decisionFindFirst.mockResolvedValue({
      id: "decision-1",
      verdict: "recommend",
      draft: { id: "draft-1", userId: USER },
    });

    await expect(readDecisionForFeedback(USER, "decision-1")).resolves.toEqual({
      id: "decision-1",
      verdict: "recommend",
      hasDraft: true,
    });
  });

  it("refuses to count somebody else's draft as editable", async () => {
    decisionFindFirst.mockResolvedValue({
      id: "decision-1",
      verdict: "recommend",
      draft: { id: "draft-1", userId: OTHER },
    });

    const decision = await readDecisionForFeedback(USER, "decision-1");

    expect(decision?.hasDraft).toBe(false);
  });

  it("treats an unreadable verdict as no decision at all", async () => {
    decisionFindFirst.mockResolvedValue({
      id: "decision-1",
      verdict: "maybe",
      draft: null,
    });

    await expect(readDecisionForFeedback(USER, "decision-1")).resolves.toBeNull();
  });
});

describe("recording an answer", () => {
  it("writes one row, under the owner it was given", async () => {
    feedbackCreate.mockResolvedValue({ id: "feedback-1" });

    await createCreatorFeedback({
      userId: USER,
      editorialDecisionId: "decision-1",
      action: "approve",
      editedBody: null,
      reason: "Good enough.",
    });

    expect(feedbackCreate.mock.calls[0][0].data).toEqual({
      userId: USER,
      editorialDecisionId: "decision-1",
      action: "approve",
      editedBody: null,
      reason: "Good enough.",
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  /**
   * **Append-only.** A row here says what happened at a moment, and a moment
   * does not later become a different one. The constraint decides the winner of
   * a race; the loser gets a name rather than Prisma's error code.
   */
  it("refuses a second answer instead of merging it", async () => {
    feedbackCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      createCreatorFeedback({
        userId: USER,
        editorialDecisionId: "decision-1",
        action: "approve",
        editedBody: null,
        reason: null,
      }),
    ).rejects.toSatisfy(isCreatorFeedbackAlreadyRecorded);
  });

  it("lets an unrelated database failure through unchanged", async () => {
    feedbackCreate.mockRejectedValue(new Error("connection terminated"));

    await expect(
      createCreatorFeedback({
        userId: USER,
        editorialDecisionId: "decision-1",
        action: "approve",
        editedBody: null,
        reason: null,
      }),
    ).rejects.toThrow("connection terminated");
  });
});
