import type { Routine, RunHistoryEntry } from "@/types";

export type WorkerOverview = {
  total: number;
  active: number;
  paused: number;
  /** The soonest slot among workers the scheduler would actually pick up. */
  nextScheduledRun: Date | null;
  lastExecution: Date | null;
};

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
    // Runs arrive newest first, so the head is the most recent execution.
    lastExecution: runs[0]?.startedAt ?? null,
  };
}
