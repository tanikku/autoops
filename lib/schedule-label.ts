import { minutesToTimeValue } from "@/lib/worker-input";
import { weekdays, type RoutineFrequency } from "@/types";

const scheduleLabels: Record<RoutineFrequency, string> = {
  manual: "Manual execution",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

/**
 * How a worker's cadence reads in the UI.
 *
 * Derived from the schedule rather than stored alongside it: the two used to be
 * separate columns, and nothing stopped a worker that runs daily from
 * advertising itself as weekly. Generating the text means the label cannot
 * disagree with what the dispatcher actually does.
 *
 * Each part is only mentioned once chosen. A worker without a weekday runs on
 * whichever one its slot already falls on, and one without a time at whatever
 * hour it already held — neither of which a fixed phrase describes.
 */
export function scheduleLabel(
  frequency: RoutineFrequency,
  runAtMinutes: number | null = null,
  runAtWeekday: number | null = null,
): string {
  if (frequency === "manual") {
    return scheduleLabels.manual;
  }

  const day =
    frequency === "weekly" && runAtWeekday !== null
      ? weekdays.find((weekday) => weekday.value === runAtWeekday)?.label
      : undefined;

  const cadence = day ? `Every ${day}` : scheduleLabels[frequency];

  return runAtMinutes === null
    ? cadence
    : `${cadence} at ${minutesToTimeValue(runAtMinutes)}`;
}
