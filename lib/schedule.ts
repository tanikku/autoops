import { datePartsIn, minutesIntoDayIn, zonedTimeToUtc } from "@/lib/datetime";
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
 * Where a schedule goes once `slot` has been taken, catching up at most once.
 *
 * One step forward is the normal answer, and it is the one a punctual tick
 * always gets: a worker due at 09:00 and dispatched at 09:00:05 moves to 09:00
 * tomorrow, not to 09:00:05.
 *
 * **When one step is not enough, the backlog is dropped rather than replayed.**
 * A worker that was due seven times while the service was down would otherwise
 * run seven times on the way back, and those seven runs would not be the seven
 * that were missed: a prompt's date resolves when the run happens, so each one
 * produces today's work. Seven identical results, seven times the cost, and an
 * activity feed full of them. Resuming from `now` instead spends one run
 * getting current and then keeps the ordinary cadence.
 *
 * Deciding that here rather than in the dispatcher is deliberate. What to do
 * about a missed slot is a scheduling policy, and the dispatcher holds none —
 * it asks this module when the next slot falls and writes down the answer.
 *
 * The one thing lost is the count: nothing records how many slots were skipped.
 *
 * Pure, like everything else here. `now` is passed in rather than read, so the
 * decision is reproducible and the module keeps knowing nothing about clocks
 * beyond what it is handed.
 */
export function advanceSchedule(
  schedule: ScheduleInput,
  slot: Date,
  now: Date,
): Date | null {
  const oneStep = calculateNextRunAt(schedule, slot);

  // A step that reaches the future is the whole schedule caught up. Anything
  // else means the slot after this one is missed too, which is the case worth
  // treating differently — a single late tick is not.
  if (oneStep === null || oneStep > now) {
    return oneStep;
  }

  return calculateNextRunAt(schedule, now);
}

/**
 * Returns when a routine should next run, or null for manual routines.
 *
 * `from` is the slot being advanced, not the current time: passing the moment a
 * cron tick happened to fire would drag the schedule along with it.
 *
 * The interval is counted in calendar days *in the owner's zone*, then the
 * day's time is converted back to UTC. Adding 24 hours would be wrong across a
 * daylight-saving change: the stored instant would stay put while the wall
 * clock moved, and "every day at 09:00" would quietly become 10:00 for half the
 * year.
 *
 * **Every frequency takes this route, with or without a chosen time.** There
 * used to be a second one for workers with no `runAtMinutes`, stepping the UTC
 * instant directly. It carried its own month arithmetic, and that copy never
 * received the month-end clamping the calendar path has: a monthly worker due
 * on the 31st of January moved to the 3rd of March and stayed on the 3rd for
 * good. It also read `runAtDay` from nowhere, so choosing a day of the month
 * did nothing unless a time was chosen too, and it stepped through the server's
 * zone rather than the owner's. One route cannot disagree with itself.
 */
export function calculateNextRunAt(
  schedule: ScheduleInput,
  from: Date = new Date(),
): Date | null {
  const { frequency, runAtMinutes, runAtWeekday, runAtDay, timezone } = schedule;

  if (frequency === "manual") {
    return null;
  }

  // No chosen time means the slot keeps the one it already had — read on the
  // owner's clock, which is where a time of day was ever chosen. Reading the
  // UTC instant instead would hold the stored value still while their wall
  // clock moved, which is the same mistake as adding 24 hours.
  const minutesIntoDay = runAtMinutes ?? minutesIntoDayIn(from, timezone);

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
    clampToDay(minutesIntoDay),
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
 * With no `runAtDay`, the day of the slot being advanced plays that role, and
 * is clamped the same way. **The intent is not recovered afterwards, because
 * nothing recorded it.** A slot that borrowed the 28th of February becomes the
 * 28th of March, since the 28th is now all there is to read. Only `runAtDay`
 * says a worker meant the 31st, and only a worker with one returns to it.
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
