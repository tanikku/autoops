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
  createAIProvider: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findUniqueOrThrow: mocks.findUniqueOrThrow },
    runHistory: {
      create: mocks.create,
      update: mocks.update,
      findFirst: mocks.findFirst,
    },
  },
}));

const {
  isUnsupportedRoutineKind,
  latestExecutionFailureAt,
  runRoutine,
  RunPersistenceError,
} = await import("@/lib/runs");
const { ExecutionSuppressedError } = await import("@/lib/execution-lease");

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
  mocks.execute.mockReset().mockResolvedValue("done");
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
      select: { userId: true, prompt: true, kind: true },
    });
  });

  it("runs a prompt worker's prompt", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledWith({ user: "hello" });
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
    expect(mocks.execute).toHaveBeenCalledWith({ user: "hello" });
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
    mocks.execute.mockResolvedValue("the answer");

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
    mocks.execute.mockResolvedValue("the answer");
    mocks.update.mockRejectedValueOnce(new Error("db down"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );

    // The one call is the attempt that failed. Nothing followed it.
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data.status).toBe("completed");
  });

  it("says which write it was", async () => {
    mocks.execute.mockResolvedValue("the answer");
    mocks.update.mockRejectedValueOnce(new Error("db down"));

    await expect(runRoutine("worker-1")).rejects.toMatchObject({
      phase: "completed",
      runId: "run-1",
    });
  });

  it("keeps the original database failure as the cause", async () => {
    const cause = new Error("db down");
    mocks.execute.mockResolvedValue("the answer");
    mocks.update.mockRejectedValueOnce(cause);

    await expect(runRoutine("worker-1")).rejects.toMatchObject({ cause });
  });

  it("gives the lease back when the success could not be written", async () => {
    mocks.execute.mockResolvedValue("the answer");
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
    mocks.execute.mockResolvedValue("the answer");
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
