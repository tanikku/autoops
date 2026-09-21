import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What holding the lease costs and protects, at the one place both paths meet.
 *
 * The provider and the database are replaced; the lease is not mocked away
 * entirely but driven through its two answers, because the whole point of
 * these is which of them leads to a run existing. A suppressed execution has
 * to leave nothing behind — no row, no model call — and an execution that
 * started has to give the lease back however it ends, including when the
 * writes that record its outcome are the thing that failed.
 */

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  execute: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  usageCreate: vi.fn(),
  recordUsageObservation: vi.fn(),
}));

vi.mock("@/lib/execution-lease", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/execution-lease")>(
      "@/lib/execution-lease",
    );
  return {
    ...actual,
    acquireExecutionLease: mocks.acquire,
    releaseExecutionLease: mocks.release,
  };
});

vi.mock("@/lib/ai/factory", () => ({
  createAIProvider: () => ({ mode: "real", execute: mocks.execute }),
}));

vi.mock("@/lib/usage/observe", () => ({
  recordUsageObservation: mocks.recordUsageObservation,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findUniqueOrThrow: mocks.findUniqueOrThrow },
    runHistory: {
      create: mocks.create,
      update: mocks.update,
      findFirst: mocks.findFirst,
    },
    // Reached through the real recording helper rather than a stub of it,
    // so what these fix is the row a run actually writes.
    providerUsageEvent: { create: mocks.usageCreate },
  },
}));

const {
  isUnsupportedRoutineKind,
  latestExecutionFailureAt,
  PROMPT_AI_TIMEOUT_MS,
  runRoutine,
  RunPersistenceError,
} = await import("@/lib/runs");
const { ExecutionSuppressedError } = await import("@/lib/execution-lease");
const { ProviderError } = await import("@/lib/ai/provider");
// Imported for one comparison, and only here: the two constants belong to
// different modules on purpose — the dispatcher must not know what a prompt
// worker asks a model for, and execution must not import the dispatcher that
// calls it. A test is the one place both can be read at once.
const { MAX_TICK_EXECUTION_MS } = await import("@/lib/dispatcher");

/**
 * What a real provider hands back.
 *
 * **The text is still the product**, and every assertion about stored output
 * reads it; the rest is what the provider always knew and used to discard.
 */
function aiResult(
  text = "done",
  overrides: Record<string, unknown> = {},
) {
  return {
    text,
    provider: "anthropic" as const,
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
    ...overrides,
  };
}

const LEASE = { token: "token-a", expiresAt: new Date("2026-08-10T12:15:00Z") };

const RUN_ROW = {
  id: "run-1",
  routineId: "worker-1",
  userId: "user-1",
  status: "running",
  startedAt: new Date("2026-08-10T12:00:00.000Z"),
  finishedAt: null,
  output: "",
  errorMessage: null,
};

/** What the outcome write was asked to store. */
function written() {
  return mocks.update.mock.calls[mocks.update.mock.calls.length - 1][0].data;
}

beforeEach(() => {
  mocks.acquire.mockReset().mockResolvedValue(LEASE);
  mocks.release.mockReset().mockResolvedValue("released");
  mocks.execute.mockReset().mockResolvedValue(aiResult());
  mocks.usageCreate.mockReset().mockResolvedValue({});
  mocks.recordUsageObservation.mockReset().mockResolvedValue({ recorded: true });
  mocks.findUniqueOrThrow
    .mockReset()
    .mockResolvedValue({ userId: "user-1", prompt: "hello", kind: "prompt" });
  mocks.create.mockReset().mockResolvedValue(RUN_ROW);
  mocks.update
    .mockReset()
    .mockImplementation(async ({ data }) => ({ ...RUN_ROW, ...data }));
});

/**
 * **Which kind a worker is decides what runs, and an unreadable one runs
 * nothing.**
 *
 * The reading conversion answers `prompt` for a value it does not recognise,
 * which is right for a screen and wrong here: running a worker's prompt because
 * its kind could not be read produces a confident model answer about work
 * nobody asked for, recorded as a success. Execution asks the column instead.
 */
