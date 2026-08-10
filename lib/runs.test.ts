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
    runHistory: { create: mocks.create, update: mocks.update },
  },
}));

const { runRoutine } = await import("@/lib/runs");
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
};

beforeEach(() => {
  mocks.acquire.mockReset().mockResolvedValue(LEASE);
  mocks.release.mockReset().mockResolvedValue("released");
  mocks.execute.mockReset().mockResolvedValue("done");
  mocks.findUniqueOrThrow
    .mockReset()
    .mockResolvedValue({ userId: "user-1", prompt: "hello" });
  mocks.create.mockReset().mockResolvedValue(RUN_ROW);
  mocks.update
    .mockReset()
    .mockImplementation(async ({ data }) => ({ ...RUN_ROW, ...data }));
});

describe("runRoutine — lease acquired", () => {
  it("records the run and calls the provider", async () => {
    const run = await runRoutine("worker-1");

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith("hello");
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

  it("gives the lease back when the run row could not be created", async () => {
    mocks.create.mockRejectedValue(new Error("write failed"));

    await expect(runRoutine("worker-1")).rejects.toThrow("write failed");
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  it("gives the lease back when the outcome could not be written", async () => {
    mocks.update.mockRejectedValue(new Error("write failed"));

    await expect(runRoutine("worker-1")).rejects.toThrow("write failed");
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

    const written = mocks.create.mock.calls[0][0].data;
    expect(written).not.toHaveProperty("nextRunAt");
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
