import { describe, expect, it } from "vitest";
import {
  advanceSchedule,
  calculateNextRunAt,
  type ScheduleInput,
} from "@/lib/schedule";

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

/** Where a schedule lands once `slot` is taken at `now`, as an ISO string. */
function advanced(
  overrides: Partial<ScheduleInput>,
  slot: string,
  now: string,
): string | undefined {
  return advanceSchedule(
    { ...anyWorker, ...overrides },
    new Date(slot),
    new Date(now),
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
      // Without a chosen time the slot keeps the one it already had, read on
      // the owner's clock. In UTC the two readings agree.
      expect(
        nextRun({ frequency: "daily" }, "2026-08-04T03:21:00.000Z"),
      ).toBe("2026-08-05T03:21:00.000Z");
    });

    it("keeps it in a zone ahead of UTC too", () => {
      // 12:21 in Tokyo. A fixed-offset zone moves the reading and the result
      // together, so this lands on the same instant as the UTC case above —
      // which is why stepping the instant directly went unnoticed for so long.
      expect(
        nextRun({ frequency: "daily", timezone: TOKYO }, "2026-08-04T03:21:00.000Z"),
      ).toBe("2026-08-05T03:21:00.000Z");
    });

    it("drops the seconds a slot arrived with", () => {
      // A slot is built from a date and minutes into the day, so anything
      // finer is not carried. Worth pinning: rows created before this were
      // seeded from `new Date()` and kept the second they were created on.
      expect(
        nextRun({ frequency: "daily" }, "2026-08-04T03:21:37.500Z"),
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

    it("keeps the weekday and the time when neither was chosen", () => {
      // Tuesday 03:21 to the Tuesday after, at 03:21.
      expect(
        nextRun({ frequency: "weekly" }, "2026-08-04T03:21:00.000Z"),
      ).toBe("2026-08-11T03:21:00.000Z");
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

    /**
     * The same four cases without a chosen time, which used to be a separate
     * route through the module and got none of this. It stepped the UTC
     * instant with `setMonth`, so the 31st of January rolled through February
     * into the 3rd of March — and the 3rd then became the basis for the next
     * step, so the worker ran on the 3rd for good. It also never saw
     * `runAtDay`, so choosing a day of the month did nothing without a time.
     *
     * Both routes are one route now, and these pin that: every expectation
     * below matches its counterpart above.
     */
    describe("with no chosen time", () => {
      it("borrows the last day of a month too short for the chosen one", () => {
        expect(
          nextRun(
            { frequency: "monthly", runAtDay: 31 },
            "2026-01-31T09:00:00.000Z",
          ),
        ).toBe("2026-02-28T09:00:00.000Z");
      });

      it("returns to the chosen day the month after borrowing", () => {
        expect(
          nextRun(
            { frequency: "monthly", runAtDay: 31 },
            "2026-02-28T09:00:00.000Z",
          ),
        ).toBe("2026-03-31T09:00:00.000Z");
      });

      it("rolls the year over from December", () => {
        expect(
          nextRun(
            { frequency: "monthly", runAtDay: 10 },
            "2026-12-10T09:00:00.000Z",
          ),
        ).toBe("2027-01-10T09:00:00.000Z");
      });

      it("uses the 29th in a leap February", () => {
        expect(
          nextRun(
            { frequency: "monthly", runAtDay: 31 },
            "2028-01-31T09:00:00.000Z",
          ),
        ).toBe("2028-02-29T09:00:00.000Z");
      });

      it("clamps to the end of a short month with no day chosen either", () => {
        // Nothing here but the slot: the 31st of January is both the day to
        // keep and the day February cannot hold. The old route answered the
        // 3rd of March.
        expect(
          nextRun({ frequency: "monthly" }, "2026-01-31T09:00:00.000Z"),
        ).toBe("2026-02-28T09:00:00.000Z");
      });

      it("cannot return to the 31st once it has borrowed, without a runAtDay", () => {
        // **Clamping is lossy when nothing recorded the intent.** With a
        // `runAtDay` the 31st comes back; without one the borrowed 28th is
        // all there is left to read, and the worker keeps the 28th.
        //
        // This is the reason a drifted worker cannot be repaired by
        // recalculating it — the day it meant is not in the database.
        expect(
          nextRun({ frequency: "monthly" }, "2026-02-28T09:00:00.000Z"),
        ).toBe("2026-03-28T09:00:00.000Z");
      });
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

    /**
     * **This one is a deliberate change of behaviour, not a pinned quirk.**
     *
     * A worker with no chosen time used to keep the time of the stored UTC
     * instant. Across a daylight-saving change that holds the instant still
     * while the owner's clock moves, so a worker they last saw run at 09:00
     * starts running at 10:00 — the exact failure the chosen-time path was
     * built to avoid, left in place for workers that never chose one.
     *
     * `runAtMinutes = null` has always been documented as keeping the time the
     * slot already had, and a time of day is something a person reads off
     * their own clock. So the null case now keeps the *local* time, and the
     * stored instant moves by the offset instead.
     *
     * Nothing changes in a zone with a fixed offset, which is why this needs a
     * zone that observes the change to be visible at all.
     */
    it("keeps the local time of an unscheduled worker across the change", () => {
      // 09:00 EST on the day before clocks go forward. The day after, 09:00
      // is EDT — one hour earlier in UTC.
      expect(
        nextRun(
          { frequency: "daily", timezone: NEW_YORK },
          "2026-03-07T14:00:00.000Z",
        ),
      ).toBe("2026-03-08T13:00:00.000Z");
    });
  });
});

/**
 * The question here is not where the next slot falls — that is settled above —
 * but how many missed ones are worth replaying. The answer is none: one step
 * forward if that reaches the future, and a fresh start from `now` if it does
 * not.
 */
describe("advanceSchedule", () => {
  const daily = { frequency: "daily", runAtMinutes: NINE_AM } as const;

  describe("when one step reaches the future", () => {
    it("advances by one slot, exactly as calculating from that slot would", () => {
      // A tick five seconds late is still on time as far as the schedule is
      // concerned, and must not be treated as a missed run.
      const slot = "2026-08-04T09:00:00.000Z";
      const result = advanced(daily, slot, "2026-08-04T09:00:05.000Z");

      expect(result).toBe("2026-08-05T09:00:00.000Z");
      expect(result).toBe(nextRun(daily, slot));
    });

    it("keeps the chosen time when the tick is hours late", () => {
      // Late by three and a half hours, but the next slot is still ahead, so
      // 09:00 survives rather than sliding to the time of the tick.
      expect(
        advanced(daily, "2026-08-04T09:00:00.000Z", "2026-08-04T12:30:00.000Z"),
      ).toBe("2026-08-05T09:00:00.000Z");
    });
  });

  describe("when one step does not reach the future", () => {
    it("resumes from now instead of replaying the backlog", () => {
      // Seven days of missed slots. Stepping through them one tick at a time
      // would run the worker eight times; it lands in the same place either
      // way, so the backlog buys nothing.
      expect(
        advanced(daily, "2026-07-28T09:00:00.000Z", "2026-08-04T12:00:00.000Z"),
      ).toBe("2026-08-05T09:00:00.000Z");
    });

    it("lands where a punctual worker would", () => {
      // The destination is what a worker that never missed a slot gets, which
      // is what makes dropping the backlog safe: catching up costs one run.
      const late = advanced(
        daily,
        "2026-07-28T09:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
      );
      const punctual = advanced(
        daily,
        "2026-08-04T09:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
      );

      expect(late).toBe(punctual);
    });

    it("counts a slot landing exactly on now as already missed", () => {
      // The boundary: `now` is not the future, so this compresses rather than
      // handing back a slot that is due the instant it is written.
      expect(
        advanced(daily, "2026-08-04T09:00:00.000Z", "2026-08-05T09:00:00.000Z"),
      ).toBe("2026-08-06T09:00:00.000Z");
    });

    it("keeps the chosen day of the month while catching up", () => {
      // Four months behind, and the 31st is still the intent: June is short,
      // so it borrows the 30th the same way a punctual month would.
      expect(
        advanced(
          { frequency: "monthly", runAtMinutes: NINE_AM, runAtDay: 31 },
          "2026-01-31T09:00:00.000Z",
          "2026-05-15T12:00:00.000Z",
        ),
      ).toBe("2026-06-30T09:00:00.000Z");
    });

    it("keeps clamping when the worker catching up chose no time", () => {
      // The catch-up branch recalculates from `now`, so it used to reach the
      // old instant-stepping route and produce a rolled date on the way back
      // from an outage — the recovery itself was what broke the schedule.
      // Resuming in May, the 31st is intact; June is short and borrows the
      // 30th, exactly as the timed worker above does.
      expect(
        advanced(
          { frequency: "monthly", runAtDay: 31 },
          "2026-01-31T09:00:00.000Z",
          "2026-05-15T09:00:00.000Z",
        ),
      ).toBe("2026-06-30T09:00:00.000Z");
    });

    it("reads now in the owner's zone, not in UTC", () => {
      // 15:30 UTC is already the next day in Tokyo, so the slot it resumes
      // from is the 5th — a UTC reading would produce the 4th and be a day early.
      expect(
        advanced(
          { frequency: "daily", runAtMinutes: NINE_AM, timezone: TOKYO },
          "2026-07-28T00:00:00.000Z",
          "2026-08-04T15:30:00.000Z",
        ),
      ).toBe("2026-08-06T00:00:00.000Z"); // 09:00 on the 6th in Tokyo
    });
  });

  it("still never schedules a manual worker", () => {
    // No slot to miss, so nothing to catch up on.
    expect(
      advanced(
        { frequency: "manual" },
        "2026-01-01T00:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
      ),
    ).toBeUndefined();
  });
});
