import type { RunHistory, RunStatus } from "@/types";

export type WorkerHealth = {
  /** The status of the most recent run, or null if the worker never ran. */
  lastResult: RunStatus | null;
  lastRunAt: Date | null;
  totalRuns: number;
  totalFailures: number;
};

export const NEVER_RUN: WorkerHealth = {
  lastResult: null,
  lastRunAt: null,
  totalRuns: 0,
  totalFailures: 0,
};

/**
 * Folds a worker's runs into its health summary.
 *
 * Expects the newest run first, which is the order every query in `lib/runs`
 * already returns.
 */
export function summarizeRuns(runs: RunHistory[]): WorkerHealth {
  if (runs.length === 0) {
    return NEVER_RUN;
  }

  let totalFailures = 0;
  for (const run of runs) {
    if (run.status === "failed") {
      totalFailures += 1;
    }
  }

  return {
    lastResult: runs[0].status,
    lastRunAt: runs[0].startedAt,
    totalRuns: runs.length,
    totalFailures,
  };
}

/**
 * Health for every worker, from one pass over the runs the dashboard already
 * loaded — no per-worker query, so the card count never drives the query count.
 */
export function groupHealthByWorker(
  runs: RunHistory[],
): Map<string, WorkerHealth> {
  const byWorker = new Map<string, RunHistory[]>();

  for (const run of runs) {
    const existing = byWorker.get(run.routineId);
    if (existing) {
      existing.push(run);
    } else {
      byWorker.set(run.routineId, [run]);
    }
  }

  const health = new Map<string, WorkerHealth>();
  for (const [routineId, workerRuns] of byWorker) {
    health.set(routineId, summarizeRuns(workerRuns));
  }

  return health;
}
