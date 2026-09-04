import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The outside edge of the Creator loop.
 *
 * What is fixed here is the boundary and nothing beyond it: who the work is
 * filed under, what has to happen before a model is asked, and what is allowed
 * to travel back out. The rules about what a good decision is and what a valid
 * history looks like belong to `lib/creator` and are tested there; repeating
 * them would mean two places to change when one of them moves.
 *
 * **No request can leave.** The analyzer arrives from a factory that is stood
 * in for, so nothing here has a path to Anthropic even if a key happened to be
 * in the environment.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  getUserLanguage: vi.fn(),
  createCreatorAnalyzer: vi.fn(),
  consumeCreatorAnalysisQuota: vi.fn(),
  analyzeCreatorText: vi.fn(),
  recordCreatorFeedback: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
}));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/lib/creator/creator-analyzer-factory", () => ({
  createCreatorAnalyzer: mocks.createCreatorAnalyzer,
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeCreatorAnalysisQuota: mocks.consumeCreatorAnalysisQuota,
}));

// **The service and the repository are the real modules**, except for the two
// entry points these actions call. Their error predicates have to be the real
// ones, or a test could pass against a taxonomy that does not exist.
vi.mock("@/lib/creator/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/creator/service")>()),
  analyzeCreatorText: mocks.analyzeCreatorText,
  recordCreatorFeedback: mocks.recordCreatorFeedback,
}));

const { analyzeCreatorTextAction, recordCreatorFeedbackAction } = await import(
  "@/app/creator/actions"
);
const { en } = await import("@/lib/i18n/en");
const {
  CreatorAnalysisRequestTooLargeError,
  creatorAnalysisLimits,
  InvalidCreatorAnalysisResponseError,
} = await import("@/lib/creator/analyzer");
const {
  CreatorDecisionNotFoundError,
  CreatorFeedbackAlreadyRecordedError,
  InvalidCreatorFeedbackHistoryError,
} = await import("@/lib/creator/repository");
const { EmptyCreatorContentError, InvalidCreatorFeedbackError } = await import(
  "@/lib/creator/service"
);
const { ProviderError } = await import("@/lib/ai/provider");

const USER = "google-sub-1";
const SECRET_BODY = "UNPUBLISHED-BODY-abc123";
const SECRET_TITLE = "UNPUBLISHED-TITLE-abc123";

/** A stand-in analyzer. It is never called: the service is replaced too. */
const analyzer = { analyze: vi.fn() };

class NotFoundSignal extends Error {}

function analysisForm(fields: Record<string, string> = {}) {
  const data = new FormData();
  data.set("title", SECRET_TITLE);
  data.set("body", SECRET_BODY);
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function feedbackForm(fields: Record<string, string> = {}) {
  const data = new FormData();
  data.set("editorialDecisionId", "decision-1");
  data.set("action", "approve");
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

/** Everything written to the log during one call, joined for searching. */
function capturedLog(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((call) => call.map((part) => String(part)).join(" "))
    .join("\n");
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.createCreatorAnalyzer.mockReset().mockReturnValue(analyzer);
  mocks.consumeCreatorAnalysisQuota.mockReset().mockResolvedValue(true);
  mocks.analyzeCreatorText
    .mockReset()
    .mockResolvedValue({ contentItemId: "content-1", result: {} });
  mocks.recordCreatorFeedback.mockReset().mockResolvedValue({ id: "feedback-1" });
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  });
  analyzer.analyze.mockReset();
});

