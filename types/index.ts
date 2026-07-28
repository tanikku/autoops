export const routineStatuses = ["active", "paused", "draft"] as const;

export type RoutineStatus = (typeof routineStatuses)[number];

export type Routine = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  status: RoutineStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type RoutineInput = {
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  status: RoutineStatus;
};

export function isRoutineStatus(value: string): value is RoutineStatus {
  return (routineStatuses as readonly string[]).includes(value);
}

export const runStatuses = ["running", "completed"] as const;

export type RunStatus = (typeof runStatuses)[number];

export type RunHistory = {
  id: string;
  routineId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  output: string;
};

/** A run joined with the name of the routine it belongs to. */
export type RunHistoryEntry = RunHistory & { routineName: string };

export function isRunStatus(value: string): value is RunStatus {
  return (runStatuses as readonly string[]).includes(value);
}
