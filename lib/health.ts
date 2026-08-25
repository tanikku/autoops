import type { RunStatus, RunSummary } from "@/types";

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
  summary: RunSummary,
  now: Date = new Date(),
): WorkerHealth {
  if (summary.lastResult === null || summary.lastRunAt === null) {
    return NEVER_RUN;
  }

  const stuck =
    summary.lastResult === "running" &&
    now.getTime() - summary.lastRunAt.getTime() > STUCK_THRESHOLD_MS;

  return {
    lastResult: summary.lastResult,
    lastRunAt: summary.lastRunAt,
    totalRuns: summary.totalRuns,
    totalFailures: summary.totalFailures,
    stuck,
  };
}

/**
 * Health for every worker, from summaries the database already counted.
 *
 * **Still one query behind it, and still no per-worker query** — what changed
 * is that the query returns one row per worker per status instead of every run
 * the account has ever had. The card count has never driven the query count and
 * does not now; what it stopped driving is the row count.
 */
export function groupHealthByWorker(
  summaries: Map<string, RunSummary>,
  now: Date = new Date(),
): Map<string, WorkerHealth> {
  const health = new Map<string, WorkerHealth>();

  for (const [routineId, summary] of summaries) {
    health.set(routineId, summarizeRuns(summary, now));
  }

  return health;
}
