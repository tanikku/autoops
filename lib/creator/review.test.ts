import { beforeEach, describe, expect, it, vi } from "vitest";
import { creatorAnalysisLimits } from "@/lib/creator/analyzer";

/**
 * What the inbox is allowed to show.
 *
 * Two properties are worth more than the rest and both are about what does
 * *not* reach a screen: rows belonging to somebody else, and the whole of an
 * article that only needs to be recognisable. The third is that a row this
 * version cannot read stops the page rather than being rendered as a plausible
 * guess — a made-up channel or verdict would be a claim about what Koqentra
 * once decided, shown to the person whose writing it was about.
 */

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { contentItem: { findMany } },
}));

const {
  CREATOR_HISTORY_ITEM_LIMIT,
  CREATOR_REVIEW_ITEM_LIMIT,
  isInvalidCreatorReviewData,
  listCreatorHistoryItems,
  listCreatorReviewItems,
} = await import("@/lib/creator/review");

const USER = "google-sub-1";
const OTHER = "google-sub-2";

/** One stored decision, with only the parts a test cares about spelled out. */
function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    targetChannel: "x",
    verdict: "recommend",
    reason: "It stands on its own.",
    userId: USER,
    draft: { body: "A short post.", userId: USER },
    feedback: null,
    ...overrides,
  };
}

const ANALYZED_AT = new Date("2026-09-06T03:34:00.000Z");
const ANSWERED_AT = new Date("2026-09-06T03:45:00.000Z");

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "content-1",
    title: "An earlier piece",
    body: "The body of an earlier piece.",
    createdAt: ANALYZED_AT,
    // A pasted piece by default: the source pair is required now, and a row
    // cannot say it came from a page without saying which one.
    sourceKind: "text",
    sourceUrl: null,
    userId: USER,
    decisions: [decision()],
    ...overrides,
  };
}

/** One stored answer, alongside the judgement it answers. */
function answeredDecision(overrides: Record<string, unknown> = {}) {
  const { feedback: feedbackOverride, ...rest } = overrides as {
    feedback?: Record<string, unknown> | null;
  } & Record<string, unknown>;

  return decision({
    feedback:
      feedbackOverride === null
        ? null
        : {
            id: "feedback-1",
            userId: USER,
            action: "approve",
            editedBody: null,
            createdAt: ANSWERED_AT,
            ...(feedbackOverride ?? {}),
          },
    ...rest,
  });
}

function answeredItem(overrides: Record<string, unknown> = {}) {
  return item({ decisions: [answeredDecision()], ...overrides });
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
});

describe("what is asked for", () => {
  /**
   * **Every level, not just the item.** The denormalised `userId` columns are
   * an application invariant: no composite foreign key makes a decision's owner
   * match its content's, so each is named.
   */
  it("asks only for this account's work, at both levels", async () => {
    await listCreatorReviewItems(USER);

    const query = findMany.mock.calls[0][0];

    expect(query.where.userId).toBe(USER);
    expect(query.where.decisions.some.userId).toBe(USER);
    expect(query.select.decisions.where.userId).toBe(USER);
  });

  /** Answered decisions have left the inbox; that is what makes it empty out. */
  it("asks only for decisions nobody has answered", async () => {
    await listCreatorReviewItems(USER);

    const query = findMany.mock.calls[0][0];

    expect(query.where.decisions.some.feedback).toEqual({ is: null });
    expect(query.select.decisions.where.feedback).toEqual({ is: null });
  });

  /**
   * Two pieces stored in the same millisecond would otherwise swap places
   * between one load and the next, and the tenth item would differ each time.
   */
  it("reads newest first, deterministically, and bounded", async () => {
    await listCreatorReviewItems(USER);

    const query = findMany.mock.calls[0][0];

    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(query.take).toBe(CREATOR_REVIEW_ITEM_LIMIT);
    expect(CREATOR_REVIEW_ITEM_LIMIT).toBe(10);
  });
});

