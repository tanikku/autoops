import type { RoutineFrequency } from "@/types";

/**
 * Advances a schedule by one interval.
 *
 * The next slot is measured from the slot that just ran — never from the clock
 * — so a cron tick that fires late does not drag the schedule with it. A worker
 * due at 09:00 and dispatched at 09:05 is next due at 09:00 the following day,
 * not 09:05.
 *
 * Pure by design: this file owns the arithmetic and nothing else, so the
 * dispatcher stays the only place that touches the database.
 */
export function advanceNextRunAt(
  frequency: RoutineFrequency,
  currentNextRunAt: Date | null,
): Date | null {
  if (currentNextRunAt === null) {
    return null;
  }

  return calculateNextRunAt(frequency, currentNextRunAt);
}

/** Returns when a routine should next run, or null for manual routines. */
export function calculateNextRunAt(
  frequency: RoutineFrequency,
  from: Date = new Date(),
): Date | null {
  const next = new Date(from);

  switch (frequency) {
    case "manual":
      return null;
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      return next;
  }
}
