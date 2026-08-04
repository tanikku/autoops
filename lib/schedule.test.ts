import { describe, expect, it } from "vitest";
import { calculateNextRunAt, type ScheduleInput } from "@/lib/schedule";

/**
 * The public surface is one function, so that is what these exercise. The
 * arithmetic underneath — weekday stepping, month-end clamping, the range
 * guards — is reached through it rather than exported for the occasion:
 * widening the API to suit a test would make the test the reason the module
 * looks the way it does.
 */

const NEW_YORK = "America/New_York";
const TOKYO = "Asia/Tokyo";

/** 09:00, as minutes into the day. Used wherever the time itself is incidental. */
const NINE_AM = 540;

const anyWorker: ScheduleInput = {
  frequency: "manual",
  runAtMinutes: null,
  runAtWeekday: null,
  runAtDay: null,
  timezone: "UTC",
};

/** The instant a worker with `overrides` would next be due, as an ISO string. */
function nextRun(
  overrides: Partial<ScheduleInput>,
  from: string,
): string | undefined {
  return calculateNextRunAt(
    { ...anyWorker, ...overrides },
    new Date(from),
  )?.toISOString();
}

// A Tuesday, chosen so a weekly test can move forwards, backwards or nowhere.
const TUESDAY = "2026-08-04T00:00:00.000Z";

