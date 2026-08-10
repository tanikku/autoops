import { describe, expect, it } from "vitest";
import { groupHealthByWorker, NEVER_RUN, summarizeRuns } from "@/lib/health";
import type { RunHistory } from "@/types";

/**
 * These fix the reading, not the storing.
 *
 * Every value here is derived at read time from `status` and `startedAt`, and
 * `stuck` most of all — it is the one field with a threshold behind it, and the
 * one a change to `lib/ai/claude-provider.ts`'s ten minutes would quietly
 * invalidate. What the boundary cases below record is that fifteen minutes is
 * the line and that reaching it exactly is not past it.
 *
 * `now` is passed in everywhere rather than allowed to be read, which is what
 * makes any of this testable at all.
 */

const NOW = new Date("2026-08-10T12:00:00.000Z");

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** A run of `worker-1`, defaulting to one that finished a moment ago. */
function run(overrides: Partial<RunHistory> = {}): RunHistory {
  return {
    id: "run-1",
    routineId: "worker-1",
    userId: "user-1",
    status: "completed",
    startedAt: new Date("2026-08-10T11:59:00.000Z"),
    finishedAt: new Date("2026-08-10T11:59:30.000Z"),
    output: "",
    errorMessage: null,
    ...overrides,
  };
}

/** A run still in progress, started `ms` before `NOW`. */
function runningFor(ms: number): RunHistory {
  return run({
    status: "running",
    startedAt: new Date(NOW.getTime() - ms),
    finishedAt: null,
  });
}

describe("summarizeRuns", () => {
  it("reports a worker that never ran", () => {
    expect(summarizeRuns([], NOW)).toEqual(NEVER_RUN);
  });

  it("takes the last result from the newest run", () => {
    const health = summarizeRuns(
      [run({ id: "newest", status: "failed" }), run({ id: "older" })],
      NOW,
    );

    expect(health.lastResult).toBe("failed");
  });

  it("reports when the newest run started, not when it finished", () => {
    const startedAt = new Date("2026-08-10T11:00:00.000Z");

    expect(summarizeRuns([run({ startedAt })], NOW).lastRunAt).toEqual(
      startedAt,
    );
  });

  it("counts every run and every failure", () => {
    const health = summarizeRuns(
      [
        run({ id: "a", status: "failed" }),
        run({ id: "b" }),
        run({ id: "c", status: "failed" }),
      ],
      NOW,
    );

    expect(health.totalRuns).toBe(3);
    expect(health.totalFailures).toBe(2);
  });

  /**
   * A run in progress is not a failure and must not be counted as one — the
   * failure total is what makes the health summary worth reading.
   */
  it("does not count a run still in progress as a failure", () => {
    expect(summarizeRuns([runningFor(0)], NOW).totalFailures).toBe(0);
  });

  describe("stuck", () => {
    it("is false for a run that has only just started", () => {
      expect(summarizeRuns([runningFor(0)], NOW).stuck).toBe(false);
    });

    /**
     * The threshold is `>`, so arriving at fifteen minutes is not past it. A
     * run allowed ten minutes by the provider is comfortably inside.
     */
    it("is false at exactly fifteen minutes", () => {
      expect(summarizeRuns([runningFor(FIFTEEN_MINUTES_MS)], NOW).stuck).toBe(
        false,
      );
    });

    it("is true a millisecond past fifteen minutes", () => {
      expect(
        summarizeRuns([runningFor(FIFTEEN_MINUTES_MS + 1)], NOW).stuck,
      ).toBe(true);
    });

    /**
     * `completed` and `failed` already have an answer, so age says nothing
     * about them — only a run with no outcome can be waiting for one.
     */
    it("is false for an old run that finished", () => {
      const finished = run({
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(summarizeRuns([finished], NOW).stuck).toBe(false);
    });

    it("is false for an old run that failed", () => {
      const failed = run({
        status: "failed",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(summarizeRuns([failed], NOW).stuck).toBe(false);
    });

    /**
     * Only the newest run is asked. An old run left `running` for good does
     * not make a worker that has succeeded since look stuck.
     */
    it("ignores an older run left running", () => {
      const health = summarizeRuns(
        [run({ id: "newest" }), runningFor(FIFTEEN_MINUTES_MS + 1)],
        NOW,
      );

      expect(health.stuck).toBe(false);
    });
  });
});

describe("groupHealthByWorker", () => {
  it("summarises each worker from one pass", () => {
    const health = groupHealthByWorker(
      [
        run({ id: "a", routineId: "worker-1", status: "failed" }),
        run({ id: "b", routineId: "worker-2" }),
        run({ id: "c", routineId: "worker-1" }),
      ],
      NOW,
    );

    expect(health.get("worker-1")?.totalRuns).toBe(2);
    expect(health.get("worker-1")?.totalFailures).toBe(1);
    expect(health.get("worker-2")?.totalRuns).toBe(1);
  });

  /**
   * The newest-first order the queries return is what `summarizeRuns` reads
   * `lastResult` from, and grouping has to preserve it per worker.
   */
  it("keeps the newest run first within a worker", () => {
    const health = groupHealthByWorker(
      [
        run({ id: "newest", status: "failed" }),
        run({ id: "older", status: "completed" }),
      ],
      NOW,
    );

    expect(health.get("worker-1")?.lastResult).toBe("failed");
  });

  it("has no entry for a worker with no runs", () => {
    expect(groupHealthByWorker([], NOW).get("worker-1")).toBeUndefined();
  });
});
