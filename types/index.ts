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
  schedule: string;
  status: RoutineStatus;
  frequency: RoutineFrequency;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RoutineInput = {
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  status: RoutineStatus;
  frequency: RoutineFrequency;
  nextRunAt: Date | null;
};

export function isRoutineStatus(value: string): value is RoutineStatus {
  return (routineStatuses as readonly string[]).includes(value);
}

export function isRoutineFrequency(value: string): value is RoutineFrequency {
  return (routineFrequencies as readonly string[]).includes(value);
}

export const runStatuses = ["running", "completed"] as const;

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
