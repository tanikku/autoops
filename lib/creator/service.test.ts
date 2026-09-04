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
  feedbackCreate,
  decisionFindFirst,
  decisionCreate,
  contentItemCreate,
  draftCreate,
  transaction,
} = vi.hoisted(() => ({
  profileFindUnique: vi.fn(),
  feedbackFindMany: vi.fn(),
  feedbackCreate: vi.fn(),
  decisionFindFirst: vi.fn(),
  decisionCreate: vi.fn(),
  contentItemCreate: vi.fn(),
  draftCreate: vi.fn(),
  transaction: vi.fn(),
}));

const profileUpsert = vi.fn();

const tx = {
  creatorProfile: { upsert: profileUpsert },
  contentItem: { create: contentItemCreate },
  editorialDecision: { create: decisionCreate },
  contentDraft: { create: draftCreate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    creatorProfile: { findUnique: profileFindUnique, upsert: profileUpsert },
    creatorFeedback: { findMany: feedbackFindMany, create: feedbackCreate },
    editorialDecision: { findFirst: decisionFindFirst, create: decisionCreate },
    contentItem: { create: contentItemCreate },
    contentDraft: { create: draftCreate },
    $transaction: transaction,
  },
}));

const {
  analyzeCreatorText,
  isEmptyCreatorContent,
  isInvalidCreatorFeedback,
  recordCreatorFeedback,
} = await import("@/lib/creator/service");

const { isCreatorDecisionNotFound } = await import("@/lib/creator/repository");

const USER = "google-sub-1";

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
