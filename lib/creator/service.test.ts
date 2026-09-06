import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CreatorAnalysisRequest,
  type CreatorAnalysisResult,
  type CreatorAnalyzer,
  creatorAnalysisLimits,
  CreatorAnalysisRequestTooLargeError,
  InvalidCreatorAnalysisResponseError,
} from "@/lib/creator/analyzer";
import { ProviderError } from "@/lib/ai/provider";

/**
 * The loop, end to end, with a fake model and a replaced database.
 *
 * **No key is needed and none is used.** The analyzer arrives as an argument
 * precisely so that this can be true: a service that reached for a factory
 * would make every test of it either a mock of the factory or a bill.
 *
 * The block that matters most is the last one. It is the only place where the
 * three halves of the product — analyse, answer, analyse again — are checked as
 * one thing, and what it fixes is that a person's disagreement actually reaches
 * the next request rather than merely being stored.
 */

const {
  profileFindUnique,
  feedbackFindMany,
  memoryFindFirst,
  evidenceCreateMany,
  memoryCreate,
  memoryUpdateMany,
  feedbackCreate,
  decisionFindFirst,
  decisionCreate,
  contentItemCreate,
  draftCreate,
  transaction,
} = vi.hoisted(() => ({
  profileFindUnique: vi.fn(),
  feedbackFindMany: vi.fn(),
  memoryFindFirst: vi.fn(),
  evidenceCreateMany: vi.fn(),
  memoryCreate: vi.fn(),
  memoryUpdateMany: vi.fn(),
  feedbackCreate: vi.fn(),
  decisionFindFirst: vi.fn(),
  decisionCreate: vi.fn(),
  contentItemCreate: vi.fn(),
  draftCreate: vi.fn(),
  transaction: vi.fn(),
}));

const profileUpsert = vi.fn();

const tx = {
  creatorProfile: { upsert: profileUpsert, findUnique: profileFindUnique },
  contentItem: { create: contentItemCreate },
  editorialDecision: { create: decisionCreate },
  contentDraft: { create: draftCreate },
  creatorMemory: { create: memoryCreate, updateMany: memoryUpdateMany },
  creatorMemoryEvidence: { createMany: evidenceCreateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    creatorProfile: { findUnique: profileFindUnique, upsert: profileUpsert },
    creatorFeedback: { findMany: feedbackFindMany, create: feedbackCreate },
    creatorMemory: {
      findFirst: memoryFindFirst,
      create: memoryCreate,
      updateMany: memoryUpdateMany,
    },
    creatorMemoryEvidence: { createMany: evidenceCreateMany },
    editorialDecision: { findFirst: decisionFindFirst, create: decisionCreate },
    contentItem: { create: contentItemCreate },
    contentDraft: { create: draftCreate },
    $transaction: transaction,
  },
}));

const {
  analyzeCreatorText,
  analyzeCreatorUrl,
  isEmptyCreatorContent,
  isInvalidCreatorFeedback,
  recordCreatorFeedback,
} = await import("@/lib/creator/service");

const { isCreatorDecisionNotFound } = await import("@/lib/creator/repository");

const USER = "google-sub-1";

/**
 * One mock serves two reads with different `select`s — the profile the analyzer
 * is given, and the id a first memory row hangs off — so the fixture satisfies
 * both rather than whichever ran last.
 */
const PROFILE_ROW = {
  id: "profile-1",
  audience: "",
  goals: "",
  voiceInstructions: "",
};

const recommend = (draft: string) => ({
  verdict: "recommend" as const,
  reason: "Worth posting.",
  draftBody: draft,
});

const skip = () => ({
  verdict: "skip" as const,
  reason: "Not for this one.",
  draftBody: null,
});

/**
 * A model that answers from a script and records what it was asked.
 *
 * **Never reaches the network.** There is nothing to stub out: it is an object
 * with one method, which is what `CreatorAnalyzer` being an interface buys.
 */
function fakeAnalyzer(...answers: CreatorAnalysisResult[]) {
  const requests: CreatorAnalysisRequest[] = [];
  let call = 0;

  const analyzer: CreatorAnalyzer = {
    analyze: async (request) => {
      requests.push(structuredClone(request));
      return answers[Math.min(call++, answers.length - 1)];
    },
  };

  return { analyzer, requests };
}

/** A model that fails, however it happens to fail. */
function failingAnalyzer(error: unknown): CreatorAnalyzer {
  return {
    analyze: async () => {
      throw error;
    },
  };
}

const threeRecommendations: CreatorAnalysisResult = {
  x: recommend("A short post."),
  reddit: recommend("A question."),
  longform: recommend("A longer piece."),
};

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
  profileFindUnique.mockResolvedValue(null);
  feedbackFindMany.mockResolvedValue([]);
  memoryFindFirst.mockReset().mockResolvedValue(null);
  memoryCreate.mockReset().mockResolvedValue({ id: "memory-1" });
  memoryUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  evidenceCreateMany.mockReset().mockResolvedValue({ count: 0 });
  profileUpsert.mockResolvedValue({ id: "profile-1" });
  contentItemCreate.mockResolvedValue({ id: "content-1" });
  decisionCreate.mockResolvedValue({ id: "decision-1" });
  draftCreate.mockResolvedValue({ id: "draft-1" });
});

