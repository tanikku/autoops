export type RoutineStatus = "active" | "paused" | "draft";

export type Routine = {
  id: string;
  name: string;
  schedule: string;
  status: RoutineStatus;
};