describe("who the analysis is filed under", () => {
  /**
   * **The one thing a form must never be able to say.** An owner taken from
   * submitted fields would let anybody file work under anybody, and every
   * ownership check downstream would be checking a value the attacker chose.
   */
  it("ignores any owner the form tries to name", async () => {
    await analyzeCreatorTextAction(
      null,
      analysisForm({ userId: "google-sub-2", ownerId: "google-sub-2" }),
    );

    expect(mocks.analyzeCreatorText.mock.calls[0][0]).toBe(USER);
  });

  /**
   * **The provisioned id is the one that travels.** Two boundaries answer with
   * the same account, but only one of them promises the row exists — and a
   * foreign key may only point at a row that does.
   */
  it("passes on the id the provisioning boundary returned, and only that", async () => {
    mocks.requireUserId.mockResolvedValue("google-sub-read");
    mocks.requireProvisionedUserId.mockResolvedValue("google-sub-9");

    await analyzeCreatorTextAction(null, analysisForm());

    expect(mocks.analyzeCreatorText.mock.calls[0][0]).toBe("google-sub-9");
    expect(mocks.consumeCreatorAnalysisQuota.mock.calls[0][0]).toBe("google-sub-9");
  });

  /**
   * Both session boundaries redirect by throwing, and a general catch around
   * either would turn a signed-out visitor into an error message on a page they
   * are not allowed to see. `UserProvisioningError` leaves the same way, for
   * the same reason: nothing has been spent and no model has been asked.
   */
  it("lets the sign-in redirect through, from either boundary", async () => {
    class RedirectSignal extends Error {}

    mocks.requireUserId.mockRejectedValue(new RedirectSignal("NEXT_REDIRECT"));
    await expect(analyzeCreatorTextAction(null, analysisForm())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();

    mocks.requireUserId.mockResolvedValue(USER);
    mocks.requireProvisionedUserId.mockRejectedValue(
      new RedirectSignal("NEXT_REDIRECT"),
    );
    await expect(analyzeCreatorTextAction(null, analysisForm())).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mocks.consumeCreatorAnalysisQuota).not.toHaveBeenCalled();
    expect(mocks.analyzeCreatorText).not.toHaveBeenCalled();
  });

  it("sends the form's own fields through unchanged", async () => {
    await analyzeCreatorTextAction(null, analysisForm());

    expect(mocks.analyzeCreatorText.mock.calls[0][1]).toEqual({
      title: SECRET_TITLE,
      body: SECRET_BODY,
    });
  });

  /** C1 has one way in; a client-chosen provenance would be a claim nothing checks. */
  it("lets no source, channel or verdict be chosen by the form", async () => {
    await analyzeCreatorTextAction(
      null,
      analysisForm({
        sourceKind: "url",
        sourceUrl: "https://example.com/x",
        targetChannel: "x",
        verdict: "recommend",
      }),
    );

    expect(Object.keys(mocks.analyzeCreatorText.mock.calls[0][1]).sort()).toEqual([
      "body",
      "title",
    ]);
  });

  it("hands the analyzer the factory built to the service", async () => {
    await analyzeCreatorTextAction(null, analysisForm());

    expect(mocks.analyzeCreatorText.mock.calls[0][2]).toBe(analyzer);
  });
});

/**
 * **A rejected submission must not create the account row.**
 *
 * `requireProvisionedUserId` reads like an identity check with a longer name
 * and is not one: it writes, through `ensureUser`. Asking for it before the
 * obvious refusals means somebody who pressed the button with an empty box has
 * an account row they never asked for — and the row is the thing the
 * provisioning boundary exists to defer. Identity for the *wording* of a
 * refusal comes from `requireUserId`, which reads and writes nothing.
 *
 * These are ordering assertions, so each names what must **not** have happened.
 */
