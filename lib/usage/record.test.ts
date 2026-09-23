import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_PROVIDER_USAGE,
  type ProviderUsageEventInput,
} from "@/lib/usage/types";

/**
 * Writing down what one call to a model used.
 *
 * **Three of the six features call this now.** A prompt worker, a website
 * worker that found a change, and a discovery worker that asked a model all
 * record what their call used; drafting and the two Creator features still
 * discard it, and wiring those up is a later phase. What is fixed here is the
 * write itself — the columns it fills, the ones it has no way to fill, and that
 * a failure to write goes no further than a log line.
 *
 * **Best-effort is a contract, not a shortcut.** If this threw, a run that
 * succeeded would be recorded as failed, a draft somebody was waiting for would
 * disappear, and an analysis that cost real money would be reported as not
 * having happened — all because a bookkeeping row could not be written.
 * Observation that changes what it observes is worth less than none.
 */

const {
  create,
  usagePeriodFindUnique,
  usagePeriodCreate,
  usageUpdateMany,
  subscriptionFindUnique,
} = vi.hoisted(() => ({
  create: vi.fn(),
  usagePeriodFindUnique: vi.fn(),
  usagePeriodCreate: vi.fn(),
  usageUpdateMany: vi.fn(),
  subscriptionFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    providerUsageEvent: { create },
    // Reached through the real observation helper rather than a stub of it, so
    // what the tests below fix is the counter a call actually moves.
    usagePeriod: {
      findUnique: usagePeriodFindUnique,
      create: usagePeriodCreate,
    },
    usageCounter: { updateMany: usageUpdateMany },
    // Which window a call is counted against is read before the counter is
    // moved — see `resolveUsageWindow`. These tests describe accounts with no
    // entitlement, so the answer is the calendar month.
    subscription: { findUnique: subscriptionFindUnique },
  },
}));

const { recordAIExecution, recordAIFailure, recordProviderUsage } = await import(
  "@/lib/usage/record"
);
const { ProviderError } = await import("@/lib/ai/provider");

const OCCURRED_AT = new Date("2026-09-20T12:00:00.000Z");
const USER = "google-sub-1";

function event(
  overrides: Partial<ProviderUsageEventInput> = {},
): ProviderUsageEventInput {
  return {
    userId: USER,
    occurredAt: OCCURRED_AT,
    feature: "prompt",
    provider: "anthropic",
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
    outcome: "ok",
    runId: "run-1",
    ...overrides,
  };
}

const OBSERVED_PERIOD = {
  id: "usage-period-1",
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2026-10-01T00:00:00.000Z"),
  planAtStart: "beta",
  counters: [
    { kind: "aiProcessing", used: 0, limit: 300 },
    { kind: "manualRun", used: 0, limit: 300 },
    { kind: "discovery", used: 0, limit: 150 },
  ],
};

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({});
  usagePeriodFindUnique.mockReset().mockResolvedValue(OBSERVED_PERIOD);
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
  usagePeriodCreate.mockReset().mockResolvedValue(OBSERVED_PERIOD);
  usageUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The data of the only `create`. */
function written() {
  return create.mock.calls[0][0].data;
}

describe("what is written down", () => {
  it("records the call as it was described", async () => {
    await recordProviderUsage(event());

    expect(written()).toEqual({
      userId: USER,
      occurredAt: OCCURRED_AT,
      feature: "prompt",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      outcome: "ok",
      runId: "run-1",
    });
  });

  /**
   * **Null and zero are both kept, and they mean different things.** A provider
   * that reported no cached reads said something; one that reported nothing at
   * all did not. Collapsing the second into `0` would make a call of unknown
   * cost indistinguishable from a free one, for good.
   */
  it("keeps a reported zero apart from an unknown", async () => {
    await recordProviderUsage(event());

    expect(written().cacheReadTokens).toBe(0);
    expect(written().cacheWriteTokens).toBeNull();
  });

  it("writes nulls rather than zeroes when a call reported no usage", async () => {
    await recordProviderUsage(
      event({ outcome: "error", usage: UNKNOWN_PROVIDER_USAGE }),
    );

    expect(written().inputTokens).toBeNull();
    expect(written().outputTokens).toBeNull();
    expect(written().cacheReadTokens).toBeNull();
    expect(written().cacheWriteTokens).toBeNull();
  });

  /**
   * **A run id when there is a run, and null when there is not.** Drafts and
   * Creator analyses write no run history at all, and inventing an id for them
   * would be a claim about something that does not exist.
   */
  it.each(["draft", "creator-analysis", "creator-memory"] as const)(
    "leaves the run empty for %o",
    async (feature) => {
      await recordProviderUsage(event({ feature, runId: null }));

      expect(written().runId).toBeNull();
    },
  );

  it.each(["prompt", "website", "discovery"] as const)(
    "keeps the run it belonged to for %o",
    async (feature) => {
      await recordProviderUsage(event({ feature, runId: "run-7" }));

      expect(written().runId).toBe("run-7");
    },
  );
});

