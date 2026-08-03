import { datePartsIn, zonedTimeToUtc } from "@/lib/datetime";
import { getUserTimezone } from "@/lib/users";
import type { Routine, RoutineFrequency } from "@/types";

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
  /** IANA zone the time of day is read in. */
  timezone: string;
};

const MINUTES_PER_DAY = 1440;
const DAYS_PER_WEEK = 7;

/**
 * Advances a worker's schedule by one interval.
 *
 * The next slot is measured from the slot that just ran — never from the clock
 * — so a cron tick that fires late does not drag the schedule with it. A worker
 * due at 09:00 and dispatched at 09:05 is next due at 09:00 the following day,
 * not 09:05.
 *
 * Takes the worker rather than its parts so the dispatcher hands over a
 * schedule and asks no questions about it: which fields matter, and where the
 * timezone comes from, are decided here. The arithmetic below stays pure and
 * separately testable; only this entry point reads anything.
 */
export async function advanceNextRunAt(
  worker: Routine,
  currentNextRunAt: Date | null,
): Promise<Date | null> {
  if (currentNextRunAt === null) {
    return null;
  }

  return calculateNextRunAt(
    {
      frequency: worker.frequency,
      runAtMinutes: worker.runAtMinutes,
      runAtWeekday: worker.runAtWeekday,
      timezone: await getUserTimezone(worker.userId),
    },
    currentNextRunAt,
  );
}

/**
 * Returns when a routine should next run, or null for manual routines.
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
  const { frequency, runAtMinutes, runAtWeekday, timezone } = schedule;

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
      local.setUTCMonth(local.getUTCMonth() + 1);
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
