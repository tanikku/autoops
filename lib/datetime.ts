/**
 * Rendering timestamps in a user's zone.
 *
 * Every stored `DateTime` is UTC, which is what makes them comparable and what
 * the scheduler relies on. A zone changes how an instant reads, never what is
 * stored.
 *
 * **Three of these are also read when deciding *when* a worker runs.**
 * `lib/schedule.ts` steps through the calendar in the owner's zone rather than
 * through UTC, so it asks here for the date (`datePartsIn`), the time of day
 * (`minutesIntoDayIn`), and the instant a local time lands on
 * (`zonedTimeToUtc`). Changing what any of the three answers changes what gets
 * dispatched, not only what a page displays.
 *
 * Built on `Intl.DateTimeFormat`, so IANA zone rules — including daylight
 * saving — come from the platform rather than from arithmetic of our own.
 */

/**
 * Used when a stored zone is unusable — renamed, truncated, or from an older
 * client — so a dashboard still renders instead of throwing.
 *
 * **Not what a new account gets.** That is `NEW_ACCOUNT_TIMEZONE`, which
 * tracks `User.timezone`'s column default. This one answers a different
 * question: an unreadable value is a fault, and UTC states the stored instant
 * with no offset invented on top of it.
 */
export const DEFAULT_TIMEZONE = "UTC";

/**
 * Falls back rather than throwing.
 *
 * `Intl` rejects an unknown zone with a RangeError. A stored value can go stale
 * — zones are renamed, and one could arrive from an older client — and a
 * dashboard that will not render is a worse answer than one showing UTC.
 */
function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

type Parts = Record<Intl.DateTimeFormatPartTypes, string>;

function partsIn(value: Date, timezone: string): Parts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // h23 rather than the locale's preference: 00:30 reads unambiguously, and
    // the output is fixed-width, so timestamps line up in a column.
    hourCycle: "h23",
  });

  const parts = {} as Parts;
  for (const part of formatter.formatToParts(value)) {
    parts[part.type] = part.value;
  }

  return parts;
}

/**
 * How far the zone is ahead of UTC at a given instant, in minutes.
 *
 * Read by asking `Intl` what the wall clock says there and subtracting: the
 * offset is whatever the platform's zone rules produce, which is how daylight
 * saving is handled without any rules of our own.
 */
function offsetMinutes(at: Date, timezone: string): number {
  const { year, month, day, hour, minute, second } = partsIn(at, timezone);

  const wallClock = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  // Milliseconds are dropped by the formatter, so compare on whole seconds.
  const instant = Math.floor(at.getTime() / 1000) * 1000;

  return (wallClock - instant) / 60_000;
}

/**
 * The UTC instant at which a zone's clock reads the given date and time.
 *
 * The inverse of reading a timestamp, and the reason it needs care: the offset
 * depends on the instant, and the instant is what we are solving for. Guess
 * with the offset in force at the naive time, then correct once using the
 * offset actually in force at the guess.
 *
 * Two cases have no clean answer, both around a daylight-saving change, and
 * both verified rather than assumed:
 *
 * - **A time that does not exist** (clocks jumped forward over it). The result
 *   lands just before the jump — 02:30 on a spring-forward day comes back as
 *   01:30. The worker runs, once, half an hour early.
 * - **A time that happens twice** (clocks went back). The first occurrence is
 *   returned, so the worker runs once rather than twice.
 *
 * Both matter twice a year, and only in zones that observe the change.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesIntoDay: number,
  timezone: string,
): Date {
  const naive = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutesIntoDay / 60),
    minutesIntoDay % 60,
  );

  const firstGuess = new Date(naive - offsetMinutes(new Date(naive), timezone) * 60_000);

  // One correction is enough: offsets shift by an hour at most, and the second
  // reading is taken at an instant already within an hour of the answer.
  return new Date(
    naive - offsetMinutes(firstGuess, timezone) * 60_000,
  );
}

/**
 * The time of day in a zone, as minutes into the day.
 *
 * The inverse of what `runAtMinutes` stores, and read for the same purpose: a
 * worker with no chosen time keeps the time its pending slot already had, and
 * that time means the one on the owner's clock. Reading the UTC instant instead
 * would hold the stored value still while their wall clock moved.
 *
 * Seconds are dropped, so a slot advanced from one carrying them comes back on
 * the minute.
 */
export function minutesIntoDayIn(value: Date, timezone: string): number {
  const { hour, minute } = partsIn(value, timezone);
  return Number(hour) * 60 + Number(minute);
}

/** The calendar date in a zone, as the parts a date is built from. */
export function datePartsIn(
  value: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const { year, month, day } = partsIn(value, timezone);
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/**
 * Both formatters below name the zone they read the instant in, and resolve it
 * once so that the digits and the label cannot disagree.
 *
 * **`safeTimezone` is why that matters.** It falls back to UTC for a zone
 * `Intl` will not accept, so a formatter that used the fallback for the
 * arithmetic but printed the string it was given would produce
 * `2026-08-21 08:50 Mars/Olympus` — a time in one zone labelled as another,
 * which is worse than no label, because it looks like information.
 *
 * **The identifier is printed as stored rather than as an abbreviation.**
 * `Intl`'s short names are neither uniform nor stable: on the runtime this was
 * checked against, `Asia/Tokyo` renders as `GMT+9` rather than `JST` while
 * `America/New_York` renders as `EDT`, so one option yields an offset for one
 * reader and a three-letter code for another — and both answers depend on the
 * locale and on the platform's ICU data. `Asia/Tokyo` says the same thing
 * everywhere, and it is the value the account is actually set to.
 */

/** `2026-08-03 15:17 Asia/Tokyo` — for lists and cards, where seconds add noise. */
export function formatDateTime(value: Date, timezone: string): string {
  const zone = safeTimezone(timezone);
  const { year, month, day, hour, minute } = partsIn(value, zone);
  return `${year}-${month}-${day} ${hour}:${minute} ${zone}`;
}

/**
 * `2026-08-03 15:17:26 Asia/Tokyo` — for detail views, where the exact moment
 * matters.
 *
 * Built from the parts rather than by appending to `formatDateTime`: the zone
 * now sits at the end of that string, so seconds added afterwards would land
 * behind it.
 */
export function formatDateTimeWithSeconds(
  value: Date,
  timezone: string,
): string {
  const zone = safeTimezone(timezone);
  const { year, month, day, hour, minute, second } = partsIn(value, zone);
  return `${year}-${month}-${day} ${hour}:${minute}:${second} ${zone}`;
}