describe("runRoutine — which kind is being run", () => {
  it("reads the kind from the row rather than from the conversion", async () => {
    await runRoutine("worker-1");

    expect(mocks.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "worker-1" },
      select: {
        userId: true,
        name: true,
        prompt: true,
        kind: true,
        emailNotificationsEnabled: true,
      },
    });
  });

  it("runs a prompt worker's prompt", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ user: "hello" }),
    );
  });

  it.each(["", "Prompt", "PROMPT", "website ", "rss", "corrupt-value", "null"])(
    "refuses to run a worker whose kind reads %o",
    async (kind) => {
      mocks.findUniqueOrThrow.mockResolvedValue({
        userId: "user-1",
        prompt: "hello",
        kind,
      });

      await expect(runRoutine("worker-1")).rejects.toSatisfy(
        isUnsupportedRoutineKind,
      );
    },
  );

  /**
   * **Nothing at all happens**, which is why the refusal is before the lease.
   * Refusing later would mean deciding what to record about a run that should
   * never have been started.
   */
  it("takes no lease, records no run and calls nothing when the kind is unreadable", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: "user-1",
      prompt: "hello",
      kind: "corrupt-value",
    });

    await expect(runRoutine("worker-1")).rejects.toThrow();

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  /** Not "already running", which is a run that could have happened. */
  it("is not reported as a suppressed execution", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: "user-1",
      prompt: "hello",
      kind: "corrupt-value",
    });

    await expect(runRoutine("worker-1")).rejects.not.toBeInstanceOf(
      ExecutionSuppressedError,
    );
  });
});