describe("before anything is written down", () => {
  const invalid: [string, Record<string, string>][] = [
    ["an empty body", { body: "" }],
    ["a whitespace body", { body: "   " }],
    ["a body of newlines and tabs", { body: "\n\t" }],
    [
      "a body past the limit",
      { body: "b".repeat(creatorAnalysisLimits.contentBody + 1) },
    ],
    [
      "a title past the limit",
      { title: "t".repeat(creatorAnalysisLimits.contentTitle + 1) },
    ],
  ];

  it.each(invalid)("provisions no account row for %s", async (_name, fields) => {
    const result = await analyzeCreatorTextAction(null, analysisForm(fields));

    expect(result?.status).toBe("error");
    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
    expect(mocks.createCreatorAnalyzer).not.toHaveBeenCalled();
    expect(mocks.consumeCreatorAnalysisQuota).not.toHaveBeenCalled();
    expect(mocks.analyzeCreatorText).not.toHaveBeenCalled();
  });

  /** Who is asking is still known — that is what the read-only check is for. */
  it("still identifies the account, read-only, to word the refusal", async () => {
    await analyzeCreatorTextAction(null, analysisForm({ body: "" }));

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
    expect(mocks.getUserLanguage).toHaveBeenCalledWith(USER);
    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "\n\t"])(
    "refuses a body of %o with the empty-content wording",
    async (body) => {
      const result = await analyzeCreatorTextAction(null, analysisForm({ body }));

      expect(result).toEqual({ status: "error", message: en["creator.analysis.empty"] });
    },
  );

  it("refuses a body past the limit", async () => {
    const result = await analyzeCreatorTextAction(
      null,
      analysisForm({ body: "b".repeat(creatorAnalysisLimits.contentBody + 1) }),
    );

    expect(result).toEqual({
      status: "error",
      message: en["creator.analysis.tooLong"],
    });
  });

  it("refuses a title past the limit", async () => {
    const result = await analyzeCreatorTextAction(
      null,
      analysisForm({ title: "t".repeat(creatorAnalysisLimits.contentTitle + 1) }),
    );

    expect(result?.status).toBe("error");
  });

  /**
   * The whole order in one assertion. Validation first because a refusal must
   * cost nothing; provisioning next because the row has to exist before an
   * allowance can point at it; the allowance before the model because what it
   * protects against is the asking.
   */
  it("runs validation, then provisioning, then the factory, quota and model", async () => {
    const order: string[] = [];

    mocks.requireUserId.mockImplementation(async () => {
      order.push("identify");
      return USER;
    });
    mocks.requireProvisionedUserId.mockImplementation(async () => {
      order.push("provision");
      return USER;
    });
    mocks.createCreatorAnalyzer.mockImplementation(() => {
      order.push("factory");
      return analyzer;
    });
    mocks.consumeCreatorAnalysisQuota.mockImplementation(async () => {
      order.push("quota");
      return true;
    });
    mocks.analyzeCreatorText.mockImplementation(async () => {
      order.push("analyze");
      return { contentItemId: "content-1", result: {} };
    });

    await analyzeCreatorTextAction(null, analysisForm());

    expect(order).toEqual([
      "identify",
      "provision",
      "factory",
      "quota",
      "analyze",
    ]);
  });

  /** The row exists by the time the analyzer is even chosen. */
  it("provisions before the factory is asked for an analyzer", async () => {
    await analyzeCreatorTextAction(null, analysisForm());

    expect(mocks.requireProvisionedUserId).toHaveBeenCalledTimes(1);
    expect(
      mocks.requireProvisionedUserId.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.createCreatorAnalyzer.mock.invocationCallOrder[0]);
  });

  /**
   * **No stand-in, and no charge for a feature that is not there.** An invented
   * editorial judgement reads exactly like a real one, and somebody would
   * publish it.
   */
  it("stops when no analyzer is configured, before the allowance moves", async () => {
    mocks.createCreatorAnalyzer.mockReturnValue(null);

    const result = await analyzeCreatorTextAction(null, analysisForm());

    expect(result).toEqual({
      status: "error",
      message: en["creator.analysis.notConfigured"],
    });
    expect(mocks.consumeCreatorAnalysisQuota).not.toHaveBeenCalled();
    expect(mocks.analyzeCreatorText).not.toHaveBeenCalled();
  });
});

