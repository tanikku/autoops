/**
 * What a server action reports back to the UI.
 *
 * Actions return this instead of redirecting so the client can raise a toast
 * first and navigate afterwards — success no longer travels in the URL.
 */
export type ActionResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export const routineStatuses = ["active", "paused", "draft"] as const;

export type RoutineStatus = (typeof routineStatuses)[number];

export const routineFrequencies = [
  "manual",
  "daily",
  "weekly",
  "monthly",
] as const;

export type RoutineFrequency = (typeof routineFrequencies)[number];

export type Routine = {
  id: string;
  userId: string;
  name: string;
  description: string;
  prompt: string;
  status: RoutineStatus;
  frequency: RoutineFrequency;
  /**
   * Time of day the worker runs, as minutes into the day in the owner's
   * timezone: 0 is midnight, 540 is 09:00. Null keeps whatever time the
   * pending slot already had.
   */
  runAtMinutes: number | null;
  /**
   * Day of the week a weekly worker runs, 0 (Sunday) to 6 (Saturday), in the
   * owner's timezone. Null keeps the weekday the pending slot already falls on.
   */
  runAtWeekday: number | null;
  /**
   * Day of the month a monthly worker runs, 1 to 31, in the owner's timezone.
   * A day past the end of a month runs on that month's last day. Null keeps
   * the day the pending slot already falls on.
   */
  runAtDay: number | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RoutineInput = {
  name: string;
  description: string;
  prompt: string;
  status: RoutineStatus;
  frequency: RoutineFrequency;
  runAtMinutes: number | null;
  runAtWeekday: number | null;
  runAtDay: number | null;
  nextRunAt: Date | null;
};

export const weekdays = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const;

/** 1 to 31, for a month-day select. */
export const monthDays = Array.from({ length: 31 }, (_, index) => index + 1);

/** `1` → `1st`, `22` → `22nd`. Teens are all `th`, which the modulo below allows for. */
export function ordinal(day: number): string {
  const lastTwo = day % 100;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return `${day}th`;
  }

  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

export function isRoutineStatus(value: string): value is RoutineStatus {
  return (routineStatuses as readonly string[]).includes(value);
}

export function isRoutineFrequency(value: string): value is RoutineFrequency {
  return (routineFrequencies as readonly string[]).includes(value);
}

export const runStatuses = ["running", "completed", "failed"] as const;

export type RunStatus = (typeof runStatuses)[number];

export type RunHistory = {
  id: string;
  routineId: string;
  userId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  output: string;
};

/** A run joined with the name of the routine it belongs to. */
export type RunHistoryEntry = RunHistory & { routineName: string };

/** A single run joined with the routine fields the detail view shows. */
export type RunHistoryDetail = RunHistoryEntry & { routinePrompt: string };

export function isRunStatus(value: string): value is RunStatus {
  return (runStatuses as readonly string[]).includes(value);
}
