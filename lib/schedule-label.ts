import { minutesToTimeValue } from "@/lib/worker-input";
import { ordinal, weekdays, type RoutineFrequency } from "@/types";

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
  runAtDay: number | null = null,
): string {
  if (frequency === "manual") {
    return scheduleLabels.manual;
  }

  const cadence = describeCadence(frequency, runAtWeekday, runAtDay);

  return runAtMinutes === null
    ? cadence
    : `${cadence} at ${minutesToTimeValue(runAtMinutes)}`;
}

function describeCadence(
  frequency: RoutineFrequency,
  runAtWeekday: number | null,
  runAtDay: number | null,
): string {
  if (frequency === "weekly" && runAtWeekday !== null) {
    const day = weekdays.find((weekday) => weekday.value === runAtWeekday);
    if (day) {
      return `Every ${day.label}`;
    }
  }

  if (frequency === "monthly" && runAtDay !== null) {
    return `On the ${ordinal(runAtDay)}`;
  }

  return scheduleLabels[frequency];
}