/**
 * **Knowing what a call cost has never required keeping what it said.** The
 * input has nowhere to put a prompt, an answer, an address, a key, a header or
 * a provider's raw response, which is the only reliable way to keep them out.
 */
describe("what is never written down", () => {
  it("writes exactly the columns it is meant to and no others", async () => {
    await recordProviderUsage(event());

    expect(Object.keys(written())).toEqual([
      "userId",
      "occurredAt",
      "feature",
      "provider",
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outcome",
      "runId",
    ]);
  });

  it.each([
    "prompt",
    "output",
    "body",
    "url",
    "apiKey",
    "headers",
    "response",
    "error",
    "stack",
  ])("has no column called %o", async (column) => {
    await recordProviderUsage(event());

    expect(Object.keys(written())).not.toContain(column);
  });
});

describe("when the row cannot be written", () => {
  /**
   * The property this phase exists to establish: the caller carries on. Nothing
   * about a run, a draft or an analysis changes because bookkeeping failed.
   */
  it("does not throw", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await expect(recordProviderUsage(event())).resolves.toBeUndefined();
  });

  it("says so once, naming the path rather than the call", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await recordProviderUsage(event({ feature: "website", outcome: "error" }));

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];

    expect(logged).toContain("website");
    expect(logged).toContain("error");
  });

  /**
   * **A log line is a place material ends up just as much as a column is.** The
   * event is not logged, so a failing write cannot become the leak the table
   * was shaped to avoid.
   */
  it("does not log the event itself", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await recordProviderUsage(event());

    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0],
    );

    expect(logged).not.toContain(USER);
    expect(logged).not.toContain("run-1");
  });
});

/**
 * Turning what a provider handed back into a row, or into nothing.
 *
 * **Most of what these fix is the nothing.** Six features will eventually call
 * a model and every one of them can also fail before reaching one; a row for
 * any of those would be an invented charge in the only table whose purpose is
 * to say what things really cost. The decision lives here rather than at each
 * call site, so there is one place to get it right instead of six chances to
 * forget.
 */
describe("recording a call that succeeded", () => {
  const anthropicResult = {
    provider: "anthropic" as const,
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
  };

  it("writes the call, with the context the provider never knew", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      anthropicResult,
      OCCURRED_AT,
    );

    expect(written()).toEqual({
      userId: USER,
      occurredAt: OCCURRED_AT,
      feature: "prompt",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      outcome: "ok",
      runId: "run-1",
    });
  });

  it("takes the model from the provider rather than from the caller", async () => {
    await recordAIExecution(
      { userId: USER, feature: "website", runId: "run-2" },
      { ...anthropicResult, model: "claude-something-else" },
      OCCURRED_AT,
    );

    expect(written().model).toBe("claude-something-else");
  });

  it.each(["prompt", "website", "discovery"] as const)(
    "records %o against the run it belonged to",
    async (feature) => {
      await recordAIExecution(
        { userId: USER, feature, runId: "run-9" },
        anthropicResult,
        OCCURRED_AT,
      );

      expect(written().feature).toBe(feature);
      expect(written().runId).toBe("run-9");
    },
  );

  /**
   * **The stand-in is refused here, once, for everybody.** Nothing was sent and
   * nothing was charged; a row saying otherwise would be a fabricated answer
   * recorded as a purchase.
   */
  it("writes nothing for the stand-in provider", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      {
        provider: "dummy",
        model: "stand-in",
        usage: null,
      },
      OCCURRED_AT,
    );

    expect(create).not.toHaveBeenCalled();
  });

  /** Either condition alone is enough, and this is the other one. */
  it("writes nothing for a result that reports no usage", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      { ...anthropicResult, usage: null },
      OCCURRED_AT,
    );

    expect(create).not.toHaveBeenCalled();
  });
});

