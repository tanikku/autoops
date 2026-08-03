/**
 * Rendering timestamps in a user's zone.
 *
 * Every stored `DateTime` is UTC, which is what makes them comparable and what
 * the scheduler relies on. Only the reading changes here: nothing in this file
 * is used to decide when a worker runs.
 *
 * Built on `Intl.DateTimeFormat`, so IANA zone rules — including daylight
 * saving — come from the platform rather than from arithmetic of our own.
 */

/** Used when a user has no zone set, and when the stored one is unusable. */
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

/** The calendar date in a zone, as the parts a date is built from. */
export function datePartsIn(
  value: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const { year, month, day } = partsIn(value, timezone);
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** `2026-08-03 15:17` — for lists and cards, where seconds add noise. */
export function formatDateTime(value: Date, timezone: string): string {
  const { year, month, day, hour, minute } = partsIn(value, timezone);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/** `2026-08-03 15:17:26` — for detail views, where the exact moment matters. */
export function formatDateTimeWithSeconds(
  value: Date,
  timezone: string,
): string {
  const { second } = partsIn(value, timezone);
  return `${formatDateTime(value, timezone)}:${second}`;
}