describe("what the model is asked", () => {
  it("sends empty preferences when the account has stated none", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "A body." }, analyzer);

    expect(requests[0].profile).toEqual({
      audience: "",
      goals: "",
      voiceInstructions: "",
    });
  });

  it("sends stated preferences exactly as stated", async () => {
    profileFindUnique.mockResolvedValue({
      audience: "Solo founders",
      goals: "Be useful, not loud",
      voiceInstructions: "No exclamation marks",
    });
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "A body." }, analyzer);

    expect(requests[0].profile).toEqual({
      audience: "Solo founders",
      goals: "Be useful, not loud",
      voiceInstructions: "No exclamation marks",
    });
  });

  /** C1 has one way in, so provenance is not something a caller may claim. */
  it("describes the material as pasted text", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: "  A title  ", body: "A body." }, analyzer);

    expect(requests[0].content).toEqual({
      sourceKind: "text",
      sourceUrl: null,
      title: "A title",
      body: "A body.",
    });
  });

  it("treats a blank title as no title", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: "   ", body: "A body." }, analyzer);

    expect(requests[0].content.title).toBeNull();
  });

  /** Trimming what gets judged would change the material on its way in. */
  it("judges the body exactly as it was written", async () => {
    const body = "  Leading and trailing space matters.  \n";
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body }, analyzer);

    expect(requests[0].content.body).toBe(body);
    expect(contentItemCreate.mock.calls[0][0].data.body).toBe(body);
  });
});

