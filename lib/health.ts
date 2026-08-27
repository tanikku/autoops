import type { RunStatus, RunSummary } from "@/types";

/**
 * How long a `running` row can go without finishing before AutoOps says so.
 *
 * **A product judgement, not a timeout, and not derived from one.** Nothing in
 * execution shares this number: a prompt worker's request is given three
 * minutes, a website change two, the provider's own fallback ten, and the
 * execution lease fifteen. The lease happens to match and is deliberately kept
 * apart — it decides whether a worker may run, and this decides whether to say
 * a run has gone quiet for too long.
 *
 * Fifteen minutes sits above every deadline execution actually applies, so a
 * run still legitimately waiting on a model is never described this way. What
 * it catches is a row nothing will finish: an outcome that could not be
 * written, or a process that stopped between starting a run and recording it.
 *
 * **Display only.** It changes nothing stored, times nothing out, and no write
 * anywhere reads it.
 */
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Whether a run has been `running` for longer than one reasonably takes.
 *
 * **One definition, read by every screen that shows a run.** The health summary
 * asks it about a worker's newest run; the activity list, a worker's own
 * history and an execution's page ask it about each row they draw. Written
 * twice it would be two thresholds, and the second would be the one nobody
 * remembered to move.
 *
 * `now` is passed in rather than read, so a page decides the instant once and
 * every row on it is judged against the same one — and so the boundary is
 * testable at all.
 *
 * **Exactly the threshold is not past it.** A run at fifteen minutes to the
 * millisecond is still just a run.
 */
export function isRunStuck(
  status: RunStatus,
  startedAt: Date,
  now: Date = new Date(),
): boolean {
  return (
    status === "running" &&
    now.getTime() - startedAt.getTime() > STUCK_THRESHOLD_MS
  );
}

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

  const stuck = isRunStuck(summary.lastResult, summary.lastRunAt, now);

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