describe("what comes back", () => {
  it("is empty when nothing is waiting", async () => {
    await expect(listCreatorReviewItems(USER)).resolves.toEqual([]);
  });

  /** X, then Reddit, then long-form — never whatever the rows arrived in. */
  it("puts the channels in the product's order, not the database's", async () => {
    findMany.mockResolvedValue([
      item({
        decisions: [
          decision({ id: "d-longform", targetChannel: "longform" }),
          decision({ id: "d-reddit", targetChannel: "reddit" }),
          decision({ id: "d-x", targetChannel: "x" }),
        ],
      }),
    ]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.decisions.map((d) => d.targetChannel)).toEqual([
      "x",
      "reddit",
      "longform",
    ]);
  });

  it("carries the post text of a recommendation", async () => {
    findMany.mockResolvedValue([item()]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.decisions[0]).toEqual({
      id: "decision-1",
      targetChannel: "x",
      verdict: "recommend",
      reason: "It stands on its own.",
      postText: "A short post.",
    });
  });

  it("carries no post text for a skip", async () => {
    findMany.mockResolvedValue([
      item({
        decisions: [
          decision({ verdict: "skip", draft: null, reason: "Too thin." }),
        ],
      }),
    ]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.decisions[0].postText).toBeNull();
    expect(entry.decisions[0].verdict).toBe("skip");
  });

  /**
   * **The article itself never reaches a browser.** A reviewer needs to know
   * which piece a judgement is about; sending every stored word to achieve that
   * would put the whole submission into a page's payload for no gain.
   */
  it("sends an excerpt rather than the writing", async () => {
    const body = "PARAGRAPH ".repeat(1_000);
    findMany.mockResolvedValue([item({ body })]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.sourceExcerpt.length).toBeLessThanOrEqual(
      creatorAnalysisLimits.feedbackContentExcerpt,
    );
    expect(entry.sourceExcerpt.length).toBeLessThan(body.length);
    expect(entry.sourceExcerpt.endsWith("…")).toBe(true);
  });

  it("bounds an over-long stored title too", async () => {
    findMany.mockResolvedValue([item({ title: "t".repeat(5_000) })]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.title?.length).toBeLessThanOrEqual(
      creatorAnalysisLimits.feedbackContentTitle,
    );
  });

  it("keeps a missing title missing rather than inventing one", async () => {
    findMany.mockResolvedValue([item({ title: null })]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.title).toBeNull();
  });

  /**
   * The DTO is what a screen gets, so what is not in it cannot leak from it.
   * An owner, a profile id, or the full body would all be travelling for no
   * reason anybody asked for.
   */
  it("exposes nothing but what a reviewer needs", async () => {
    const body = "THE WHOLE UNPUBLISHED BODY";
    findMany.mockResolvedValue([item({ body })]);

    const [entry] = await listCreatorReviewItems(USER);
    const serialized = JSON.stringify(entry);

    expect(Object.keys(entry).sort()).toEqual([
      // The moment of the analysis joined this list in C1.8B: two submissions
      // of the same piece are otherwise indistinguishable on screen. Where it
      // came from joined it in C1.9B, for the same reason.
      "analyzedAt",
      "contentItemId",
      "decisions",
      "source",
      "sourceExcerpt",
      "title",
    ]);
    expect(Object.keys(entry.decisions[0]).sort()).toEqual([
      "id",
      "postText",
      "reason",
      "targetChannel",
      "verdict",
    ]);
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain("creatorProfileId");
    // The excerpt is short enough that the whole body is not in it.
    expect(entry.sourceExcerpt).toBe(body);
  });
});

/**
 * **Refused, not repaired.** Each of these describes something that cannot have
 * happened, and rendering a guess would show somebody a decision Koqentra never
 * made about writing that is theirs.
 */