describe("the allowance", () => {
  it("is spent before the model is asked", async () => {
    const order: string[] = [];
    mocks.consumeCreatorAnalysisQuota.mockImplementation(async () => {
      order.push("quota");
      return true;
    });
    mocks.analyzeCreatorText.mockImplementation(async () => {
      order.push("analyze");
      return { contentItemId: "content-1", result: {} };
    });

    await analyzeCreatorTextAction(null, analysisForm());

    expect(order).toEqual(["quota", "analyze"]);
  });

  it("stops the analysis when it is spent", async () => {
    mocks.consumeCreatorAnalysisQuota.mockResolvedValue(false);

    const result = await analyzeCreatorTextAction(null, analysisForm());

    expect(result).toEqual({
      status: "error",
      message: en["creator.analysis.limitReached"],
    });
    expect(mocks.analyzeCreatorText).not.toHaveBeenCalled();
  });

  /**
   * **Fail closed.** Not knowing how much allowance is left is not the same as
   * knowing there is some, so a database that will not answer stops the request
   * rather than waving it through.
   */
  it("stops the analysis when it cannot be read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.consumeCreatorAnalysisQuota.mockRejectedValue(
      new Error("connection terminated: relation RateLimitBucket"),
    );

    const result = await analyzeCreatorTextAction(null, analysisForm());

    expect(result).toEqual({
      status: "error",
      message: en["creator.analysis.failed"],
    });
    expect(mocks.analyzeCreatorText).not.toHaveBeenCalled();
    expect(result?.message).not.toContain("RateLimitBucket");

    spy.mockRestore();
  });
});

describe("what comes back", () => {
  it("reports a completed reading and nothing about the writing", async () => {
    const result = await analyzeCreatorTextAction(null, analysisForm());

    expect(result).toEqual({
      status: "success",
      message: en["creator.analysis.done"],
    });
  });

  /**
   * **The message is the whole of the answer.** Drafts and decisions are
   * unpublished writing; putting them in a form's state would be deciding on
   * somebody's behalf where their work travels.
   */
  it("returns no draft, decision or content of any kind", async () => {
    mocks.analyzeCreatorText.mockResolvedValue({
      contentItemId: "content-1",
      result: {
        x: { verdict: "recommend", reason: "r", draftBody: "SECRET-DRAFT" },
        reddit: { verdict: "skip", reason: "r", draftBody: null },
        longform: { verdict: "skip", reason: "r", draftBody: null },
      },
    });

    const result = await analyzeCreatorTextAction(null, analysisForm());

    expect(JSON.stringify(result)).not.toContain("SECRET-DRAFT");
    expect(Object.keys(result ?? {}).sort()).toEqual(["message", "status"]);
  });

  /**
   * Each failure gets a sentence the reader can act on, and **none of them
   * quotes what came from a model, a driver or a stored row**. The log is
   * checked too: a category is useful there, unpublished writing is not.
   */
  it.each([
    [
      "a provider timeout",
      new ProviderError("timeout", "upstream took 61s at api.anthropic.com"),
      en["creator.analysis.timeout"],
    ],
    [
      "a provider outage",
      new ProviderError("unavailable", "503 from api.anthropic.com"),
      en["creator.analysis.unavailable"],
    ],
    [
      "a refusal",
      new ProviderError("refused", "declined"),
      en["creator.analysis.unavailable"],
    ],
    [
      "an unusable answer",
      new InvalidCreatorAnalysisResponseError("x recommends posting but wrote no draft"),
      en["creator.analysis.unreadable"],
    ],
    [
      "an unusable history",
      new InvalidCreatorFeedbackHistoryError("decision-7", "unknown-channel"),
      en["creator.analysis.failed"],
    ],
    [
      "a database that would not commit",
      new Error("connection terminated: table ContentItem"),
      en["creator.analysis.failed"],
    ],
    [
      "the service refusing an empty body",
      new EmptyCreatorContentError(),
      en["creator.analysis.empty"],
    ],
    [
      "the service refusing an oversized request",
      new CreatorAnalysisRequestTooLargeError("content.body", 40_000, 40_001),
      en["creator.analysis.tooLong"],
    ],
  ])("turns %s into a safe message", async (_name, thrown, expected) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.analyzeCreatorText.mockRejectedValue(thrown);

    const result = await analyzeCreatorTextAction(null, analysisForm());

    expect(result).toEqual({ status: "error", message: expected });

    const message = result?.message ?? "";
    for (const leak of [
      "api.anthropic.com",
      "ContentItem",
      "wrote no draft",
      "unknown-channel",
      SECRET_BODY,
      SECRET_TITLE,
    ]) {
      expect(message).not.toContain(leak);
    }

    const log = capturedLog(spy);
    expect(log).not.toContain(SECRET_BODY);
    expect(log).not.toContain(SECRET_TITLE);

    spy.mockRestore();
  });

  it("logs a category rather than the answer it could not read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.analyzeCreatorText.mockRejectedValue(
      new InvalidCreatorAnalysisResponseError("SECRET-MODEL-TEXT"),
    );

    await analyzeCreatorTextAction(null, analysisForm());

    expect(capturedLog(spy)).not.toContain("SECRET-MODEL-TEXT");

    spy.mockRestore();
  });

  it("logs the decision id but nothing an unusable history contained", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.analyzeCreatorText.mockRejectedValue(
      new InvalidCreatorFeedbackHistoryError("decision-7", "unknown-channel"),
    );

    await analyzeCreatorTextAction(null, analysisForm());

    const log = capturedLog(spy);
    expect(log).toContain("decision-7");
    expect(log).not.toContain(SECRET_BODY);

    spy.mockRestore();
  });

  it("answers in the account's own language", async () => {
    const { ja } = await import("@/lib/i18n/ja");
    mocks.getUserLanguage.mockResolvedValue("ja");

    const result = await analyzeCreatorTextAction(null, analysisForm({ body: "" }));

    expect(result?.message).toBe(ja["creator.analysis.empty"]);
  });
});

