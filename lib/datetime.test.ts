import { describe, expect, it } from "vitest";
import {
  datePartsIn,
  formatDateTime,
  formatDateTimeWithSeconds,
  minutesIntoDayIn,
} from "@/lib/datetime";

/**
 * What a displayed timestamp says, and what it must never say.
 *
 * A time without a zone is a number that reads as whichever zone the person
 * happens to be in — which is exactly how a run scheduled for 08:50 UTC came to
 * be reported as a missed 08:50 JST. So every displayed timestamp now names the
 * zone it was read in.
 *
 * **The pairing is the property under test.** The digits and the label have to
 * come from one answer: a time converted to UTC and labelled with the string
 * that failed to parse would be a confident lie, where an unlabelled time was
 * merely ambiguous.
 */

/** 2026-08-20 08:50:29 UTC — the instant behind the miss this fixed. */
const INSTANT = new Date("2026-08-20T08:50:29.000Z");

describe("formatDateTime", () => {
  it("reads UTC and says so", () => {
    expect(formatDateTime(INSTANT, "UTC")).toBe("2026-08-20 08:50 UTC");
  });

  it("converts to the account's zone and names it", () => {
    expect(formatDateTime(INSTANT, "Asia/Tokyo")).toBe(
      "2026-08-20 17:50 Asia/Tokyo",
    );
  });

  it("names a zone that observes daylight saving by its identifier", () => {
    expect(formatDateTime(INSTANT, "America/New_York")).toBe(
      "2026-08-20 04:50 America/New_York",
    );
  });

  /**
   * The identifier is printed rather than an abbreviation, so the label does
   * not change with the season while the identifier stays put — and the offset
   * still does, which is the platform's zone rules doing their job.
   */
  it("keeps the identifier across a daylight-saving boundary", () => {
    const winter = new Date("2026-01-20T08:50:29.000Z");

    expect(formatDateTime(winter, "America/New_York")).toBe(
      "2026-01-20 03:50 America/New_York",
    );
    expect(formatDateTime(INSTANT, "America/New_York")).toBe(
      "2026-08-20 04:50 America/New_York",
    );
  });
});

describe("formatDateTimeWithSeconds", () => {
  it("reads UTC and says so", () => {
    expect(formatDateTimeWithSeconds(INSTANT, "UTC")).toBe(
      "2026-08-20 08:50:29 UTC",
    );
  });

  it("converts to the account's zone and names it", () => {
    expect(formatDateTimeWithSeconds(INSTANT, "Asia/Tokyo")).toBe(
      "2026-08-20 17:50:29 Asia/Tokyo",
    );
  });

  it("names a zone that observes daylight saving by its identifier", () => {
    expect(formatDateTimeWithSeconds(INSTANT, "America/New_York")).toBe(
      "2026-08-20 04:50:29 America/New_York",
    );
  });

  /** The zone goes last, so the seconds have to be built in rather than appended. */
  it("puts the seconds before the zone, not after it", () => {
    expect(formatDateTimeWithSeconds(INSTANT, "Asia/Tokyo")).toMatch(
      /\d{2}:\d{2}:\d{2} Asia\/Tokyo$/,
    );
  });
});

/**
 * The case the label makes dangerous.
 *
 * A stored zone can go stale — zones get renamed, and a value can arrive from
 * an older client — and `safeTimezone` answers UTC rather than letting a
 * dashboard fail to render. The label has to follow it there.
 */
describe("a zone this platform cannot read", () => {
  const unusable = ["Mars/Olympus", "", "Not/A/Zone", "Asia/Tokyo ", "utc/utc"];

  it.each(unusable)("falls back to UTC for %o, digits and label together", (
    timezone,
  ) => {
    expect(formatDateTime(INSTANT, timezone)).toBe("2026-08-20 08:50 UTC");
    expect(formatDateTimeWithSeconds(INSTANT, timezone)).toBe(
      "2026-08-20 08:50:29 UTC",
    );
  });

  // The empty string is left out of this one only because every string
  // contains it; the fallback itself is covered above.
  it.each(unusable.filter(Boolean))("never labels a UTC time with %o", (
    timezone,
  ) => {
    expect(formatDateTime(INSTANT, timezone)).not.toContain(timezone.trim());
    expect(formatDateTimeWithSeconds(INSTANT, timezone)).not.toContain(
      timezone.trim(),
    );
  });

  it("labels it exactly once", () => {
    expect(formatDateTime(INSTANT, "UTC").match(/UTC/g)).toHaveLength(1);
    expect(
      formatDateTimeWithSeconds(INSTANT, "Asia/Tokyo").match(/Asia\/Tokyo/g),
    ).toHaveLength(1);
  });
});

/**
 * The zone reading that decides *when* a worker runs, which is a different
 * question from how a timestamp displays. These are asserted here only to fix
 * that adding a label to the display did not disturb them.
 */
describe("the schedule-side readings, unchanged", () => {
  it("still reads the date in the given zone", () => {
    expect(datePartsIn(INSTANT, "Asia/Tokyo")).toEqual({
      year: 2026,
      month: 8,
      day: 20,
    });
    expect(datePartsIn(new Date("2026-08-20T20:00:00.000Z"), "Asia/Tokyo")).toEqual(
      { year: 2026, month: 8, day: 21 },
    );
  });

  it("still reads the time of day in the given zone", () => {
    expect(minutesIntoDayIn(INSTANT, "UTC")).toBe(8 * 60 + 50);
    expect(minutesIntoDayIn(INSTANT, "Asia/Tokyo")).toBe(17 * 60 + 50);
  });

  it("carries no zone label into the values the scheduler reads", () => {
    expect(typeof minutesIntoDayIn(INSTANT, "Asia/Tokyo")).toBe("number");
  });
});