describe("a row that cannot be shown", () => {
  it.each([
    ["a decision belonging to somebody else", { userId: OTHER }],
    [
      "post text belonging to somebody else",
      { draft: { body: "A post.", userId: OTHER } },
    ],
    ["an unknown channel", { targetChannel: "mastodon" }],
    ["an unknown verdict", { verdict: "maybe" }],
    ["an empty reason", { reason: "   " }],
    ["a recommendation with no post text", { draft: null }],
    [
      "a skip that carries post text",
      { verdict: "skip", draft: { body: "A post.", userId: USER } },
    ],
    ["a decision that was already answered", { feedback: { id: "f-1" } }],
  ])("stops on %s", async (_name, overrides) => {
    findMany.mockResolvedValue([item({ decisions: [decision(overrides)] })]);

    await expect(listCreatorReviewItems(USER)).rejects.toSatisfy(
      isInvalidCreatorReviewData,
    );
  });

  it("stops on content belonging to somebody else", async () => {
    findMany.mockResolvedValue([item({ userId: OTHER })]);

    await expect(listCreatorReviewItems(USER)).rejects.toSatisfy(
      isInvalidCreatorReviewData,
    );
  });

  it("names an id but nothing that was written", async () => {
    findMany.mockResolvedValue([
      item({
        body: "SECRET UNPUBLISHED BODY",
        decisions: [
          decision({
            targetChannel: "mastodon",
            draft: { body: "SECRET POST TEXT", userId: USER },
          }),
        ],
      }),
    ]);

    const failure = await listCreatorReviewItems(USER).catch((error) => error);

    expect(failure.decisionId).toBe("decision-1");
    expect(failure.message).not.toContain("SECRET UNPUBLISHED BODY");
    expect(failure.message).not.toContain("SECRET POST TEXT");
  });
});

/**
 * Which analysis a judgement came from.
 *
 * Two submissions of the same piece are two identical headings otherwise, which
 * is the confusion this exists to answer — so the moment comes from the row
 * that *is* the analysis rather than from anything written later.
 */
describe("when the analysis happened", () => {
  it("dates an inbox item by its own row", async () => {
    findMany.mockResolvedValue([item()]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.analyzedAt).toBe(ANALYZED_AT);
  });

  it("reads the column it needs to say so", async () => {
    await listCreatorReviewItems(USER);

    expect(findMany.mock.calls[0][0].select.createdAt).toBe(true);
  });
});

