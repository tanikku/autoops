import { datePartsIn, zonedTimeToUtc } from "@/lib/datetime";
import type { RoutineFrequency } from "@/types";

/**
 * Scheduling arithmetic, and nothing else.
 *
 * Every function here is pure: the module reads no rows, so what it returns
 * depends only on what it was handed. Callers resolve the owner's timezone and
 * pass it in — the dashboard actions from the signed-in session, the dispatcher
 * from the worker being advanced.
 */

/**
 * What a schedule is made of: how often, at what time of day, and whose clock
 * that time refers to.
 *
 * Grouped rather than passed as loose arguments so a caller cannot supply the
 * frequency and forget the time — the three only mean something together.
 */
export type ScheduleInput = {
  frequency: RoutineFrequency;
  /** Minutes into the day in the owner's zone, or null to keep the time of the slot being advanced. */
  runAtMinutes: number | null;
  /** 0 (Sunday) to 6 (Saturday) in the owner's zone, or null to keep the weekday of the slot being advanced. */
  runAtWeekday: number | null;
  /** 1 to 31 in the owner's zone, or null to keep the day of the slot being advanced. */
  runAtDay: number | null;
  /** IANA zone the time of day is read in. */
  timezone: string;
};

const MINUTES_PER_DAY = 1440;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH_MAX = 31;

/**
 * Returns when a routine should next run, or null for manual routines.
 *
 * `from` is the slot being advanced, not the current time: passing the moment a
 * cron tick happened to fire would drag the schedule along with it.
 *
 * With a `runAtMinutes` the interval is counted in calendar days *in the
 * owner's zone*, then that day's chosen time is converted back to UTC. Adding
 * 24 hours would be wrong across a daylight-saving change: the stored instant
 * would stay put while the wall clock moved, and "every day at 09:00" would
 * quietly become 10:00 for half the year.
 *
 * Without one, the interval is added to the instant directly and whatever time
 * of day the worker already had is preserved — the behaviour every worker had
 * before times could be chosen, and what rows created then still get.
 */
export function calculateNextRunAt(
  schedule: ScheduleInput,
  from: Date = new Date(),
): Date | null {
  const { frequency, runAtMinutes, runAtWeekday, runAtDay, timezone } = schedule;

  if (frequency === "manual") {
    return null;
  }

  if (runAtMinutes === null) {
    return addInterval(frequency, from);
  }

  // Step through the calendar in the owner's zone: the same date arithmetic,
  // but applied to the local day rather than to a UTC instant.
  const { year, month, day } = datePartsIn(from, timezone);
  const local = new Date(Date.UTC(year, month - 1, day));

  switch (frequency) {
    case "daily":
      local.setUTCDate(local.getUTCDate() + 1);
      break;
    case "weekly":
      local.setUTCDate(
        local.getUTCDate() +
          (runAtWeekday === null
            ? DAYS_PER_WEEK
            : daysUntilWeekday(local.getUTCDay(), clampToWeek(runAtWeekday))),
      );
      break;
    case "monthly":
      advanceMonth(local, runAtDay);
      break;
  }

  return zonedTimeToUtc(
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    clampToDay(runAtMinutes),
    timezone,
  );
}

/**
 * Days forward from one weekday to the next occurrence of another.
 *
 * **Landing on the same weekday returns 7, not 0.** Every branch above moves
 * at least one day for the same reason: this produces the *next* slot, and the
 * day it is called for has already been dispatched. Returning 0 would schedule
 * a second run on a day that just ran.
 *
 * That is a decision rather than an edge case, and it is the behaviour a
 * catch-up strategy would be changing. As things stand, a weekly worker
 * advances exactly one week per tick, so several missed slots take several
 * ticks to work through.
 */
function daysUntilWeekday(current: number, target: number): number {
  return ((target - current) % DAYS_PER_WEEK + DAYS_PER_WEEK) % DAYS_PER_WEEK
    || DAYS_PER_WEEK;
}

/** Day 0 of the following month is the last day of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Moves to the chosen day of next month, or to that month's last day when it
 * is shorter.
 *
 * **`setUTCMonth` cannot be used for this.** A day past the end of the target
 * month rolls into the one after: the 31st of January becomes the 3rd of
 * March. Worse, the rolled value then becomes the basis for the next step, so
 * a worker set for month-end quietly turns into one that runs on the 3rd and
 * never returns. Setting the year, month and day together avoids the roll,
 * because the day is already known to fit.
 *
 * The clamping is not remembered. `runAtDay` stays the intent and the landed
 * date is only a consequence of it, so February borrows the 28th without March
 * inheriting it — the 31st comes back the following month.
 *
 * With no `runAtDay`, the day of the slot being advanced plays that role. It
 * is clamped the same way, which is a change from what this did before: it
 * used to roll, and a monthly worker created on the 31st would drift to the
 * 3rd and stay there.
 */
function advanceMonth(local: Date, runAtDay: number | null): void {
  const targetDay =
    runAtDay === null ? local.getUTCDate() : clampToMonth(runAtDay);

  const month = local.getUTCMonth() + 1;
  const rollsOver = month > 11;
  const year = rollsOver ? local.getUTCFullYear() + 1 : local.getUTCFullYear();
  const nextMonth = rollsOver ? 0 : month;

  local.setUTCFullYear(
    year,
    nextMonth,
    Math.min(targetDay, daysInMonth(year, nextMonth)),
  );
}

/** Adds one interval to an instant, leaving its time of day alone. */
function addInterval(
  frequency: Exclude<RoutineFrequency, "manual">,
  from: Date,
): Date {
  const next = new Date(from);

  switch (frequency) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      return next;
  }
}

/**
 * Keeps a stored value inside a day.
 *
 * The form validates the range, but this reads from the database, where a row
 * could predate that check or have been written by hand.
 */
function clampToDay(minutes: number): number {
  return Math.min(Math.max(Math.trunc(minutes), 0), MINUTES_PER_DAY - 1);
}

/** The same guard for a weekday, which the form constrains but the column does not. */
function clampToWeek(weekday: number): number {
  return Math.min(Math.max(Math.trunc(weekday), 0), DAYS_PER_WEEK - 1);
}

/**
 * The same guard for a day of the month.
 *
 * Clamps to 31 rather than to the length of any particular month: which month
 * this lands in is not known here, and shortening it is what `advanceMonth`
 * does with the answer.
 */
function clampToMonth(day: number): number {
  return Math.min(Math.max(Math.trunc(day), 1), DAYS_PER_MONTH_MAX);
}
