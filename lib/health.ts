import type { RunHistory, RunStatus } from "@/types";

/**
 * How long a `running` row can go without finishing before the dashboard
 * treats it as possibly stuck, rather than genuinely in progress.
 *
 * Set comfortably above the ten minutes `ClaudeProvider` allows one request
 * (`lib/ai/claude-provider.ts`), so a run that is still legitimately waiting
 * on the model is never flagged. This is a display threshold only — it does
 * not change what is stored, and nothing times a run out because of it.
 */
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

export type WorkerHealth = {
  /** The status of the most recent run, or null if the worker never ran. */
  lastResult: RunStatus | null;
  lastRunAt: Date | null;
  totalRuns: number;
  totalFailures: number;
  /**
   * Derived, not stored: the most recent run is still `running` and started
   * longer ago than a run reasonably takes. Never true for `completed` or
   * `failed` — those already have an answer.
   */
  stuck: boolean;
};

export const NEVER_RUN: WorkerHealth = {
  lastResult: null,
  lastRunAt: null,
  totalRuns: 0,
  totalFailures: 0,
  stuck: false,
};

/**
 * Folds a worker's runs into its health summary.
 *
 * Expects the newest run first, which is the order every query in `lib/runs`
 * already returns. `now` is passed in rather than read, matching
 * `lib/schedule.ts`'s convention, so the answer is reproducible.
 */
export function summarizeRuns(
  runs: RunHistory[],
  now: Date = new Date(),
): WorkerHealth {
  if (runs.length === 0) {
    return NEVER_RUN;
  }

  let totalFailures = 0;
  for (const run of runs) {
    if (run.status === "failed") {
      totalFailures += 1;
    }
  }

  const latest = runs[0];
  const stuck =
    latest.status === "running" &&
    now.getTime() - latest.startedAt.getTime() > STUCK_THRESHOLD_MS;

  return {
    lastResult: latest.status,
    lastRunAt: latest.startedAt,
    totalRuns: runs.length,
    totalFailures,
    stuck,
  };
}

/**
 * Health for every worker, from one pass over the runs the dashboard already
 * loaded — no per-worker query, so the card count never drives the query count.
 */
export function groupHealthByWorker(
  runs: RunHistory[],
  now: Date = new Date(),
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
    health.set(routineId, summarizeRuns(workerRuns, now));
  }

  return health;
}
