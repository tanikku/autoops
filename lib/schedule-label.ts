import { t, type TranslationKey } from "@/lib/i18n";
import { minutesToTimeValue } from "@/lib/worker-input";
import { ordinal, type RoutineFrequency } from "@/types";

const cadenceKeys: Record<RoutineFrequency, TranslationKey> = {
  manual: "schedule.manual",
  daily: "schedule.daily",
  weekly: "schedule.weekly",
  monthly: "schedule.monthly",
};

/**
 * Weekday names, by the number the column stores.
 *
 * The index is the stored value — 0 is Sunday — so this is a lookup rather
 * than a second definition of what those numbers mean.
 */
const weekdayKeys: TranslationKey[] = [
  "common.weekday.sunday",
  "common.weekday.monday",
  "common.weekday.tuesday",
  "common.weekday.wednesday",
  "common.weekday.thursday",
  "common.weekday.friday",
  "common.weekday.saturday",
];

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
 *
 * **The language decides the words, never the schedule.** Every branch below is
 * the same one it was before: what changed is where the sentence comes from.
 * The time itself is not reformatted — `minutesToTimeValue` produces the same
 * `HH:mm` it always did, in every language.
 */
export function scheduleLabel(
  frequency: RoutineFrequency,
  runAtMinutes: number | null = null,
  runAtWeekday: number | null = null,
  runAtDay: number | null = null,
  language: string = "en",
): string {
  if (frequency === "manual") {
    return t(language, "schedule.manual");
  }

  const cadence = describeCadence(language, frequency, runAtWeekday, runAtDay);

  return runAtMinutes === null
    ? cadence
    : t(language, "schedule.atTime", {
        cadence,
        time: minutesToTimeValue(runAtMinutes) ?? "",
      });
}

function describeCadence(
  language: string,
  frequency: RoutineFrequency,
  runAtWeekday: number | null,
  runAtDay: number | null,
): string {
  if (frequency === "weekly" && runAtWeekday !== null) {
    const key = weekdayKeys[runAtWeekday];
    if (key) {
      return t(language, "schedule.everyWeekday", { day: t(language, key) });
    }
  }

  if (frequency === "monthly" && runAtDay !== null) {
    // **Both forms are supplied and each language takes the one it needs.**
    // "the 3rd" is an English rule;「毎月3日」wants the bare number, and a
    // Japanese sentence carrying an English ordinal would read as a typo.
    return t(language, "schedule.onDay", {
      ordinal: ordinal(runAtDay),
      day: runAtDay,
    });
  }

  return t(language, cadenceKeys[frequency]);
}
