import type { RoutineFrequency } from "@/types";

const scheduleLabels: Record<RoutineFrequency, string> = {
  manual: "Manual execution",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

/**
 * How a worker's cadence reads in the UI.
 *
 * Derived from `frequency` rather than stored alongside it: the two used to be
 * separate columns, and nothing stopped a worker that runs daily from
 * advertising itself as weekly. Generating the text means the label cannot
 * disagree with what the dispatcher actually does.
 *
 * The label says how often, not when — `frequency` carries no time of day, so
 * claiming one here would be the same lie in a new place.
 */
export function scheduleLabel(frequency: RoutineFrequency): string {
  return scheduleLabels[frequency];
}