describe("runRoutine — lease acquired", () => {
  it("records the run and calls the provider", async () => {
    const run = await runRoutine("worker-1");

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ user: "hello" }),
    );
    expect(run.status).toBe("completed");
  });

  it("gives the lease back after a run that worked", async () => {
    await runRoutine("worker-1");

    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  it("gives the lease back after the provider threw", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  /**
   * A run with no row has not started, which is a different event from one
   * that ran and could not be written down — the dispatcher counts the first
   * as a worker it could not start and the second as one it did. The failure
   * leaves as it arrived rather than becoming a persistence error.
   */
  it("gives the lease back when the run row could not be created", async () => {
    mocks.create.mockRejectedValue(new Error("write failed"));

    await expect(runRoutine("worker-1")).rejects.toThrow("write failed");
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  it("never reaches the provider when the run row could not be created", async () => {
    mocks.create.mockRejectedValue(new Error("write failed"));

    await expect(runRoutine("worker-1")).rejects.toThrow();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("gives the lease back when the outcome could not be written", async () => {
    mocks.update.mockRejectedValue(new Error("write failed"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  /**
   * Release runs in the cleanup of the execution it is releasing, so a failure
   * there must not become the execution's answer.
   */
  it("still reports a completed run when the release failed", async () => {
    mocks.release.mockResolvedValue("failed");

    expect((await runRoutine("worker-1")).status).toBe("completed");
  });

  it("still reports a failed run when the release failed", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));
    mocks.release.mockResolvedValue("failed");

    expect((await runRoutine("worker-1")).status).toBe("failed");
  });

  it("does not touch the schedule", async () => {
    await runRoutine("worker-1");

    const created = mocks.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty("nextRunAt");
  });
});

/**
 * Which column carries what, and the rule underneath it: `output` is the
 * model's, `errorMessage` is the failure's, and neither has to be read through
 * `status` to know which it is. They shared a column until Sprint 39, and both
 * screens that read it rendered whichever had been written as output.
 */
describe("runRoutine — what a run records", () => {
  it("stores the model's answer and no error when it worked", async () => {
    mocks.execute.mockResolvedValue(aiResult("the answer"));

    await runRoutine("worker-1");

    expect(written()).toMatchObject({
      status: "completed",
      output: "the answer",
      errorMessage: null,
    });
  });

  it("stores the reason and no output when the provider failed", async () => {
    mocks.execute.mockRejectedValue(new Error("rate limited"));

    await runRoutine("worker-1");

    expect(written()).toMatchObject({
      status: "failed",
      output: "",
      errorMessage: "rate limited",
    });
  });

  /**
   * A refusal arrives as an ordinary `Error`, so its wording travels the same
   * path — unchanged, as it has since Sprint 36.
   */
  it("keeps a refusal's own wording", async () => {
    mocks.execute.mockRejectedValue(
      new Error("Claude declined to answer this prompt."),
    );

    await runRoutine("worker-1");

    expect(written().errorMessage).toBe(
      "Claude declined to answer this prompt.",
    );
  });

  /**
   * Something thrown that is not an `Error` has no message to carry, so the
   * fallback stands in — now in the column meant for it.
   */
  it("falls back for something thrown that is not an Error", async () => {
    mocks.execute.mockRejectedValue("not an error");

    await runRoutine("worker-1");

    expect(written()).toMatchObject({
      output: "",
      errorMessage: "Execution failed.",
    });
  });

  /**
   * A run in progress has produced neither. The row is created without either
   * column, so the schema's own default answers for `output` and `NULL` for
   * `errorMessage` — which is what makes "empty" mean the same thing on a run
   * that is still going and one that failed.
   */
  it("creates a run carrying neither an answer nor a reason", async () => {
    await runRoutine("worker-1");

    const created = mocks.create.mock.calls[0][0].data;
    expect(created).toEqual({
      routineId: "worker-1",
      userId: "user-1",
      status: "running",
    });
  });
});

describe("runRoutine — lease contended", () => {
  beforeEach(() => {
    mocks.acquire.mockResolvedValue(null);
  });

  it("reports that the worker is already running", async () => {
    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      ExecutionSuppressedError,
    );
  });

  it("records no run", async () => {
    await expect(runRoutine("worker-1")).rejects.toThrow();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("never reaches the provider", async () => {
    await expect(runRoutine("worker-1")).rejects.toThrow();

    expect(mocks.execute).not.toHaveBeenCalled();
  });

  /**
   * Releasing a lease it never held would clear whichever run actually has it.
   */
  it("releases nothing", async () => {
    await expect(runRoutine("worker-1")).rejects.toThrow();

    expect(mocks.release).not.toHaveBeenCalled();
  });
});

/**
 * The line between a run that went wrong and a run whose outcome could not be
 * written down. They shared a `catch` until Sprint 39, so a database that
 * refused the success sent a working run through the failure path and stored
 * it as `failed` — with the answer gone and the two causes indistinguishable.
 */
describe("runRoutine — recording the outcome fails", () => {
  it("does not write a failed run when the success could not be written", async () => {
    mocks.execute.mockResolvedValue(aiResult("the answer"));
    mocks.update.mockRejectedValueOnce(new Error("db down"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );

    // The one call is the attempt that failed. Nothing followed it.
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data.status).toBe("completed");
  });

  it("says which write it was", async () => {
    mocks.execute.mockResolvedValue(aiResult("the answer"));
    mocks.update.mockRejectedValueOnce(new Error("db down"));

    await expect(runRoutine("worker-1")).rejects.toMatchObject({
      phase: "completed",
      runId: "run-1",
    });
  });

  it("keeps the original database failure as the cause", async () => {
    const cause = new Error("db down");
    mocks.execute.mockResolvedValue(aiResult("the answer"));
    mocks.update.mockRejectedValueOnce(cause);

    await expect(runRoutine("worker-1")).rejects.toMatchObject({ cause });
  });

  it("gives the lease back when the success could not be written", async () => {
    mocks.execute.mockResolvedValue(aiResult("the answer"));
    mocks.update.mockRejectedValueOnce(new Error("db down"));

    await expect(runRoutine("worker-1")).rejects.toThrow();
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  /**
   * A run that failed and could not be written down leaves as a persistence
   * error too: there is no `failed` row, so returning one would describe a
   * record that does not exist.
   */
  it("reports a failure that could not be written as a persistence failure", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));
    mocks.update.mockRejectedValue(new Error("db down"));

    await expect(runRoutine("worker-1")).rejects.toMatchObject({
      name: "RunPersistenceError",
      phase: "failed",
    });
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  it("still reports the persistence failure when the release also failed", async () => {
    mocks.execute.mockResolvedValue(aiResult("the answer"));
    mocks.update.mockRejectedValueOnce(new Error("db down"));
    mocks.release.mockResolvedValue("failed");

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );
  });

  it("still reports it when a failed run's write and the release both failed", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));
    mocks.update.mockRejectedValue(new Error("db down"));
    mocks.release.mockResolvedValue("failed");

    await expect(runRoutine("worker-1")).rejects.toMatchObject({
      phase: "failed",
    });
  });
});

describe("runRoutine — a worker that is gone", () => {
  /**
   * A deleted worker matches no row, and so would a lease acquisition — which
   * is why the read comes first. Otherwise a vanished worker would look
   * exactly like a busy one, and the dispatcher counts them differently.
   */
  it("reports missing rather than already running", async () => {
    mocks.findUniqueOrThrow.mockRejectedValue(new Error("not found"));

    await expect(runRoutine("worker-1")).rejects.not.toBeInstanceOf(
      ExecutionSuppressedError,
    );
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});

/**
 * The one read that is not on behalf of a signed-in user.
 *
 * A failed run is visible to the account that owns the worker and to nobody
 * else, so an operator watching a Closed Beta has no way to notice that
 * executions have started failing. This answers that, and answers only that:
 * when, across everyone, not how many and not whose.
 */
describe("latestExecutionFailureAt", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset().mockResolvedValue(null);
  });

  it("says nothing has failed when nothing has", async () => {
    expect(await latestExecutionFailureAt()).toBeNull();
  });

  it("gives back when the most recent failure finished", async () => {
    const finishedAt = new Date("2026-08-11T13:15:22.129Z");
    mocks.findFirst.mockResolvedValue({ finishedAt });

    expect(await latestExecutionFailureAt()).toEqual(finishedAt);
  });

  it("asks only for failures, and only for ones that finished", async () => {
    await latestExecutionFailureAt();

    expect(mocks.findFirst.mock.calls[0][0].where).toEqual({
      status: "failed",
      finishedAt: { not: null },
    });
  });

  /** Newest first, by when the failure was recorded rather than when it began. */
  it("takes the newest by the moment it was recorded", async () => {
    await latestExecutionFailureAt();

    expect(mocks.findFirst.mock.calls[0][0].orderBy).toEqual({
      finishedAt: "desc",
    });
  });

  /**
   * It reads on behalf of the platform, as the scheduler's own query does.
   * Scoping it to a tenant would make it answer a question nobody is asking.
   */
  it("is deliberately not scoped to one account", async () => {
    await latestExecutionFailureAt();

    expect(mocks.findFirst.mock.calls[0][0].where).not.toHaveProperty("userId");
  });

  /**
   * A timestamp and nothing else. Anything wider would put a prompt, an
   * output or somebody's diagnostic within reach of a log line.
   */
  it("selects the timestamp and nothing else", async () => {
    await latestExecutionFailureAt();

    expect(mocks.findFirst.mock.calls[0][0].select).toEqual({
      finishedAt: true,
    });
  });

  it("treats a row with no timestamp as nothing to report", async () => {
    mocks.findFirst.mockResolvedValue({ finishedAt: null });

    expect(await latestExecutionFailureAt()).toBeNull();
  });
});


/**
 * How long a prompt worker may wait for a model.
 *
 * **The deadline is the caller's, said out loud.** Every other caller of the
 * provider already names one — a website change gets two minutes, a draft
 * thirty seconds — and this was the last one taking whatever the provider
 * happened to allow. What it happened to allow was ten minutes, which is
 * longer than the tick the run sits inside and longer than the HTTP response
 * that tick is answering.
 */
describe("how long a prompt worker waits for a model", () => {
  it("asks for its own deadline rather than the provider's", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: PROMPT_AI_TIMEOUT_MS }),
    );
  });

  it("is three minutes", () => {
    expect(PROMPT_AI_TIMEOUT_MS).toBe(180_000);
  });

  /**
   * **The invariant, not the value.** Either number may be revisited; what must
   * not happen again is one of them moving on its own until a single worker can
   * hold a tick for longer than the tick is willing to spend. Read here rather
   * than asserted in production code, which would mean execution importing the
   * dispatcher that calls it.
   */
  it("leaves the dispatcher a decision to make afterwards", () => {
    expect(PROMPT_AI_TIMEOUT_MS).toBeLessThan(MAX_TICK_EXECUTION_MS);
  });

  /** The prompt itself is unchanged by the deadline travelling with it. */
  it("sends the same request it always did", async () => {
    await runRoutine("worker-1");

    const request = mocks.execute.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;

    expect(request.user).toBe("hello");
    // A prompt worker's instruction and its material are one text: it has no
    // `system`, and giving it a deadline does not give it one.
    expect(request).not.toHaveProperty("system");
    expect(Object.keys(request).sort()).toEqual(["timeoutMs", "user"]);
  });
});