describe("when there is nothing to do", () => {
  it.each(["", "   ", "\n\t "])(
    "refuses a body of %o without calling the model",
    async (body) => {
      const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

      await expect(
        analyzeCreatorText(USER, { title: null, body }, analyzer),
      ).rejects.toSatisfy(isEmptyCreatorContent);

      expect(requests).toHaveLength(0);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  /**
   * Measured before the call, so an oversized request costs nothing. The limit
   * belongs to the analyzer contract; nothing here restates the number.
   */
  it("refuses an oversized request without calling the model", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await expect(
      analyzeCreatorText(
        USER,
        { title: null, body: "b".repeat(creatorAnalysisLimits.contentBody + 1) },
        analyzer,
      ),
    ).rejects.toBeInstanceOf(CreatorAnalysisRequestTooLargeError);

    expect(requests).toHaveLength(0);
    expect(transaction).not.toHaveBeenCalled();
  });
});

/**
 * **Nothing is written until the analysis has succeeded.** A failed call must
 * not leave a content item, an empty profile, or a half-finished set of
 * decisions for somebody to find later and wonder about.
 */
describe("when the model does not answer", () => {
  it.each([
    ["a provider failure", new ProviderError("unavailable", "down")],
    ["a refusal", new ProviderError("refused", "declined")],
    [
      "an unusable answer",
      new InvalidCreatorAnalysisResponseError("the answer was not an object"),
    ],
    ["something unexpected", new Error("who knows")],
  ])("writes nothing after %s", async (_name, error) => {
    await expect(
      analyzeCreatorText(
        USER,
        { title: null, body: "A body." },
        failingAnalyzer(error),
      ),
    ).rejects.toBeTruthy();

    expect(transaction).not.toHaveBeenCalled();
    expect(profileUpsert).not.toHaveBeenCalled();
    expect(contentItemCreate).not.toHaveBeenCalled();
    expect(decisionCreate).not.toHaveBeenCalled();
    expect(draftCreate).not.toHaveBeenCalled();
  });

  /** Reading a profile must not be what creates one. */
  it("does not create a profile just by looking for one", async () => {
    await expect(
      analyzeCreatorText(
        USER,
        { title: null, body: "A body." },
        failingAnalyzer(new ProviderError("timeout", "slow")),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(profileFindUnique).toHaveBeenCalled();
    expect(profileUpsert).not.toHaveBeenCalled();
  });
});

describe("what a successful analysis leaves behind", () => {
  it("records three decisions and drafts only the recommendations", async () => {
    const { analyzer } = fakeAnalyzer({
      x: recommend("A short post."),
      reddit: skip(),
      longform: recommend("A longer piece."),
    });

    const outcome = await analyzeCreatorText(
      USER,
      { title: "A title", body: "A body." },
      analyzer,
    );

    expect(decisionCreate).toHaveBeenCalledTimes(3);
    expect(draftCreate).toHaveBeenCalledTimes(2);
    expect(outcome.contentItemId).toBe("content-1");
    expect(outcome.result.reddit.verdict).toBe("skip");
  });

  /**
   * **The model is called outside the transaction.** A request may take the
   * better part of a minute; a connection held open across it would be one
   * connection per analysis spent waiting on somebody else's API.
   */
  it("finishes talking to the model before opening a transaction", async () => {
    const order: string[] = [];

    transaction.mockImplementation((run: (client: unknown) => unknown) => {
      order.push("transaction");
      return run(tx);
    });

    const analyzer: CreatorAnalyzer = {
      analyze: async () => {
        order.push("analyze");
        return threeRecommendations;
      },
    };

    await analyzeCreatorText(USER, { title: null, body: "A body." }, analyzer);

    expect(order).toEqual(["analyze", "transaction"]);
  });
});

describe("recording what somebody decided", () => {
  beforeEach(() => {
    decisionFindFirst.mockResolvedValue({
      id: "decision-1",
      verdict: "recommend",
      draft: { id: "draft-1", userId: USER },
    });
    feedbackCreate.mockResolvedValue({ id: "feedback-1" });
  });

  it.each(["approve", "reject"] as const)("records a plain %s", async (action) => {
    await recordCreatorFeedback(USER, "decision-1", {
      action,
      editedBody: null,
      reason: "  Because.  ",
    });

    expect(feedbackCreate.mock.calls[0][0].data).toEqual({
      userId: USER,
      editorialDecisionId: "decision-1",
      action,
      editedBody: null,
      reason: "Because.",
    });
  });

  it("records an edit against a recommendation that has a draft", async () => {
    await recordCreatorFeedback(USER, "decision-1", {
      action: "edit",
      editedBody: "What I actually wanted.",
      reason: null,
    });

    expect(feedbackCreate.mock.calls[0][0].data.editedBody).toBe(
      "What I actually wanted.",
    );
  });

  /**
   * **The original is never touched.** What was proposed and what was wanted
   * are only a signal together; overwriting the first to store the second would
   * destroy the half that carries it.
   */
  it("leaves the original draft exactly as written", async () => {
    await recordCreatorFeedback(USER, "decision-1", {
      action: "edit",
      editedBody: "Rewritten.",
      reason: null,
    });

    expect(draftCreate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("hands a missing decision back as not found", async () => {
    decisionFindFirst.mockResolvedValue(null);

    await expect(
      recordCreatorFeedback(USER, "decision-1", {
        action: "approve",
        editedBody: null,
        reason: null,
      }),
    ).rejects.toSatisfy(isCreatorDecisionNotFound);

    expect(feedbackCreate).not.toHaveBeenCalled();
  });

  /** Somebody else's decision is answered exactly as one that does not exist. */
  it("scopes the lookup to the owner it was given", async () => {
    decisionFindFirst.mockResolvedValue(null);

    await recordCreatorFeedback(USER, "decision-1", {
      action: "approve",
      editedBody: null,
      reason: null,
    }).catch(() => undefined);

    expect(decisionFindFirst.mock.calls[0][0].where).toEqual({
      id: "decision-1",
      userId: USER,
      contentItem: { userId: USER },
    });
  });

  it.each([
    ["an edit of a skip", { verdict: "skip", draft: null }, "edit", "Rewritten."],
    [
      "an edit where no draft exists",
      { verdict: "recommend", draft: null },
      "edit",
      "Rewritten.",
    ],
  ] as const)("refuses %s", async (_name, stored, action, editedBody) => {
    decisionFindFirst.mockResolvedValue({ id: "decision-1", ...stored });

    await expect(
      recordCreatorFeedback(USER, "decision-1", { action, editedBody, reason: null }),
    ).rejects.toSatisfy(isInvalidCreatorFeedback);

    expect(feedbackCreate).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])(
    "refuses an edit that edited nothing (%o)",
    async (editedBody) => {
      await expect(
        recordCreatorFeedback(USER, "decision-1", {
          action: "edit",
          editedBody,
          reason: null,
        }),
      ).rejects.toSatisfy(isInvalidCreatorFeedback);
    },
  );

  /**
   * Approving *and* rewriting are two different answers; storing both would
   * leave the next analysis unable to tell which one happened.
   */
  it.each(["approve", "reject"] as const)(
    "refuses a %s that carries edited text",
    async (action) => {
      await expect(
        recordCreatorFeedback(USER, "decision-1", {
          action,
          editedBody: "Rewritten.",
          reason: null,
        }),
      ).rejects.toSatisfy(isInvalidCreatorFeedback);

      expect(feedbackCreate).not.toHaveBeenCalled();
    },
  );

  it("refuses text longer than the history could carry", async () => {
    await expect(
      recordCreatorFeedback(USER, "decision-1", {
        action: "edit",
        editedBody: "e".repeat(creatorAnalysisLimits.feedbackEditedBody + 1),
        reason: null,
      }),
    ).rejects.toSatisfy(isInvalidCreatorFeedback);

    await expect(
      recordCreatorFeedback(USER, "decision-1", {
        action: "approve",
        editedBody: null,
        reason: "r".repeat(creatorAnalysisLimits.feedbackReason + 1),
      }),
    ).rejects.toSatisfy(isInvalidCreatorFeedback);

    expect(feedbackCreate).not.toHaveBeenCalled();
  });

  it("reads a whitespace-only reason as nothing said", async () => {
    await recordCreatorFeedback(USER, "decision-1", {
      action: "approve",
      editedBody: null,
      reason: "   ",
    });

    expect(feedbackCreate.mock.calls[0][0].data.reason).toBeNull();
  });
});

/**
 * **The product, as one movement.**
 *
 * Analyse a piece, disagree with one of its decisions, analyse the next piece —
 * and check that the disagreement is in front of the model the second time.
 * Everything else in this file fixes a rule; this fixes the reason the rules
 * are there.
 *
 * **The fake model's answers do not change between calls, deliberately.**
 * Whether a model actually revises its judgement is not something a test can
 * assert without asserting the behaviour of a language model. What is provable
 * — and what would silently break — is that the evidence *arrives*.
 */
describe("the loop", () => {
  it("puts a rejected skip in front of the next analysis", async () => {
    // ── First piece: recommended for x, skipped for reddit.
    const first = fakeAnalyzer({
      x: recommend("A short post."),
      reddit: skip(),
      longform: recommend("A longer piece."),
    });

    contentItemCreate.mockResolvedValue({ id: "content-A" });
    decisionCreate
      .mockResolvedValueOnce({ id: "decision-x" })
      .mockResolvedValueOnce({ id: "decision-reddit" })
      .mockResolvedValueOnce({ id: "decision-longform" });

    await analyzeCreatorText(
      USER,
      { title: "Content A", body: "The body of content A." },
      first.analyzer,
    );

    expect(first.requests[0].feedback).toEqual([]);
    expect(draftCreate).toHaveBeenCalledTimes(2);

    // ── The person disagrees with the reddit skip.
    decisionFindFirst.mockResolvedValue({
      id: "decision-reddit",
      verdict: "skip",
      draft: null,
    });
    feedbackCreate.mockResolvedValue({ id: "feedback-1" });

    await recordCreatorFeedback(USER, "decision-reddit", {
      action: "reject",
      editedBody: null,
      reason: "This was worth discussing.",
    });

    expect(feedbackCreate.mock.calls[0][0].data).toEqual({
      userId: USER,
      editorialDecisionId: "decision-reddit",
      action: "reject",
      editedBody: null,
      reason: "This was worth discussing.",
    });

    // ── Second piece: the history now holds that rejection.
    feedbackFindMany.mockResolvedValue([
      {
        id: "feedback-1",
        action: "reject",
        editedBody: null,
        reason: "This was worth discussing.",
        editorialDecision: {
          id: "decision-reddit",
          targetChannel: "reddit",
          verdict: "skip",
          reason: "No community configured.",
          userId: USER,
          draft: null,
          contentItem: {
            title: "Content A",
            body: "The body of content A.",
            userId: USER,
          },
        },
      },
    ]);

    const second = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(
      USER,
      { title: "Content B", body: "The body of content B." },
      second.analyzer,
    );

    const [entry] = second.requests[0].feedback;

    expect(second.requests[0].feedback).toHaveLength(1);
    expect(entry).toEqual({
      targetChannel: "reddit",
      verdict: "skip",
      decisionReason: "No community configured.",
      // **No draft, because a skip never had one** — which is exactly why the
      // two grounding fields below have to be here.
      draftBody: null,
      action: "reject",
      editedBody: null,
      feedbackReason: "This was worth discussing.",
      contentTitle: "Content A",
      contentExcerpt: "The body of content A.",
    });

    // The piece being judged now is the new one, not the remembered one.
    expect(second.requests[0].content.body).toBe("The body of content B.");
  });

  /**
   * **The join between the two layers, measured in the units that matter.**
   *
   * The repository builds excerpts and the analyzer contract enforces limits,
   * and they only agree if both count `String.length` — UTF-16 code units. An
   * emoji is one code point and two units, so a history of emoji is where a
   * per-character budget would come apart: twelve entries would each report
   * themselves as within 2,000 and arrive as 4,000.
   *
   * Testing `excerptForHistory` alone cannot catch that, because the mismatch
   * only exists between the two layers. This runs the real path — stored rows
   * in, request out — and lets the real assertion judge it.
   */
  it("builds a history the analyzer contract accepts, emoji and all", async () => {
    const enormous = "😀日a".repeat(20_000);

    feedbackFindMany.mockResolvedValue(
      Array.from({ length: creatorAnalysisLimits.feedbackItems }, (_, index) => ({
        id: `feedback-${index}`,
        action: "edit",
        editedBody: "😀".repeat(200),
        reason: "😀".repeat(200),
        editorialDecision: {
          id: `decision-${index}`,
          targetChannel: "longform",
          verdict: "recommend",
          reason: "😀".repeat(200),
          userId: USER,
          draft: { body: "😀".repeat(200), userId: USER },
          contentItem: { title: enormous, body: enormous, userId: USER },
        },
      })),
    );

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    // Throws if any field is over its limit — the same call the service makes
    // before reaching a model, exercised here through the whole path.
    await analyzeCreatorText(USER, { title: null, body: "A body." }, analyzer);

    const [request] = requests;

    expect(request.feedback).toHaveLength(creatorAnalysisLimits.feedbackItems);

    for (const entry of request.feedback) {
      expect(entry.contentExcerpt.length).toBeLessThanOrEqual(
        creatorAnalysisLimits.feedbackContentExcerpt,
      );
      expect(entry.contentTitle?.length ?? 0).toBeLessThanOrEqual(
        creatorAnalysisLimits.feedbackContentTitle,
      );
      expect(entry.contentExcerpt).not.toContain("�");
    }
  });
});

/**
 * The same loop, told where the words came from.
 *
 * **Provenance is the only difference.** The profile, the recent answers, the
 * limits, the ordering and the all-or-nothing write are shared code — what
 * these fix is that the pair travels intact to both the model and the database,
 * and that the paste path did not quietly acquire a URL on the way.
 */
describe("analysing a page that was read from an address", () => {
  const PAGE_URL = "https://www.example.com/article/";

  it("tells the model where the words came from", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorUrl(
      USER,
      { title: "A title", sourceUrl: PAGE_URL, body: "The page text." },
      analyzer,
    );

    expect(requests[0].content).toEqual({
      sourceKind: "url",
      sourceUrl: PAGE_URL,
      title: "A title",
      body: "The page text.",
    });
  });

  /** The paste path is what it always was, and gains no address. */
  it("leaves a pasted piece saying it was pasted", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "Pasted." }, analyzer);

    expect(requests[0].content.sourceKind).toBe("text");
    expect(requests[0].content.sourceUrl).toBeNull();
  });

  it("reads the same preferences and the same recent answers", async () => {
    profileFindUnique.mockResolvedValue({
      audience: "Solo founders",
      goals: "Be useful",
      voiceInstructions: "Plain sentences",
    });

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorUrl(
      USER,
      { title: null, sourceUrl: PAGE_URL, body: "The page text." },
      analyzer,
    );

    expect(requests[0].profile).toEqual({
      audience: "Solo founders",
      goals: "Be useful",
      voiceInstructions: "Plain sentences",
    });
    expect(profileFindUnique.mock.calls[0][0].where).toEqual({ userId: USER });
    expect(feedbackFindMany).toHaveBeenCalledTimes(1);
  });

  it("stores the address alongside what was read", async () => {
    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorUrl(
      USER,
      { title: "A title", sourceUrl: PAGE_URL, body: "The page text." },
      analyzer,
    );

    expect(contentItemCreate.mock.calls[0][0].data).toMatchObject({
      userId: USER,
      sourceKind: "url",
      sourceUrl: PAGE_URL,
      title: "A title",
      body: "The page text.",
    });
  });

  it("stores a pasted piece with no address, as before", async () => {
    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "Pasted." }, analyzer);

    expect(contentItemCreate.mock.calls[0][0].data).toMatchObject({
      sourceKind: "text",
      sourceUrl: null,
    });
  });

  it("applies the same request limits", async () => {
    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await expect(
      analyzeCreatorUrl(
        USER,
        {
          title: null,
          sourceUrl: PAGE_URL,
          body: "x".repeat(creatorAnalysisLimits.contentBody + 1),
        },
        analyzer,
      ),
    ).rejects.toBeInstanceOf(CreatorAnalysisRequestTooLargeError);

    expect(contentItemCreate).not.toHaveBeenCalled();
  });

  it("refuses a page that came back with nothing in it", async () => {
    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await expect(
      analyzeCreatorUrl(
        USER,
        { title: null, sourceUrl: PAGE_URL, body: "   " },
        analyzer,
      ),
    ).rejects.toSatisfy(isEmptyCreatorContent);

    expect(contentItemCreate).not.toHaveBeenCalled();
  });

  /** All or nothing, exactly as the paste path is. */
  it("writes nothing when the model fails", async () => {
    await expect(
      analyzeCreatorUrl(
        USER,
        { title: null, sourceUrl: PAGE_URL, body: "The page text." },
        failingAnalyzer(new ProviderError("unavailable", "no")),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(transaction).not.toHaveBeenCalled();
    expect(contentItemCreate).not.toHaveBeenCalled();
  });
});

/**
 * What the analyzer is told about answers too old to send one by one.
 *
 * **Two properties carry the whole design.** The summary and the recent twelve
 * never describe the same answer — the split is taken from one read and both
 * halves are measured against it — and nothing here can turn into a failed
 * analysis. A provider that times out, a row this version cannot read, a race
 * lost to another analysis and a batch too large to send all resolve to *less*
 * memory, never to less analysis.
 *
 * **At most one synthesis per analysis.** Catching up on a long history happens
 * across later analyses; making one of them pay for all of it would put the
 * slowest possible request in front of the call somebody is waiting for.
 */
describe("the summary of older answers", () => {
  const SUMMARY = "Has usually turned down promotional posts.";

  /** One stored row, as the database hands it back. */
  function storedRow(index: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `f-${index}`,
      createdAt: new Date(2026, 0, index + 1),
      action: "approve",
      editedBody: null,
      reason: null,
      editorialDecision: {
        id: `d-${index}`,
        targetChannel: "x",
        verdict: "recommend",
        reason: "It stands on its own.",
        userId: USER,
        draft: { body: "A short post.", userId: USER },
        contentItem: {
          title: `Piece ${index}`,
          body: "The body.",
          userId: USER,
        },
      },
      ...overrides,
    };
  }

  /** A history of `total` answers, newest first, as the partition read sees it. */
  function historyOf(total: number) {
    return Array.from({ length: Math.min(total, 13) }, (_, offset) =>
      storedRow(total - 1 - offset),
    );
  }

  /** A stored summary whose count and memberships agree, unless told otherwise. */
  function memoryRow(
    summary: string,
    derivedFromCount: number,
    evidence: number = derivedFromCount,
  ) {
    return {
      id: "memory-1",
      summary,
      derivedFromCount,
      _count: { evidence },
    };
  }

  function fakeSynthesizer(summary: string = SUMMARY) {
    const requests: unknown[] = [];

    return {
      requests,
      synthesizer: {
        synthesize: async (request: unknown) => {
          requests.push(structuredClone(request));
          return summary;
        },
      },
    };
  }

  /** What the memberships written in this analysis actually name. */
  function recordedFeedbackIds(): string[] {
    return evidenceCreateMany.mock.calls.flatMap((call: unknown[]) =>
      (call[0] as { data: { creatorFeedbackId: string }[] }).data.map(
        (row) => row.creatorFeedbackId,
      ),
    );
  }

  beforeEach(() => {
    memoryFindFirst.mockReset().mockResolvedValue(null);
    memoryCreate.mockReset().mockResolvedValue({ id: "memory-1" });
    memoryUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    evidenceCreateMany.mockReset().mockResolvedValue({ count: 0 });
    profileFindUnique.mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** Nothing has aged out, so there is nothing for a summary to stand for. */
  it.each([0, 12])("asks for none at %i answers", async (total) => {
    feedbackFindMany.mockResolvedValue(historyOf(total));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect(requests[0].memory).toBeNull();
    expect(requests[0].feedback).toHaveLength(total);
    expect(synthesised).toHaveLength(0);
  });

  /**
   * **The thirteenth answer is the first thing a summary is for.** It has just
   * left the window, and it is the only thing summarised — not the twelve that
   * are still being sent in full.
   */
  it("summarises only what has aged out", async () => {
    feedbackFindMany
      .mockResolvedValueOnce(historyOf(13))
      .mockResolvedValueOnce([storedRow(0)]);
    profileFindUnique.mockResolvedValue(PROFILE_ROW);

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect(synthesised).toHaveLength(1);
    expect((synthesised[0] as { previousSummary: unknown }).previousSummary).toBeNull();
    expect((synthesised[0] as { feedback: unknown[] }).feedback).toHaveLength(1);

    expect(requests[0].memory).toEqual({ summary: SUMMARY, derivedFromCount: 1 });
    expect(requests[0].feedback).toHaveLength(12);
    expect(recordedFeedbackIds()).toEqual(["f-0"]);
  });

  /**
   * **Which answers are outstanding is a question for the database, not for
   * arithmetic here.** The candidates are asked for by membership; nothing is
   * skipped, so nothing depends on an ordering staying put.
   */
  it("extends what is stored with the answers no membership names", async () => {
    feedbackFindMany
      .mockResolvedValueOnce(historyOf(20))
      .mockResolvedValueOnce([storedRow(6), storedRow(7)]);
    memoryFindFirst.mockResolvedValue(memoryRow("What was concluded before.", 6));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    const candidateQuery = feedbackFindMany.mock.calls[1][0];

    expect(candidateQuery.skip).toBeUndefined();
    expect(candidateQuery.where.memoryEvidence).toEqual({ is: null });

    expect((synthesised[0] as { previousSummary: unknown }).previousSummary).toBe(
      "What was concluded before.",
    );
    expect(memoryUpdateMany.mock.calls[0][0].where.derivedFromCount).toBe(6);
    expect(memoryUpdateMany.mock.calls[0][0].data.derivedFromCount).toBe(8);
    expect(recordedFeedbackIds()).toEqual(["f-6", "f-7"]);
    expect(requests[0].memory).toEqual({ summary: SUMMARY, derivedFromCount: 8 });
  });

  /**
   * **Scenario B, which the offset lost an answer to.**
   *
   * Two answers are already incorporated. A third, recorded in the same
   * millisecond range but committed late, becomes visible sorting *before* both
   * of them. Under the offset it was skipped over — permanently absent from the
   * summary and already gone from the recent twelve — and the answer after it
   * was summarised a second time. Membership has no position to be wrong about:
   * the late answer is exactly the one with no evidence, so it is the one that
   * gets sent, and the count moves by the one membership written.
   */
  it("picks up an answer that became visible after the ones already covered", async () => {
    const late = storedRow(0, { id: "f-a", createdAt: new Date(2026, 0, 1) });

    feedbackFindMany
      .mockResolvedValueOnce(historyOf(20))
      // What the database returns for "older side, and no membership": only the
      // late answer. The two already incorporated are excluded by their
      // evidence rows, not by counting past them.
      .mockResolvedValueOnce([late]);
    memoryFindFirst.mockResolvedValue(memoryRow("Covers b and c.", 2));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect((synthesised[0] as { feedback: unknown[] }).feedback).toHaveLength(1);
    expect(recordedFeedbackIds()).toEqual(["f-a"]);
    expect(memoryUpdateMany.mock.calls[0][0].data.derivedFromCount).toBe(3);
    expect(requests[0].memory).toEqual({ summary: SUMMARY, derivedFromCount: 3 });
  });

  /** Already covered: nothing to add, and nothing to pay for. */
  it("asks for nothing when no answer is outstanding", async () => {
    feedbackFindMany
      .mockResolvedValueOnce(historyOf(20))
      .mockResolvedValueOnce([]);
    memoryFindFirst.mockResolvedValue(memoryRow(SUMMARY, 8));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect(synthesised).toHaveLength(0);
    expect(memoryUpdateMany).not.toHaveBeenCalled();
    expect(requests[0].memory).toEqual({ summary: SUMMARY, derivedFromCount: 8 });
  });

  /**
   * **The count advances by the memberships written beside it, never by what
   * was outstanding.** Setting it to the full backlog would claim a summary
   * covers evidence the model never saw, and nothing afterwards could tell.
   */
  it("advances by the batch, leaving the rest for later", async () => {
    const batch = Array.from({ length: 12 }, (_, index) => storedRow(index));

    feedbackFindMany
      .mockResolvedValueOnce(historyOf(100))
      .mockResolvedValueOnce(batch);
    profileFindUnique.mockResolvedValue(PROFILE_ROW);

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect((synthesised[0] as { feedback: unknown[] }).feedback).toHaveLength(12);
    expect(memoryCreate.mock.calls[0][0].data.derivedFromCount).toBe(12);
    expect(recordedFeedbackIds()).toHaveLength(12);
    expect(requests[0].memory).toEqual({ summary: SUMMARY, derivedFromCount: 12 });
  });

  /** The count and the memberships are written together or not at all. */
  it("records exactly the answers it sent, and no others", async () => {
    const batch = Array.from({ length: 12 }, (_, index) => storedRow(index));

    feedbackFindMany
      .mockResolvedValueOnce(historyOf(100))
      .mockResolvedValueOnce(batch);
    profileFindUnique.mockResolvedValue(PROFILE_ROW);

    const { analyzer } = fakeAnalyzer(threeRecommendations);
    const { synthesizer } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect(recordedFeedbackIds()).toEqual(batch.map((row) => row.id));
    expect(new Set(recordedFeedbackIds()).size).toBe(12);
  });

  it("makes at most one synthesis call", async () => {
    feedbackFindMany
      .mockResolvedValueOnce(historyOf(100))
      .mockResolvedValueOnce(Array.from({ length: 12 }, (_, i) => storedRow(i)));
    profileFindUnique.mockResolvedValue(PROFILE_ROW);

    const { analyzer } = fakeAnalyzer(threeRecommendations);
    const { synthesizer, requests: synthesised } = fakeSynthesizer();

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, synthesizer);

    expect(synthesised).toHaveLength(1);
  });
});

/**
 * Every way the summary can go wrong, and the analysis surviving all of them.
 */
describe("when the summary cannot be brought up to date", () => {
  function historyOf(total: number) {
    return Array.from({ length: Math.min(total, 13) }, (_, offset) => ({
      id: `f-${total - 1 - offset}`,
      createdAt: new Date(2026, 0, total - offset),
      action: "approve",
      editedBody: null,
      reason: null,
      editorialDecision: {
        id: `d-${offset}`,
        targetChannel: "x",
        verdict: "recommend",
        reason: "It stands on its own.",
        userId: USER,
        draft: { body: "A short post.", userId: USER },
        contentItem: { title: "A piece", body: "The body.", userId: USER },
      },
    }));
  }

  function memoryRow(
    summary: string,
    derivedFromCount: number,
    evidence: number = derivedFromCount,
  ) {
    return { id: "memory-1", summary, derivedFromCount, _count: { evidence } };
  }

  beforeEach(() => {
    feedbackFindMany.mockResolvedValue(historyOf(20));
    memoryFindFirst.mockReset().mockResolvedValue(null);
    memoryCreate.mockReset().mockResolvedValue({ id: "memory-1" });
    memoryUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    evidenceCreateMany.mockReset().mockResolvedValue({ count: 0 });
    profileFindUnique.mockResolvedValue(PROFILE_ROW);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const failing = { synthesize: async () => { throw new ProviderError("timeout", "slow"); } };

  it("keeps what was stored and analyses anyway", async () => {
    memoryFindFirst.mockResolvedValue(memoryRow("An older conclusion.", 4));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, failing);

    expect(requests[0].memory).toEqual({
      summary: "An older conclusion.",
      derivedFromCount: 4,
    });
    expect(requests[0].feedback).toHaveLength(12);
  });

  it("sends none when there was none, and analyses anyway", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, failing);

    expect(requests[0].memory).toBeNull();
    expect(requests[0].feedback).toHaveLength(12);
  });

  it("analyses without one when the deployment cannot summarise", async () => {
    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, null);

    expect(requests[0].memory).toBeNull();
    expect(memoryCreate).not.toHaveBeenCalled();
  });

  /**
   * **The loser keeps what it validated, and does not adopt the winner's.**
   *
   * The winner's row was written after the only read this analysis did: its
   * count and its memberships have never been read together here, so sending it
   * would mean putting a number in front of somebody on the strength of a write
   * nothing checked. What *was* checked is still true, so that is what gets
   * used, and the next analysis reads the winner properly.
   */
  it("keeps its own validated summary rather than adopting the winner's", async () => {
    memoryUpdateMany.mockResolvedValue({ count: 0 });
    memoryFindFirst.mockResolvedValue(memoryRow("Mine.", 4));
    feedbackFindMany
      .mockResolvedValueOnce(historyOf(20))
      .mockResolvedValueOnce([
        {
          id: "f-5",
          createdAt: new Date(2026, 0, 1),
          action: "approve",
          editedBody: null,
          reason: null,
          editorialDecision: {
            id: "d-5",
            targetChannel: "x",
            verdict: "recommend",
            reason: "It stands on its own.",
            userId: USER,
            draft: { body: "A short post.", userId: USER },
            contentItem: { title: "A piece", body: "The body.", userId: USER },
          },
        },
      ]);

    let calls = 0;
    const counting = {
      synthesize: async () => {
        calls += 1;
        return "A conclusion.";
      },
    };

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, counting);

    expect(calls).toBe(1);
    expect(memoryFindFirst).toHaveBeenCalledTimes(1);
    expect(requests[0].memory).toEqual({ summary: "Mine.", derivedFromCount: 4 });
  });

  /**
   * **A count that disagrees with its memberships describes evidence nobody can
   * name.** One of the two is wrong and there is no way to tell which, so the
   * summary is left out of this analysis rather than sent with a number that
   * may not mean what it says.
   */
  it.each([
    ["more than the memberships", 8, 5],
    ["fewer than the memberships", 5, 8],
  ])("leaves out a summary counting %s", async (_name, count, evidence) => {
    memoryFindFirst.mockResolvedValue(memoryRow("A conclusion.", count, evidence));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);
    let calls = 0;

    await analyzeCreatorText(
      USER,
      { title: null, body: "b" },
      analyzer,
      { synthesize: async () => { calls += 1; return "x"; } },
    );

    expect(requests[0].memory).toBeNull();
    expect(calls).toBe(0);
  });

  /**
   * **Nothing is repaired and nothing is rewritten downward.** The summary
   * really was built from whatever it was built from; adjusting the count to
   * match would erase the disagreement without explaining it.
   */
  it("neither repairs nor rewrites a summary whose count disagrees", async () => {
    memoryFindFirst.mockResolvedValue(memoryRow("A conclusion.", 8, 5));

    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, null);

    expect(memoryUpdateMany).not.toHaveBeenCalled();
    expect(memoryCreate).not.toHaveBeenCalled();
    expect(evidenceCreateMany).not.toHaveBeenCalled();
  });

  /** The column defaults: a row that exists but stands for nothing yet. */
  it("leaves out a summary that is still empty", async () => {
    memoryFindFirst.mockResolvedValue(memoryRow("", 0, 0));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, null);

    expect(requests[0].memory).toBeNull();
    expect(memoryUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves out a stored summary it cannot read", async () => {
    memoryFindFirst.mockResolvedValue(memoryRow("   ", 4));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, null);

    expect(requests[0].memory).toBeNull();
  });

  it("analyses anyway when the memory read itself fails", async () => {
    memoryFindFirst.mockRejectedValue(new Error("connection lost"));

    const { analyzer, requests } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, null);

    expect(requests[0].memory).toBeNull();
    expect(contentItemCreate).toHaveBeenCalled();
  });

  it("analyses anyway when the summary cannot be written", async () => {
    memoryUpdateMany.mockRejectedValue(new Error("connection lost"));
    memoryFindFirst.mockResolvedValue(memoryRow("Before.", 4));
    feedbackFindMany
      .mockResolvedValueOnce(historyOf(20))
      .mockResolvedValueOnce([]);

    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(
      USER,
      { title: null, body: "b" },
      analyzer,
      { synthesize: async () => "A conclusion." },
    );

    expect(contentItemCreate).toHaveBeenCalled();
  });

  /** Nothing about anybody's writing reaches a log line. */
  it("logs a category and never any of the writing", async () => {
    memoryFindFirst.mockResolvedValue(memoryRow("SECRET-STORED-SUMMARY", 8, 5));

    const { analyzer } = fakeAnalyzer(threeRecommendations);

    await analyzeCreatorText(USER, { title: null, body: "b" }, analyzer, null);

    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    );

    expect(logged).toContain("[creator] memory");
    expect(logged).not.toContain("SECRET-STORED-SUMMARY");
  });
});
