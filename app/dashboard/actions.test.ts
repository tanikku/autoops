import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionSuppressedError } from "@/lib/execution-lease";
import { RunPersistenceError } from "@/lib/runs";

/**
 * What the button says back, and what it leaves alone.
 *
 * The one distinction worth fixing here is between a worker that is busy and
 * a run that went wrong: both come back as `error`, because a toast has two
 * colours, but the sentences lead somewhere different — one says wait, the
 * other says something is broken.
 *
 * The rest is about restraint. A hand-started run competes for execution, not
 * for a slot, so nothing in this path may touch the schedule.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getRoutine: vi.fn(),
  enqueueRoutine: vi.fn(),
  claimRoutineSlot: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/queue", () => ({ enqueueRoutine: mocks.enqueueRoutine }));
vi.mock("@/lib/routines", () => ({
  getRoutine: mocks.getRoutine,
  deleteRoutine: vi.fn(),
  claimRoutineSlot: mocks.claimRoutineSlot,
}));

const { runRoutineAction } = await import("@/app/dashboard/actions");

function form(routineId: string) {
  const data = new FormData();
  data.set("routineId", routineId);
  return data;
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getRoutine.mockReset().mockResolvedValue({
    id: "worker-1",
    name: "Daily digest",
  });
  mocks.enqueueRoutine.mockReset().mockResolvedValue({ status: "completed" });
  mocks.claimRoutineSlot.mockReset();
  mocks.revalidatePath.mockReset();
});

describe("runRoutineAction", () => {
  it("reports a successful run", async () => {
    const result = await runRoutineAction(null, form("worker-1"));

    expect(result).toEqual({
      status: "success",
      message: '"Daily digest" ran successfully.',
    });
  });

  it("reports a run that failed", async () => {
    mocks.enqueueRoutine.mockResolvedValue({ status: "failed" });

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" failed to run.',
    });
  });

  /**
   * Already running is not a failure, and the wording has to say which it is:
   * "failed to run" would send someone looking for a fault there isn't.
   */
  it("says the worker is already running rather than that it failed", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" is already running.',
    });
  });

  /**
   * The run reached a provider, so "failed to run" would be wrong — and so
   * would claiming the result was lost, since a write that throws may have
   * landed anyway. The sentence says what is known and stops there.
   */
  it("says the outcome could not be recorded rather than that the run failed", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("completed", "run-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" started, but its outcome could not be recorded.',
    });
  });

  it("says the same when a failure was the thing that could not be recorded", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("failed", "run-1"),
    );

    expect(
      (await runRoutineAction(null, form("worker-1")))?.message,
    ).toContain("could not be recorded");
  });

  it("still reports an ordinary failure as one", async () => {
    mocks.enqueueRoutine.mockRejectedValue(new Error("boom"));

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" failed to run.',
    });
  });

  /**
   * A hand-started run takes execution ownership, never a scheduled slot. It
   * must leave `nextRunAt` exactly where the schedule put it.
   */
  it("never claims a slot, whatever the outcome", async () => {
    await runRoutineAction(null, form("worker-1"));

    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );
    await runRoutineAction(null, form("worker-1"));

    expect(mocks.claimRoutineSlot).not.toHaveBeenCalled();
  });

  it("rejects a worker belonging to someone else without running anything", async () => {
    mocks.getRoutine.mockResolvedValue(null);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "Worker not found.",
    });
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
  });
});