/**
 * What a prompt worker's run says it cost.
 *
 * **One row per call, and no row when there was no call.** A prompt worker asks
 * a model exactly once, so the arithmetic is simple enough to state plainly:
 * every run that reached the provider writes one usage row, and every run that
 * did not writes none.
 *
 * **The account and the run come from here, never from the provider.** A
 * provider handed an account id could write the row itself, and then every
 * feature's bookkeeping would live inside an adapter that has no business
 * knowing whose work it is doing.
 */
describe("runRoutine — what a prompt run records about its call", () => {
  /** The data of the only provider-usage `create`. */
  function usageRow() {
    return mocks.usageCreate.mock.calls[0][0].data;
  }

  it("writes exactly one row for one call", async () => {
    await runRoutine("worker-1");

    expect(mocks.usageCreate).toHaveBeenCalledTimes(1);
  });

  it("records the call against the owner and the run", async () => {
    await runRoutine("worker-1");

    expect(usageRow()).toMatchObject({
      userId: "user-1",
      runId: "run-1",
      feature: "prompt",
      outcome: "ok",
    });
  });

  it("records what the provider said the call used", async () => {
    await runRoutine("worker-1");

    expect(usageRow()).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    });
  });

  /**
   * **A call that failed after being sent still cost something**, and how much
   * is usually unknown — which is written down as unknown rather than as zero.
   */
  it("records a call that was made and then failed", async () => {
    mocks.execute.mockRejectedValue(
      new ProviderError("timeout", "took too long", {
        attempt: {
          provider: "anthropic",
          model: "claude-opus-5",
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        },
      }),
    );

    await runRoutine("worker-1");

    expect(mocks.usageCreate).toHaveBeenCalledTimes(1);
    expect(usageRow()).toMatchObject({
      feature: "prompt",
      outcome: "error",
      inputTokens: null,
      outputTokens: null,
    });
  });

  /** The run is still failed, and still for the provider's own reason. */
  it("leaves a failed run failed", async () => {
    mocks.execute.mockRejectedValue(
      new ProviderError("timeout", "took too long", {
        attempt: { provider: "anthropic", model: "claude-opus-5", usage: null },
      }),
    );

    await runRoutine("worker-1");

    expect(written()).toMatchObject({ status: "failed" });
  });

  /**
   * **A failure that never reached a provider is free**, and free things are not
   * recorded. This is the ordinary shape of every pre-provider refusal.
   */
  it("writes nothing when the provider was never reached", async () => {
    mocks.execute.mockRejectedValue(new Error("refused before sending"));

    await runRoutine("worker-1");

    expect(mocks.usageCreate).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ status: "failed" });
  });

  /** Nothing was sent and nothing was charged. */
  it("writes nothing for the stand-in provider", async () => {
    mocks.execute.mockResolvedValue({
      text: "Execution completed successfully.",
      provider: "dummy",
      model: "stand-in",
      usage: null,
    });

    await runRoutine("worker-1");

    expect(mocks.usageCreate).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ status: "completed" });
  });
});

