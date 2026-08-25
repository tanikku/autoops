import type { Routine, RunSummary } from "@/types";

export type WorkerOverview = {
  total: number;
  active: number;
  paused: number;
  /** The soonest slot among workers the scheduler would actually pick up. */
  nextScheduledRun: Date | null;
  /**
   * Derived, not stored: `nextScheduledRun` exists and has already passed.
   *
   * This says only that the slot is unclaimed — `nextRunAt` advances only
   * when the dispatcher claims it (`claimRoutineSlot`), and nothing else
   * moves it. It does not say *why*: a quiet cron service, a claim that keeps
   * failing, and a slot claimed moments ago are indistinguishable from here.
   */
  nextScheduledRunOverdue: boolean;
  lastExecution: Date | null;
};

/**
 * Whether a worker's own pending slot has passed.
 *
 * Manual workers are excluded by construction: their `nextRunAt` is always
 * null (`lib/schedule.ts`), never a past instant. Paused and draft workers
 * are excluded explicitly — they keep whatever `nextRunAt` they had, but the
 * scheduler never claims it (`lib/scheduler.ts`), so a stale one there is
 * expected rather than a sign of anything overdue.
 *
 * `now` is passed in rather than read, matching `lib/schedule.ts` and
 * `lib/health.ts`'s `summarizeRuns`, so the answer is reproducible.
 */
export function isRunOverdue(
  worker: Pick<Routine, "status" | "nextRunAt">,
  now: Date = new Date(),
): boolean {
  return (
    worker.status === "active" &&
    worker.nextRunAt !== null &&
    worker.nextRunAt < now
  );
}

/**
 * The most recent run anywhere in the account, from the per-worker summaries.
 *
 * **The newest of the newest.** Each summary already carries when its own
 * worker last ran, counted by the database over that worker's whole history, so
 * the account's answer is the greatest of them — and a worker that has never
 * run contributes nothing rather than a zero.
 */
export function latestExecution(
  summaries: Map<string, RunSummary>,
): Date | null {
  let latest: Date | null = null;

  for (const summary of summaries.values()) {
    if (summary.lastRunAt !== null && (latest === null || summary.lastRunAt > latest)) {
      latest = summary.lastRunAt;
    }
  }

  return latest;
}

/**
 * Folds the workers the dashboard already loads into its summary numbers.
 *
 * **Everything counted here comes from `Routine`.** How many workers there are,
 * how many are active, and when the next slot falls are all columns on the
 * worker itself — no run is read to answer any of them, and none ever was.
 *
 * **`lastExecution` is passed in rather than derived here.** It is the one
 * figure on this card that belongs to run history, and it now arrives from the
 * database's own summary instead of from the head of a list of rows. Taking it
 * from a bounded list would happen to be right — the newest of the newest
 * twenty is the newest — and would tie a number that means "ever" to a limit
 * that means "this page".
 */
export function summarizeWorkers(
  routines: Routine[],
  lastExecution: Date | null,
  now: Date = new Date(),
): WorkerOverview {
  let active = 0;
  let paused = 0;
  let nextScheduledRun: Date | null = null;

  for (const routine of routines) {
    if (routine.status === "active") {
      active += 1;
    } else if (routine.status === "paused") {
      paused += 1;
    }

    // Paused and draft workers hold a nextRunAt but are never dispatched, so
    // counting them would advertise a run that will not happen.
    if (
      routine.status === "active" &&
      routine.nextRunAt &&
      (nextScheduledRun === null || routine.nextRunAt < nextScheduledRun)
    ) {
      nextScheduledRun = routine.nextRunAt;
    }
  }

  return {
    total: routines.length,
    active,
    paused,
    nextScheduledRun,
    nextScheduledRunOverdue:
      nextScheduledRun !== null && nextScheduledRun < now,
    lastExecution,
  };
}