describe("what the history asks for", () => {
  it("asks only for this account's work, at every level", async () => {
    await listCreatorHistoryItems(USER);

    const query = findMany.mock.calls[0][0];

    expect(query.where.userId).toBe(USER);
    expect(query.where.decisions.some.userId).toBe(USER);
    expect(query.select.decisions.where.userId).toBe(USER);
  });

  /** The mirror of the inbox: answered rather than waiting. */
  it("asks only for decisions somebody has answered", async () => {
    await listCreatorHistoryItems(USER);

    const query = findMany.mock.calls[0][0];

    expect(query.where.decisions.some.feedback).toEqual({ isNot: null });
    expect(query.select.decisions.where.feedback).toEqual({ isNot: null });
  });

  /**
   * **By the analysis, not by the answer.** What somebody is looking for is
   * which analysis a judgement came from; ordering by when each was answered
   * would interleave two analyses of the same piece.
   */
  it("reads newest analysis first, deterministically, and bounded", async () => {
    await listCreatorHistoryItems(USER);

    const query = findMany.mock.calls[0][0];

    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(query.take).toBe(CREATOR_HISTORY_ITEM_LIMIT);
    expect(CREATOR_HISTORY_ITEM_LIMIT).toBe(20);
  });

  /** Everything a card shows comes back in this one read. */
  it("takes one query, however many analyses come back", async () => {
    findMany.mockResolvedValue([
      answeredItem({ id: "content-1" }),
      answeredItem({ id: "content-2" }),
      answeredItem({ id: "content-3" }),
    ]);

    await listCreatorHistoryItems(USER);

    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("what the history shows", () => {
  it("is empty when nothing has been answered", async () => {
    await expect(listCreatorHistoryItems(USER)).resolves.toEqual([]);
  });

  it("carries the analysis, the excerpt and the answer", async () => {
    findMany.mockResolvedValue([answeredItem()]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.contentItemId).toBe("content-1");
    expect(entry.title).toBe("An earlier piece");
    expect(entry.analyzedAt).toBe(ANALYZED_AT);
    expect(entry.decisions[0]).toEqual({
      id: "decision-1",
      targetChannel: "x",
      verdict: "recommend",
      reason: "It stands on its own.",
      postText: "A short post.",
      action: "approve",
      editedPostText: null,
      answeredAt: ANSWERED_AT,
    });
  });

  /**
   * **Both halves, kept apart.** The proposal is not overwritten by the
   * rewrite; the pair is the whole reason to look back at one of these.
   */
  it("keeps the proposal and the rewrite side by side", async () => {
    findMany.mockResolvedValue([
      answeredItem({
        decisions: [
          answeredDecision({
            feedback: { action: "edit", editedBody: "What I actually posted." },
          }),
        ],
      }),
    ]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.decisions[0].postText).toBe("A short post.");
    expect(entry.decisions[0].editedPostText).toBe("What I actually posted.");
  });

  it("puts the channels in the product's order", async () => {
    findMany.mockResolvedValue([
      answeredItem({
        decisions: [
          answeredDecision({ id: "d-longform", targetChannel: "longform" }),
          answeredDecision({
            id: "d-reddit",
            targetChannel: "reddit",
            verdict: "skip",
            draft: null,
          }),
          answeredDecision({ id: "d-x", targetChannel: "x" }),
        ],
      }),
    ]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.decisions.map((d) => d.targetChannel)).toEqual([
      "x",
      "reddit",
      "longform",
    ]);
  });

  /** The article that prompted a decision is not what looking back needs. */
  it("shows an excerpt of the piece and never the whole of it", async () => {
    const body = "A sentence that goes on. ".repeat(4_000);

    findMany.mockResolvedValue([answeredItem({ body })]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.sourceExcerpt.length).toBeLessThanOrEqual(
      creatorAnalysisLimits.feedbackContentExcerpt,
    );
    expect(entry.sourceExcerpt).not.toBe(body);
  });

  it("bounds a long title the same way", async () => {
    findMany.mockResolvedValue([answeredItem({ title: "T".repeat(2_000) })]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.title?.length).toBeLessThanOrEqual(
      creatorAnalysisLimits.feedbackContentTitle,
    );
  });
});

/**
 * A record with a guess in it is worse than a blank page: it is a claim about
 * what Koqentra once decided, and about what somebody once chose, put in front
 * of the person it was about.
 */
describe("what the history refuses to show", () => {
  it.each([
    ["an item belonging to somebody else", answeredItem({ userId: OTHER })],
    [
      "a decision belonging to somebody else",
      answeredItem({ decisions: [answeredDecision({ userId: OTHER })] }),
    ],
    [
      "post text belonging to somebody else",
      answeredItem({
        decisions: [
          answeredDecision({ draft: { body: "A short post.", userId: OTHER } }),
        ],
      }),
    ],
    [
      "an answer belonging to somebody else",
      answeredItem({
        decisions: [answeredDecision({ feedback: { userId: OTHER } })],
      }),
    ],
    [
      "a decision nobody answered",
      answeredItem({ decisions: [answeredDecision({ feedback: null })] }),
    ],
    [
      "a channel this version does not know",
      answeredItem({
        decisions: [answeredDecision({ targetChannel: "mastodon" })],
      }),
    ],
    [
      "a verdict this version does not know",
      answeredItem({ decisions: [answeredDecision({ verdict: "maybe" })] }),
    ],
    [
      "an answer this version does not know",
      answeredItem({
        decisions: [answeredDecision({ feedback: { action: "postpone" } })],
      }),
    ],
    [
      "a recommendation with nothing to publish",
      answeredItem({ decisions: [answeredDecision({ draft: null })] }),
    ],
    [
      "a skip carrying a post",
      answeredItem({ decisions: [answeredDecision({ verdict: "skip" })] }),
    ],
    [
      "an edit with nothing written",
      answeredItem({
        decisions: [
          answeredDecision({ feedback: { action: "edit", editedBody: "   " } }),
        ],
      }),
    ],
    [
      "an edit with no text at all",
      answeredItem({
        decisions: [answeredDecision({ feedback: { action: "edit" } })],
      }),
    ],
    [
      "an approval carrying a rewrite",
      answeredItem({
        decisions: [
          answeredDecision({
            feedback: { action: "approve", editedBody: "Something else." },
          }),
        ],
      }),
    ],
    [
      "an edit of a skip",
      answeredItem({
        decisions: [
          answeredDecision({
            verdict: "skip",
            draft: null,
            feedback: { action: "edit", editedBody: "Something else." },
          }),
        ],
      }),
    ],
    [
      "a judgement with no reason given",
      answeredItem({ decisions: [answeredDecision({ reason: "  " })] }),
    ],
  ])("refuses %s", async (_name, row) => {
    findMany.mockResolvedValue([row]);

    await expect(listCreatorHistoryItems(USER)).rejects.toSatisfy(
      isInvalidCreatorReviewData,
    );
  });

  it("names an id but nothing that was written", async () => {
    findMany.mockResolvedValue([
      answeredItem({
        body: "SECRET UNPUBLISHED BODY",
        decisions: [
          answeredDecision({
            targetChannel: "mastodon",
            draft: { body: "SECRET POST TEXT", userId: USER },
            feedback: { action: "edit", editedBody: "SECRET EDIT" },
          }),
        ],
      }),
    ]);

    const failure = await listCreatorHistoryItems(USER).catch((error) => error);

    expect(failure.decisionId).toBe("decision-1");
    expect(failure.message).not.toContain("SECRET UNPUBLISHED BODY");
    expect(failure.message).not.toContain("SECRET POST TEXT");
    expect(failure.message).not.toContain("SECRET EDIT");
  });
});

/**
 * Where an analysis got its material.
 *
 * **Two columns that only mean something together.** `"url"` with no address
 * cannot be linked to, and `"text"` carrying one describes a fetch that never
 * happened. Falling back to `"text"` would be the worst of the options: it
 * reads as ordinary and hides the contradiction.
 *
 * **Nothing here goes near a network.** The address came back from the Safe
 * Fetch that actually read the page, so it was validated at the one moment
 * validation meant anything.
 */
describe("where the material came from", () => {
  it("reads the source columns", async () => {
    await listCreatorReviewItems(USER);

    const select = findMany.mock.calls[0][0].select;

    expect(select.sourceKind).toBe(true);
    expect(select.sourceUrl).toBe(true);
  });

  it("reads them for the history too", async () => {
    await listCreatorHistoryItems(USER);

    const select = findMany.mock.calls[0][0].select;

    expect(select.sourceKind).toBe(true);
    expect(select.sourceUrl).toBe(true);
  });

  it("says a pasted piece has no address", async () => {
    findMany.mockResolvedValue([item({ sourceKind: "text", sourceUrl: null })]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.source).toEqual({ kind: "text" });
  });

  it("carries the address a page was read from", async () => {
    findMany.mockResolvedValue([
      item({ sourceKind: "url", sourceUrl: "https://www.example.com/a/" }),
    ]);

    const [entry] = await listCreatorReviewItems(USER);

    expect(entry.source).toEqual({
      kind: "url",
      url: "https://www.example.com/a/",
    });
  });

  it("says the same thing on the history", async () => {
    findMany.mockResolvedValue([
      answeredItem({ sourceKind: "url", sourceUrl: "https://www.example.com/a/" }),
      ]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.source).toEqual({
      kind: "url",
      url: "https://www.example.com/a/",
    });
  });

  it("says a pasted piece has no address on the history too", async () => {
    findMany.mockResolvedValue([
      answeredItem({ sourceKind: "text", sourceUrl: null }),
    ]);

    const [entry] = await listCreatorHistoryItems(USER);

    expect(entry.source).toEqual({ kind: "text" });
  });

  it.each([
    ["a source kind this version does not know", { sourceKind: "rss", sourceUrl: null }],
    [
      "a pasted piece carrying an address",
      { sourceKind: "text", sourceUrl: "https://www.example.com/a/" },
    ],
    ["a page with no address", { sourceKind: "url", sourceUrl: null }],
    ["a page with a blank address", { sourceKind: "url", sourceUrl: "   " }],
  ])("refuses %s", async (_name, overrides) => {
    findMany.mockResolvedValue([item(overrides)]);

    await expect(listCreatorReviewItems(USER)).rejects.toSatisfy(
      isInvalidCreatorReviewData,
    );
  });

  it.each([
    ["a source kind this version does not know", { sourceKind: "rss", sourceUrl: null }],
    [
      "a pasted piece carrying an address",
      { sourceKind: "text", sourceUrl: "https://www.example.com/a/" },
    ],
    ["a page with no address", { sourceKind: "url", sourceUrl: null }],
  ])("refuses %s on the history", async (_name, overrides) => {
    findMany.mockResolvedValue([answeredItem(overrides)]);

    await expect(listCreatorHistoryItems(USER)).rejects.toSatisfy(
      isInvalidCreatorReviewData,
    );
  });

  /** Reading a record must not be a reason to contact anybody. */
  it("asks for the page exactly never", async () => {
    findMany.mockResolvedValue([
      item({ sourceKind: "url", sourceUrl: "https://www.example.com/a/" }),
    ]);

    await listCreatorReviewItems(USER);

    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