/**
 * **Observation must not change what it observes.** A bookkeeping row that
 * cannot be written is a gap in a ledger; a run that disappears because of one
 * is a product failure. These fix which of the two happens.
 */
describe("runRoutine — when the usage row cannot be written", () => {
  it("still completes a run that worked", async () => {
    mocks.usageCreate.mockRejectedValue(new Error("connection lost"));

    await runRoutine("worker-1");

    expect(written()).toMatchObject({ status: "completed", output: "done" });
  });

  /**
   * And it must not replace the real error either: a run that failed keeps
   * failing for the reason it failed.
   */
  it("still fails a run that failed, for the original reason", async () => {
    mocks.usageCreate.mockRejectedValue(new Error("connection lost"));
    mocks.execute.mockRejectedValue(
      new ProviderError("timeout", "the model took too long", {
        attempt: { provider: "anthropic", model: "claude-opus-5", usage: null },
      }),
    );

    await runRoutine("worker-1");

    expect(written()).toMatchObject({ status: "failed" });
    expect(written().errorMessage).toContain("the model took too long");
  });
});

/**
 * Counting a prompt worker's call against the account's month.
 *
 * **The count follows the call, not the run.** A prompt worker asks a model
 * exactly once, so the two happen to coincide here — the paths where they do
 * not are `lib/runs.website.test.ts` and `lib/discovery/execute.test.ts`.
 */