describe("calculateNextRunAt", () => {
  it("never schedules a manual worker", () => {
    expect(nextRun({ frequency: "manual" }, TUESDAY)).toBeUndefined();
  });

  describe("daily", () => {
    it("moves to the chosen time on the next day in the owner's zone", () => {
      expect(
        nextRun(
          { frequency: "daily", runAtMinutes: NINE_AM, timezone: TOKYO },
          TUESDAY,
        ),
      ).toBe("2026-08-05T00:00:00.000Z"); // 09:00 in Tokyo
    });

    it("keeps the existing time of day when none was chosen", () => {
      // Without a chosen time the interval is added to the instant itself, so
      // the result carries whatever time the slot already had.
      expect(
        nextRun({ frequency: "daily" }, "2026-08-04T03:21:00.000Z"),
      ).toBe("2026-08-05T03:21:00.000Z");
    });
  });

  describe("weekly", () => {
    it("moves forward to the chosen weekday", () => {
      // Tuesday to Wednesday is one day.
      expect(
        nextRun(
          { frequency: "weekly", runAtMinutes: NINE_AM, runAtWeekday: 3 },
          TUESDAY,
        ),
      ).toBe("2026-08-05T09:00:00.000Z");
    });

    it("waits a full week when the chosen weekday is today", () => {
      // The day this is called for has already been dispatched, so landing on
      // the same weekday means next week — never a second run today.
      expect(
        nextRun(
          { frequency: "weekly", runAtMinutes: NINE_AM, runAtWeekday: 2 },
          TUESDAY,
        ),
      ).toBe("2026-08-11T09:00:00.000Z");
    });

    it("adds a week when no weekday was chosen", () => {
      expect(
        nextRun({ frequency: "weekly", runAtMinutes: NINE_AM }, TUESDAY),
      ).toBe("2026-08-11T09:00:00.000Z");
    });
  });

  describe("monthly", () => {
    it("moves to the chosen day of the following month", () => {
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 15 },
          TUESDAY,
        ),
      ).toBe("2026-09-15T09:00:00.000Z");
    });

    it("borrows the last day of a month too short for the chosen one", () => {
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 31 },
          "2026-01-15T00:00:00.000Z",
        ),
      ).toBe("2026-02-28T09:00:00.000Z");
    });

    it("returns to the chosen day the month after borrowing", () => {
      // The clamp is not remembered: February borrows the 28th without March
      // inheriting it. Fed the previous result, this is the second tick.
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 31 },
          "2026-02-28T09:00:00.000Z",
        ),
      ).toBe("2026-03-31T09:00:00.000Z");
    });

    it("rolls the year over from December", () => {
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 10 },
          "2026-12-10T09:00:00.000Z",
        ),
      ).toBe("2027-01-10T09:00:00.000Z");
    });

    it("uses the 29th in a leap February", () => {
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 31 },
          "2028-01-15T00:00:00.000Z",
        ),
      ).toBe("2028-02-29T09:00:00.000Z");
    });
  });

  describe("values the column allows but the form does not", () => {
    // The form validates these ranges; a row could predate that check or have
    // been written by hand, so the arithmetic guards them too.
    it("keeps a time of day inside the day", () => {
      expect(nextRun({ frequency: "daily", runAtMinutes: 2000 }, TUESDAY)).toBe(
        "2026-08-05T23:59:00.000Z",
      );
      expect(nextRun({ frequency: "daily", runAtMinutes: -5 }, TUESDAY)).toBe(
        "2026-08-05T00:00:00.000Z",
      );
    });

    it("keeps a weekday inside the week", () => {
      // 9 becomes Saturday, which is four days after this Tuesday.
      expect(
        nextRun(
          { frequency: "weekly", runAtMinutes: NINE_AM, runAtWeekday: 9 },
          TUESDAY,
        ),
      ).toBe("2026-08-08T09:00:00.000Z");
    });

    it("keeps a day of the month inside the month", () => {
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 0 },
          TUESDAY,
        ),
      ).toBe("2026-09-01T09:00:00.000Z");

      // 99 clamps to 31, which September then shortens to 30.
      expect(
        nextRun(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 99 },
          TUESDAY,
        ),
      ).toBe("2026-09-30T09:00:00.000Z");
    });
  });

  describe("timezone", () => {
    it("reads the chosen time in the owner's zone, not in UTC", () => {
      const utc = nextRun(
        { frequency: "daily", runAtMinutes: NINE_AM },
        TUESDAY,
      );
      const tokyo = nextRun(
        { frequency: "daily", runAtMinutes: NINE_AM, timezone: TOKYO },
        TUESDAY,
      );

      expect(utc).toBe("2026-08-05T09:00:00.000Z");
      expect(tokyo).toBe("2026-08-05T00:00:00.000Z");
      expect(
        new Date(utc!).getTime() - new Date(tokyo!).getTime(),
      ).toBe(9 * 60 * 60 * 1000);
    });

    it("falls back to UTC for a zone the platform does not know", () => {
      // A stored zone can go stale, and a schedule that throws is worse than
      // one an hour off.
      expect(
        nextRun(
          {
            frequency: "daily",
            runAtMinutes: NINE_AM,
            timezone: "Mars/Olympus_Mons",
          },
          TUESDAY,
        ),
      ).toBe("2026-08-05T09:00:00.000Z");
    });
  });

  /**
   * These record what happens today rather than what ought to happen. Both
   * cases are unavoidable — the wall clock genuinely skips an hour and
   * genuinely repeats one — so the value of pinning them is that a change
   * shows up as a failing test instead of as one odd run twice a year.
   */
  describe("daylight saving", () => {
    it("lands just before the gap when the chosen time does not exist", () => {
      // Clocks jump 02:00 to 03:00 on 2026-03-08 in New York, so 02:30 never
      // happens. The worker runs at 01:30 EST — half an hour early, once.
      expect(
        nextRun(
          { frequency: "daily", runAtMinutes: 150, timezone: NEW_YORK },
          "2026-03-07T12:00:00.000Z",
        ),
      ).toBe("2026-03-08T06:30:00.000Z");

      // A time either side of the gap is untouched.
      expect(
        nextRun(
          { frequency: "daily", runAtMinutes: 210, timezone: NEW_YORK },
          "2026-03-07T12:00:00.000Z",
        ),
      ).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    });

    it("takes the first occurrence when the chosen time happens twice", () => {
      // Clocks go back 02:00 to 01:00 on 2026-11-01 in New York, so 01:30
      // comes round twice. The worker runs once, on the first.
      expect(
        nextRun(
          { frequency: "daily", runAtMinutes: 90, timezone: NEW_YORK },
          "2026-10-31T12:00:00.000Z",
        ),
      ).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT, not 06:30Z

      expect(
        nextRun(
          { frequency: "daily", runAtMinutes: 150, timezone: NEW_YORK },
          "2026-10-31T12:00:00.000Z",
        ),
      ).toBe("2026-11-01T07:30:00.000Z"); // 02:30 EST
    });
  });
});