/** Nothing in this file can reach Anthropic, whatever the environment holds. */
describe("the model", () => {
  it("is never called from here", async () => {
    await analyzeCreatorTextAction(null, analysisForm());

    expect(analyzer.analyze).not.toHaveBeenCalled();
  });
});

describe("recording an answer", () => {
  it("files it under the session's owner, never the form's", async () => {
    await recordCreatorFeedbackAction(
      null,
      feedbackForm({ userId: "google-sub-2" }),
    );

    expect(mocks.recordCreatorFeedback.mock.calls[0][0]).toBe(USER);
    expect(mocks.recordCreatorFeedback.mock.calls[0][1]).toBe("decision-1");
  });

  it.each(["approve", "reject"] as const)("passes on a plain %s", async (action) => {
    await recordCreatorFeedbackAction(null, feedbackForm({ action }));

    expect(mocks.recordCreatorFeedback.mock.calls[0][2]).toEqual({
      action,
      editedBody: null,
      reason: null,
    });
  });

  it("passes on an edit with what was written", async () => {
    await recordCreatorFeedbackAction(
      null,
      feedbackForm({ action: "edit", editedBody: "What I wanted.", reason: "Too salesy." }),
    );

    expect(mocks.recordCreatorFeedback.mock.calls[0][2]).toEqual({
      action: "edit",
      editedBody: "What I wanted.",
      reason: "Too salesy.",
    });
  });

  it("reports a saved answer", async () => {
    const result = await recordCreatorFeedbackAction(null, feedbackForm());

    expect(result).toEqual({
      status: "success",
      message: en["creator.feedback.saved"],
    });
  });

  /**
   * **Somebody else's decision and one that does not exist get the same
   * answer.** Telling them apart would confirm the existence of another
   * account's work to anyone willing to guess ids.
   */
  it.each([
    ["a decision that does not exist", new CreatorDecisionNotFoundError()],
    ["a decision belonging to somebody else", new CreatorDecisionNotFoundError()],
  ])("answers %s with a 404", async (_name, thrown) => {
    mocks.recordCreatorFeedback.mockRejectedValue(thrown);

    await expect(
      recordCreatorFeedbackAction(null, feedbackForm()),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("answers a missing decision id with the same 404", async () => {
    await expect(
      recordCreatorFeedbackAction(null, feedbackForm({ editorialDecisionId: "" })),
    ).rejects.toBeInstanceOf(NotFoundSignal);
    expect(mocks.recordCreatorFeedback).not.toHaveBeenCalled();
  });

  /** Append-only: the earlier answer stands and is not rewritten. */
  it("reports an answer that was already given", async () => {
    mocks.recordCreatorFeedback.mockRejectedValue(
      new CreatorFeedbackAlreadyRecordedError(),
    );

    const result = await recordCreatorFeedbackAction(null, feedbackForm());

    expect(result).toEqual({
      status: "error",
      message: en["creator.feedback.alreadyRecorded"],
    });
  });

  it("reports an answer that does not fit the decision", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recordCreatorFeedback.mockRejectedValue(
      new InvalidCreatorFeedbackError("edit-of-skip"),
    );

    const result = await recordCreatorFeedbackAction(
      null,
      feedbackForm({ action: "edit", editedBody: "SECRET-EDIT" }),
    );

    expect(result).toEqual({
      status: "error",
      message: en["creator.feedback.invalid"],
    });
    expect(capturedLog(spy)).not.toContain("SECRET-EDIT");

    spy.mockRestore();
  });

  it("refuses an action this version does not know, without asking the service", async () => {
    const result = await recordCreatorFeedbackAction(
      null,
      feedbackForm({ action: "undo" }),
    );

    expect(result).toEqual({
      status: "error",
      message: en["creator.feedback.invalid"],
    });
    expect(mocks.recordCreatorFeedback).not.toHaveBeenCalled();
  });

  it("keeps a database failure to itself", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recordCreatorFeedback.mockRejectedValue(
      new Error("connection terminated: table CreatorFeedback"),
    );

    const result = await recordCreatorFeedbackAction(null, feedbackForm());

    expect(result).toEqual({
      status: "error",
      message: en["creator.feedback.failed"],
    });
    expect(result?.message).not.toContain("CreatorFeedback");

    spy.mockRestore();
  });

  /**
   * **No allowance and no model.** This writes one row about a judgement that
   * already exists; charging for it would make disagreeing with Koqentra cost
   * the same as asking it a question.
   */
  it("spends nothing and asks nobody", async () => {
    await recordCreatorFeedbackAction(null, feedbackForm());

    expect(mocks.consumeCreatorAnalysisQuota).not.toHaveBeenCalled();
    expect(mocks.createCreatorAnalyzer).not.toHaveBeenCalled();
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it("lets the sign-in redirect through", async () => {
    class RedirectSignal extends Error {}
    mocks.requireUserId.mockRejectedValue(new RedirectSignal("NEXT_REDIRECT"));

    await expect(
      recordCreatorFeedbackAction(null, feedbackForm()),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.recordCreatorFeedback).not.toHaveBeenCalled();
  });

  /**
   * **The same rule as the analysis action, for the same reason.** An answer
   * this version cannot read, or one naming no decision at all, is turned away
   * — and turning it away must not be what creates the account row.
   */
  it.each([
    ["an unreadable action", { action: "undo" }],
    ["no decision at all", { editorialDecisionId: "" }],
  ])("provisions no account row for %s", async (_name, fields) => {
    await recordCreatorFeedbackAction(null, feedbackForm(fields)).catch(
      () => undefined,
    );

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
    expect(mocks.recordCreatorFeedback).not.toHaveBeenCalled();
  });

  it("provisions before writing, and writes under that id", async () => {
    mocks.requireUserId.mockResolvedValue("google-sub-read");
    mocks.requireProvisionedUserId.mockResolvedValue("google-sub-9");

    await recordCreatorFeedbackAction(null, feedbackForm());

    expect(mocks.recordCreatorFeedback.mock.calls[0][0]).toBe("google-sub-9");
    expect(
      mocks.requireProvisionedUserId.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.recordCreatorFeedback.mock.invocationCallOrder[0]);
  });
});
