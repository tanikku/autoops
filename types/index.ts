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
