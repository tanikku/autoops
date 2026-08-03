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