describe("runRoutine — counting a prompt run against the month", () => {
  /** Every kind observed during this run. */
  function observed() {
    return mocks.recordUsageObservation.mock.calls.map((call: unknown[]) =>
      String(call[1]),
    );
  }

  it("counts one unit of AI processing for a real call", async () => {
    await runRoutine("worker-1");

    expect(observed()).toEqual(["aiProcessing"]);
    expect(mocks.recordUsageObservation.mock.calls[0][0]).toBe("user-1");
  });

  /** A call that was made was billable however it ended. */
  it("counts a call that was made and then failed", async () => {
    mocks.execute.mockRejectedValue(
      new ProviderError("timeout", "took too long", {
        attempt: { provider: "anthropic", model: "claude-opus-5", usage: null },
      }),
    );

    await runRoutine("worker-1");

    expect(observed()).toEqual(["aiProcessing"]);
  });

  it("counts nothing when the provider was never reached", async () => {
    mocks.execute.mockRejectedValue(new Error("refused before sending"));

    await runRoutine("worker-1");

    expect(mocks.recordUsageObservation).not.toHaveBeenCalled();
  });

  /** Nothing was sent and nothing was charged. */
  it("counts nothing for the stand-in provider", async () => {
    mocks.execute.mockResolvedValue({
      text: "Execution completed successfully.",
      provider: "dummy",
      model: "stand-in",
      usage: null,
    });

    await runRoutine("worker-1");

    expect(mocks.recordUsageObservation).not.toHaveBeenCalled();
  });

  it("counts exactly once per call", async () => {
    await runRoutine("worker-1");

    expect(mocks.recordUsageObservation).toHaveBeenCalledTimes(1);
  });

  /**
   * **Observation must not change what it observes.** A run that worked stays
   * worked when the month could not be counted.
   */
  it("still completes the run when the month cannot be counted", async () => {
    mocks.recordUsageObservation.mockResolvedValue({
      recorded: false,
      reason: "unavailable",
    });

    await runRoutine("worker-1");

    expect(written()).toMatchObject({ status: "completed", output: "done" });
  });
});