describe("recording a call that failed", () => {
  /** A failure raised after the request left the machine. */
  function attempted(usage: typeof UNKNOWN_PROVIDER_USAGE | null) {
    return new ProviderError("timeout", "took too long", {
      attempt: { provider: "anthropic", model: "claude-opus-5", usage },
    });
  }

  it("writes the call, with nothing invented about what it used", async () => {
    await recordAIFailure(
      { userId: USER, feature: "discovery", runId: "run-3" },
      attempted(UNKNOWN_PROVIDER_USAGE),
      OCCURRED_AT,
    );

    expect(written()).toEqual({
      userId: USER,
      occurredAt: OCCURRED_AT,
      feature: "discovery",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outcome: "error",
      runId: "run-3",
    });
  });

  /**
   * **A refusal reports its usage in full**, because the model was reached and
   * answered. It is the one failure that is always paid for, and recording it
   * as costing nothing would hide exactly that.
   */
  it("keeps the numbers when the failure knew them", async () => {
    await recordAIFailure(
      { userId: USER, feature: "prompt", runId: "run-4" },
      new ProviderError("refused", "declined", {
        attempt: {
          provider: "anthropic",
          model: "claude-opus-5",
          usage: {
            inputTokens: 900,
            outputTokens: 12,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        },
      }),
      OCCURRED_AT,
    );

    expect(written().inputTokens).toBe(900);
    expect(written().outcome).toBe("error");
  });

  it("writes nulls rather than zeroes when the attempt knew nothing", async () => {
    await recordAIFailure(
      { userId: USER, feature: "prompt", runId: "run-5" },
      attempted(null),
      OCCURRED_AT,
    );

    expect(written().inputTokens).toBeNull();
    expect(written().outputTokens).toBeNull();
  });

  /**
   * **Every one of these cost nothing.** A provider that was never reached, a
   * refusal decided locally, a failure from somewhere else entirely — none of
   * them is a call, and a row for any of them would be a charge nobody made.
   */
  it.each([
    ["a failure with no attempt behind it", new ProviderError("unauthorized", "no key")],
    ["an ordinary error", new Error("something else")],
    ["a thrown string", "not an error at all"],
    ["nothing", undefined],
    ["null", null],
  ])("writes nothing for %s", async (_label, error) => {
    await recordAIFailure(
      { userId: USER, feature: "prompt", runId: "run-1" },
      error,
      OCCURRED_AT,
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("writes nothing when the attempt was the stand-in", async () => {
    await recordAIFailure(
      { userId: USER, feature: "prompt", runId: "run-1" },
      new ProviderError("unknown", "whatever", {
        attempt: { provider: "dummy", model: "stand-in", usage: null },
      }),
      OCCURRED_AT,
    );

    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * **Bookkeeping cannot fail an operation, and it cannot replace its error
 * either.** Both directions matter: a run that worked stays worked, and a run
 * that failed keeps failing for the reason it failed.
 */
describe("when the bridge cannot write", () => {
  it("does not throw on a call that succeeded", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await expect(
      recordAIExecution(
        { userId: USER, feature: "prompt", runId: "run-1" },
        {
                provider: "anthropic",
          model: "claude-opus-5",
          usage: UNKNOWN_PROVIDER_USAGE,
        },
        OCCURRED_AT,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw on a call that failed", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await expect(
      recordAIFailure(
        { userId: USER, feature: "prompt", runId: "run-1" },
        new ProviderError("timeout", "took too long", {
          attempt: {
            provider: "anthropic",
            model: "claude-opus-5",
            usage: null,
          },
        }),
        OCCURRED_AT,
      ),
    ).resolves.toBeUndefined();
  });
});

/**
 * Counting AI processing against the account's month.
 *
 * **The count lives here because the judgement already did.** The two bridges
 * above have exactly one job between them: telling a real provider call from
 * every refusal that never reached one. Six features call them, and asking each
 * one to draw that line again would be six chances to draw it differently — so
 * the counter moves where the event is written, and nowhere else.
 *
 * **The two writes are independent on purpose.** They are meant to be
 * reconcilable against each other, which they cannot be if one can only fail
 * together with the other.
 */
describe("counting AI processing", () => {
  const anthropicResult = {
    provider: "anthropic" as const,
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
  };

  /** The argument of the only counter update. */
  function counted() {
    return usageUpdateMany.mock.calls[0][0];
  }

  it.each([
    "prompt",
    "website",
    "discovery",
    "draft",
    "creator-analysis",
    "creator-memory",
  ] as const)("counts one unit for a real call from %o", async (feature) => {
    await recordAIExecution(
      { userId: USER, feature, runId: null },
      anthropicResult,
      OCCURRED_AT,
    );

    expect(usageUpdateMany).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual({
      where: { periodId: "usage-period-1", kind: "aiProcessing" },
      data: { used: { increment: 1 } },
    });
  });

  /**
   * **A call that was made was billable however it ended.** A transport failure
   * cost whatever it cost, and a month that only counted the successful ones
   * would describe a cheaper month than the real one.
   */
  it("counts a call that was made and then failed", async () => {
    await recordAIFailure(
      { userId: USER, feature: "prompt", runId: "run-1" },
      new ProviderError("timeout", "took too long", {
        attempt: { provider: "anthropic", model: "claude-opus-5", usage: null },
      }),
      OCCURRED_AT,
    );

    expect(usageUpdateMany).toHaveBeenCalledTimes(1);
    expect(counted().where.kind).toBe("aiProcessing");
  });

  /**
   * **Every one of these cost nothing**, so counting them would describe a
   * month that never happened.
   */
  it("counts nothing for the stand-in provider", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      { provider: "dummy", model: "stand-in", usage: null },
      OCCURRED_AT,
    );

    expect(usageUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a failure with no attempt behind it", new ProviderError("unauthorized", "no key")],
    ["an ordinary error", new Error("something else")],
    ["a thrown string", "not an error at all"],
  ])("counts nothing for %s", async (_label, error) => {
    await recordAIFailure(
      { userId: USER, feature: "prompt", runId: "run-1" },
      error,
      OCCURRED_AT,
    );

    expect(usageUpdateMany).not.toHaveBeenCalled();
  });

  /** One call, one unit — never two because two things were written. */
  it("counts once per call, not once per write", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      anthropicResult,
      OCCURRED_AT,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(usageUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("opens the month lazily, on the first thing counted", async () => {
    usagePeriodFindUnique.mockResolvedValue(null);

    await recordAIExecution(
      { userId: USER, feature: "draft", runId: null },
      anthropicResult,
      OCCURRED_AT,
    );

    expect(usagePeriodCreate.mock.calls[0][0].data).toMatchObject({
      userId: USER,
      planAtStart: "beta",
    });
  });
});

/**
 * **Neither write may take the other down**, because the two tables are meant
 * to be reconciled against each other. A month whose counter moved only when
 * the token row also landed would agree with that row by construction and prove
 * nothing.
 */
describe("when one of the two writes fails", () => {
  const anthropicResult = {
    provider: "anthropic" as const,
    model: "claude-opus-5",
    usage: UNKNOWN_PROVIDER_USAGE,
  };

  it("still counts when the token row cannot be written", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      anthropicResult,
      OCCURRED_AT,
    );

    expect(usageUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("still writes the token row when the counter cannot move", async () => {
    usageUpdateMany.mockRejectedValue(new Error("connection lost"));

    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      anthropicResult,
      OCCURRED_AT,
    );

    expect(create).toHaveBeenCalledTimes(1);
  });

  /** And neither reaches the caller: both are bookkeeping. */
  it("does not throw when both fail", async () => {
    create.mockRejectedValue(new Error("connection lost"));
    usageUpdateMany.mockRejectedValue(new Error("connection lost"));

    await expect(
      recordAIExecution(
        { userId: USER, feature: "prompt", runId: "run-1" },
        anthropicResult,
        OCCURRED_AT,
      ),
    ).resolves.toBeUndefined();
  });
});

/**
 * What an ended trial does to cost telemetry: nothing.
 *
 * **The two writes were always independent, and this is where that pays.** A
 * `ProviderUsageEvent` says what a call to a model actually used; a
 * `UsageCounter` says how much of a product allowance an account has spent.
 * When a trial ends there is no honest period for the second — see
 * `resolveUsageWriteWindow` — and stopping it must not take the first with it,
 * because what a call cost is still true and still the only number that cannot
 * be recomputed later.
 *
 * **So an expired-trial execution is deliberately asymmetric**: the cost is
 * recorded, the product counter is not. Enforcement will eventually stop such
 * executions happening at all; until it does, this is what is wanted.
 */
describe("a call made after a trial has ended", () => {
  const AFTER = new Date("2026-09-21T08:58:41.000Z");

  const succeeded = {
    provider: "anthropic" as const,
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
  };

  const failedAfterReaching = new ProviderError("timeout", "took too long", {
    attempt: {
      provider: "anthropic" as const,
      model: "claude-opus-5",
      usage: UNKNOWN_PROVIDER_USAGE,
    },
  });

  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      trialStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      trialEndsAt: new Date("2026-09-15T00:00:00.000Z"),
    });
  });

  it("still writes what the call cost", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      succeeded,
      AFTER,
    );

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("moves no product counter and opens no period", async () => {
    await recordAIExecution(
      { userId: USER, feature: "prompt", runId: "run-1" },
      succeeded,
      AFTER,
    );

    expect(usageUpdateMany).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /** A failed call is the same story: the cost is kept, the allowance is not. */
  it("keeps the cost of a call that failed after reaching the model", async () => {
    await recordAIFailure(
      { userId: USER, feature: "website", runId: "run-2" },
      failedAfterReaching,
      AFTER,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(usageUpdateMany).not.toHaveBeenCalled();
  });
});
