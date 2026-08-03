import { minutesToTimeValue } from "@/lib/worker-input";
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
 * The time is only appended when one was chosen. A worker without it runs at
 * whatever time its slot already held, which no fixed phrase describes.
 */
export function scheduleLabel(
  frequency: RoutineFrequency,
  runAtMinutes: number | null = null,
): string {
  const label = scheduleLabels[frequency];

  if (frequency === "manual" || runAtMinutes === null) {
    return label;
  }

  return `${label} at ${minutesToTimeValue(runAtMinutes)}`;
}
