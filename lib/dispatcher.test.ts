import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionSuppressedError } from "@/lib/execution-lease";
import { RunPersistenceError } from "@/lib/runs";
import type { DueWorker } from "@/lib/scheduler";

/**
 * What a tick owes its caller, with the database taken out of the way.
 *
 * The four collaborators are replaced because none of them is what is being
 * tested: the scheduler decides what is due, the schedule module decides where
 * a slot goes next, and the queue decides how a worker runs. What is left —
 * and what these fix — is the dispatcher's own share: claim first, hand off
 * only what was won, and let one worker's failure be one worker's failure.
 *
 * **`lib/schedule.ts` is deliberately *not* replaced.** It is pure and already
 * covered, and letting the real arithmetic run means the value handed to
 * `claimRoutineSlot` is the one production would compute.
 *
 * There is no assertion here that workers run one at a time. Nothing depends
 * on it: the result is the same set either way, and pinning it would turn an
 * implementation detail into a contract that a later change to concurrency
 * would have to break before it could be considered.
 */

const mocks = vi.hoisted(() => ({
  getDueWorkers: vi.fn(),
  claimRoutineSlot: vi.fn(),
  enqueueRoutine: vi.fn(),
  getUserTimezone: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/scheduler", () => ({ getDueWorkers: mocks.getDueWorkers }));
vi.mock("@/lib/routines", () => ({ claimRoutineSlot: mocks.claimRoutineSlot }));
vi.mock("@/lib/queue", () => ({ enqueueRoutine: mocks.enqueueRoutine }));
vi.mock("@/lib/users", () => ({ getUserTimezone: mocks.getUserTimezone }));

const { dispatchDueWorkers, MAX_TICK_EXECUTION_MS } = await import(
  "@/lib/dispatcher",
);

const NOW = new Date("2026-08-10T09:05:00.000Z");
const SLOT = new Date("2026-08-10T09:00:00.000Z");

function due(id: string, overrides: Partial<DueWorker> = {}): DueWorker {
  return {
    id,
    userId: "user-1",
    nextRunAt: SLOT,
    frequency: "daily",
    runAtMinutes: 540,
    runAtWeekday: null,
    runAtDay: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.getDueWorkers.mockReset().mockResolvedValue([]);
  mocks.claimRoutineSlot.mockReset().mockResolvedValue(true);
  mocks.enqueueRoutine.mockReset().mockResolvedValue({ status: "completed" });
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
});

describe("dispatchDueWorkers", () => {
  it("reports an empty tick when nothing is due", async () => {
    expect(await dispatchDueWorkers(NOW)).toEqual({
      dispatched: [],
      failed: 0,
    });
  });

  it("hands off a worker whose slot it won", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1")]);

    const result = await dispatchDueWorkers(NOW);

    expect(mocks.enqueueRoutine).toHaveBeenCalledWith("worker-1");
    expect(result).toEqual({ dispatched: ["worker-1"], failed: 0 });
  });

  it("does not hand off a worker whose slot it lost", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1")]);
    mocks.claimRoutineSlot.mockResolvedValue(false);

    const result = await dispatchDueWorkers(NOW);

    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: [], failed: 0 });
  });

  /**
   * Losing a slot is not a failure. A second tick arriving at the same worker
   * is ordinary, and counting it would make a healthy pair of ticks look like
   * a broken one.
   */
  it("counts a lost slot as neither dispatched nor failed", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("a"), due("b")]);
    mocks.claimRoutineSlot.mockResolvedValueOnce(false).mockResolvedValue(true);

    expect(await dispatchDueWorkers(NOW)).toEqual({
      dispatched: ["b"],
      failed: 0,
    });
  });

  /**
   * The claim is how the work is taken, so it has to land before the hand-off
   * — claiming afterwards would turn a crash mid-run into a duplicate.
   */
  it("claims the slot before handing the worker off", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1")]);
    mocks.claimRoutineSlot.mockImplementation(async () => {
      mocks.calls.push("claim");
      return true;
    });
    mocks.enqueueRoutine.mockImplementation(async () => {
      mocks.calls.push("enqueue");
    });

    await dispatchDueWorkers(NOW);

    expect(mocks.calls).toEqual(["claim", "enqueue"]);
  });

  it("claims against the slot it read, and moves it forward", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1")]);

    await dispatchDueWorkers(NOW);

    const [id, expected, next] = mocks.claimRoutineSlot.mock.calls[0];
    expect(id).toBe("worker-1");
    expect(expected).toEqual(SLOT);
    // Real arithmetic: a daily worker at 09:00 UTC moves to 09:00 tomorrow.
    expect(next).toEqual(new Date("2026-08-11T09:00:00.000Z"));
  });

  it("never claims a worker with no pending slot", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1", { nextRunAt: null })]);

    const result = await dispatchDueWorkers(NOW);

    expect(mocks.claimRoutineSlot).not.toHaveBeenCalled();
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: [], failed: 0 });
  });

  describe("failure isolation", () => {
    it("carries on after a claim that threw", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("broken"), due("fine")]);
      mocks.claimRoutineSlot.mockRejectedValueOnce(new Error("gone"));

      expect(await dispatchDueWorkers(NOW)).toEqual({
        dispatched: ["fine"],
        failed: 1,
      });
    });

    it("carries on after a hand-off that threw", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("broken"), due("fine")]);
      mocks.enqueueRoutine.mockRejectedValueOnce(new Error("no"));

      expect(await dispatchDueWorkers(NOW)).toEqual({
        dispatched: ["fine"],
        failed: 1,
      });
    });

    /**
     * Due workers are ordered by `nextRunAt`, so without this the same workers
     * at the front of the queue would take every worker behind them, every
     * tick.
     */
    it("does not let the first worker end the tick", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("a"), due("b"), due("c")]);
      mocks.enqueueRoutine.mockRejectedValueOnce(new Error("no"));

      expect(await dispatchDueWorkers(NOW)).toEqual({
        dispatched: ["b", "c"],
        failed: 1,
      });
    });

    it("counts every worker that could not be started", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("a"), due("b")]);
      mocks.enqueueRoutine.mockRejectedValue(new Error("no"));

      expect(await dispatchDueWorkers(NOW)).toEqual({
        dispatched: [],
        failed: 2,
      });
    });
  });

  /**
   * A worker already running is neither handed off nor broken, so it belongs
   * in neither number. The tick sees it because execution ownership is held
   * per worker while a slot is claimed per schedule — a hand-started run can
   * be in progress on a worker whose slot just came due.
   */
  describe("a worker that was already running", () => {
    it("is not counted as dispatched", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("busy")]);
      mocks.enqueueRoutine.mockRejectedValue(
        new ExecutionSuppressedError("busy"),
      );

      expect((await dispatchDueWorkers(NOW)).dispatched).toEqual([]);
    });

    it("is not counted as failed", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("busy")]);
      mocks.enqueueRoutine.mockRejectedValue(
        new ExecutionSuppressedError("busy"),
      );

      expect((await dispatchDueWorkers(NOW)).failed).toBe(0);
    });

    it("does not stop the workers behind it", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("busy"), due("free")]);
      mocks.enqueueRoutine.mockRejectedValueOnce(
        new ExecutionSuppressedError("busy"),
      );

      expect(await dispatchDueWorkers(NOW)).toEqual({
        dispatched: ["free"],
        failed: 0,
      });
    });

    /**
     * The claim happened before the hand-off, and nothing here gives it back.
     * A worker that was busy has still spent the slot it was due for.
     */
    it("has already spent its slot, and nothing restores it", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("busy")]);
      mocks.enqueueRoutine.mockRejectedValue(
        new ExecutionSuppressedError("busy"),
      );

      await dispatchDueWorkers(NOW);

      expect(mocks.claimRoutineSlot).toHaveBeenCalledTimes(1);
      // The only write is the claim: the slot moved forward and stayed there.
      expect(mocks.claimRoutineSlot.mock.calls[0][2]).toEqual(
        new Date("2026-08-11T09:00:00.000Z"),
      );
    });
  });

  /**
   * A worker whose outcome could not be written down was still started, and
   * started is what this number counts. Putting it in `failed` would say the
   * hand-off did not happen — `failed` is workers that could not be started,
   * and this one reached a provider.
   */
  describe("a worker whose outcome could not be recorded", () => {
    it("is counted as dispatched", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("unrecorded")]);
      mocks.enqueueRoutine.mockRejectedValue(
        new RunPersistenceError("completed", "run-1"),
      );

      expect((await dispatchDueWorkers(NOW)).dispatched).toEqual([
        "unrecorded",
      ]);
    });

    it("is not counted as failed", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("unrecorded")]);
      mocks.enqueueRoutine.mockRejectedValue(
        new RunPersistenceError("completed", "run-1"),
      );

      expect((await dispatchDueWorkers(NOW)).failed).toBe(0);
    });

    it("does not stop the workers behind it", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("unrecorded"), due("fine")]);
      mocks.enqueueRoutine.mockRejectedValueOnce(
        new RunPersistenceError("completed", "run-1"),
      );

      expect(await dispatchDueWorkers(NOW)).toEqual({
        dispatched: ["unrecorded", "fine"],
        failed: 0,
      });
    });

    /**
     * The slot was claimed before any of this and nothing gives it back — the
     * same rule a failed run follows.
     */
    it("has spent its slot, and nothing restores it", async () => {
      mocks.getDueWorkers.mockResolvedValue([due("unrecorded")]);
      mocks.enqueueRoutine.mockRejectedValue(
        new RunPersistenceError("completed", "run-1"),
      );

      await dispatchDueWorkers(NOW);

      expect(mocks.claimRoutineSlot).toHaveBeenCalledTimes(1);
      expect(mocks.claimRoutineSlot.mock.calls[0][2]).toEqual(
        new Date("2026-08-11T09:00:00.000Z"),
      );
    });
  });

  /**
   * A run that fails is recorded rather than thrown, so it reaches here as an
   * ordinary return value. The tick did its job; the work did not.
   */
  it("counts a run that failed as dispatched", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1")]);
    mocks.enqueueRoutine.mockResolvedValue({ status: "failed" });

    expect(await dispatchDueWorkers(NOW)).toEqual({
      dispatched: ["worker-1"],
      failed: 0,
    });
  });
});

