/**
 * What a server action reports back to the UI.
 *
 * Actions return this instead of redirecting so the client can raise a toast
 * first and navigate afterwards — success no longer travels in the URL.
 */
export type ActionResult =
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/**
 * What a worker does when it runs.
 *
 * `prompt` sends the prompt it holds to the model, which is every worker that
 * existed before watchers did. `website` reads a page first and only involves
 * the model when the page has changed.
 *
 * **A closed set narrowed from a plain string column**, the same shape as
 * `status` and `frequency`, so adding a kind is a line here rather than a
 * migration.
 */
export const routineKinds = ["prompt", "website"] as const;

export type RoutineKind = (typeof routineKinds)[number];

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
  /** What the worker does when it runs. See `RoutineKind`. */
  kind: RoutineKind;
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

export function isRoutineKind(value: string): value is RoutineKind {
  return (routineKinds as readonly string[]).includes(value);
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
  /** What the model produced. Empty on a run that failed or is still going. */
  output: string;
  /**
   * Why a run failed, or null when it did not.
   *
   * Kept apart from `output` so neither has to be read through `status` to
   * know what it is. It is a diagnostic — a provider's wording, or a driver's
   * — which is why it belongs on one execution's page rather than in a list.
   */
  errorMessage: string | null;
};

/** A run joined with the name of the routine it belongs to. */
export type RunHistoryEntry = RunHistory & { routineName: string };

/** A single run joined with the routine fields the detail view shows. */
export type RunHistoryDetail = RunHistoryEntry & { routinePrompt: string };

export function isRunStatus(value: string): value is RunStatus {
  return (runStatuses as readonly string[]).includes(value);
}

/**
 * The page a `website` worker watches.
 *
 * Configuration only — what was last seen there is a `WebsiteSnapshot`, and the
 * two are apart so that reading the settings never carries a page with it.
 *
 * **No owner of its own.** Who this belongs to is who owns `routineId`, and
 * there is exactly one place that says so.
 */
export type WebsiteSource = {
  id: string;
  routineId: string;
  url: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The baseline a change is measured against.
 *
 * **Its absence is a state.** There is no snapshot until a page has been read
 * successfully once, and that is what "nothing to compare against yet" looks
 * like — not an empty string, and not a row full of nulls.
 *
 * `normalizedContent` is text extracted from the page, never raw HTML, and
 * nothing sends it to a browser: it is read while a run is happening and
 * nowhere else.
 */
export type WebsiteSnapshot = {
  id: string;
  websiteSourceId: string;
  normalizedContent: string;
  contentHash: string;
  lastCheckedAt: Date;
  /**
   * When the page last differed from what was already here, or null if it never
   * has.
   *
   * **Establishing a baseline is not observing a change.** A first read has
   * nothing to differ from, so this stays null until the page actually changes
   * — which keeps "nothing has happened since we started watching" distinct
   * from "something happened at the moment we started".
   */
  lastChangedAt: Date | null;
  createdAt: Date;
};
