import type { RoutineFrequency } from "@/types";

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