/**
 * **How long a tick keeps starting new work.**
 *
 * Cooperative, and that word carries the whole design. Nothing is cancelled
 * when the budget passes: a worker already running keeps its fetch, its model
 * call, and the writes that record what it did — aborting those would leave a
 * run that reached a provider, was billed for, and has nothing written down.
 * What the budget changes is whether the *next* worker is started.
 *
 * The check sits before the claim, which is the part that matters. A claim
 * moves a worker's slot on whether or not the run then happens, so checking
 * afterwards would spend slots on workers this tick had already decided to skip.
 */
describe("the time a tick may spend starting work", () => {
  /** Only `Date` is faked: nothing here waits on a timer. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-18T09:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Makes each hand-off take `ms` of wall clock. */
  function eachRunTakes(ms: number) {
    mocks.enqueueRoutine.mockImplementation(async () => {
      vi.advanceTimersByTime(ms);
      return { status: "completed" };
    });
  }

  it("starts the next worker while there is budget left", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1"), due("worker-2")]);
    eachRunTakes(1_000);

    const result = await dispatchDueWorkers(NOW);

    expect(result.dispatched).toEqual(["worker-1", "worker-2"]);
  });

  it("stops before starting a worker once the budget is gone", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1"), due("worker-2")]);
    eachRunTakes(MAX_TICK_EXECUTION_MS);

    const result = await dispatchDueWorkers(NOW);

    expect(result.dispatched).toEqual(["worker-1"]);
    expect(mocks.enqueueRoutine).toHaveBeenCalledTimes(1);
  });

  /**
   * **The worker that is not reached must keep its slot.** Claiming first and
   * checking afterwards would advance `nextRunAt` for a run that never
   * happened, and the worker would wait a whole cadence for a turn it was
   * never given.
   */
  it("does not claim the slot of a worker it will not start", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1"), due("worker-2")]);
    eachRunTakes(MAX_TICK_EXECUTION_MS);

    await dispatchDueWorkers(NOW);

    expect(mocks.claimRoutineSlot).toHaveBeenCalledTimes(1);
    expect(mocks.claimRoutineSlot.mock.calls[0][0]).toBe("worker-1");
  });

  /** It was never attempted, so it is neither a success nor a failure. */
  it("counts a worker it never started as neither dispatched nor failed", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1"), due("worker-2")]);
    eachRunTakes(MAX_TICK_EXECUTION_MS);

    const result = await dispatchDueWorkers(NOW);

    expect(result.dispatched).not.toContain("worker-2");
    expect(result.failed).toBe(0);
  });

  /**
   * The budget is checked between workers, never during one. A worker that was
   * inside the budget when it started runs to completion even though it is what
   * exhausted it.
   */
  it("lets a worker that overruns the budget finish", async () => {
    mocks.getDueWorkers.mockResolvedValue([
      due("worker-1"),
      due("worker-2"),
      due("worker-3"),
    ]);
    // The first leaves a little budget; the second consumes far more than the
    // rest of it and is still allowed to finish.
    const durations = [1_000, MAX_TICK_EXECUTION_MS, 1_000];
    let call = 0;
    mocks.enqueueRoutine.mockImplementation(async () => {
      vi.advanceTimersByTime(durations[call]);
      call += 1;
      return { status: "completed" };
    });

    const result = await dispatchDueWorkers(NOW);

    expect(result.dispatched).toEqual(["worker-1", "worker-2"]);
    expect(mocks.enqueueRoutine).toHaveBeenCalledTimes(2);
  });

  it("stops at exactly the budget, not only past it", async () => {
    mocks.getDueWorkers.mockResolvedValue([due("worker-1"), due("worker-2")]);
    eachRunTakes(MAX_TICK_EXECUTION_MS);

    await dispatchDueWorkers(NOW);

    expect(mocks.enqueueRoutine).toHaveBeenCalledTimes(1);
  });

  it("says so once, when it stops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getDueWorkers.mockResolvedValue([due("worker-1"), due("worker-2")]);
    eachRunTakes(MAX_TICK_EXECUTION_MS);

    await dispatchDueWorkers(NOW);

    const budgetLines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("budget"));

    expect(budgetLines).toHaveLength(1);
    expect(budgetLines[0]).toMatch(/elapsed_ms=/);
    warn.mockRestore();
  });

  /** Nothing about the worker itself belongs in an operational line. */
  it("does not put anything about the worker in that line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getDueWorkers.mockResolvedValue([
      due("worker-1"),
      due("secret-worker-id"),
    ]);
    eachRunTakes(MAX_TICK_EXECUTION_MS);

    await dispatchDueWorkers(NOW);

    const line = warn.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("budget"));

    expect(line).not.toContain("secret-worker-id");
    warn.mockRestore();
  });

  it("has a budget shorter than the response Railway allows", () => {
    expect(MAX_TICK_EXECUTION_MS).toBe(240_000);
  });
});
