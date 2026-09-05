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
  CREATOR_REVIEW_ITEM_LIMIT,
  isInvalidCreatorReviewData,
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

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "content-1",
    title: "An earlier piece",
    body: "The body of an earlier piece.",
    userId: USER,
    decisions: [decision()],
    ...overrides,
  };
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
      "contentItemId",
      "decisions",
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
