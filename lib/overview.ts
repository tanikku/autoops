import type { Routine, RunHistoryEntry } from "@/types";

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
 * Folds the rows the dashboard already loads into its summary numbers.
 *
 * Deliberately a pure function over data in hand rather than a set of
 * aggregate queries: the dashboard reads every worker and every run anyway, so
 * counting them here costs no extra round trips.
 */
export function summarizeWorkers(
  routines: Routine[],
  runs: RunHistoryEntry[],
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
    // Runs arrive newest first, so the head is the most recent execution.
    lastExecution: runs[0]?.startedAt ?? null,
  };
}
