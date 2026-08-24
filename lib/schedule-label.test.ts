import { describe, expect, it } from "vitest";
import { scheduleLabel } from "@/lib/schedule-label";

/**
 * How a cadence reads, in each language.
 *
 * **The branches are the ones that were always here.** What a worker does with
 * a missing weekday or a missing time is a scheduling decision made elsewhere;
 * this only describes it. The tests below fix both halves — that the English
 * wording did not change, and that the Japanese says the same thing without
 * borrowing English grammar.
 */

describe("in English", () => {
  it("names a manual worker", () => {
    expect(scheduleLabel("manual", null, null, null, "en")).toBe(
      "Manual execution",
    );
  });

  it("names a plain cadence", () => {
    expect(scheduleLabel("daily", null, null, null, "en")).toBe("Every day");
    expect(scheduleLabel("weekly", null, null, null, "en")).toBe("Every week");
    expect(scheduleLabel("monthly", null, null, null, "en")).toBe("Every month");
  });

  it("names the weekday when one was chosen", () => {
    expect(scheduleLabel("weekly", null, 1, null, "en")).toBe("Every Monday");
    expect(scheduleLabel("weekly", null, 0, null, "en")).toBe("Every Sunday");
    expect(scheduleLabel("weekly", null, 6, null, "en")).toBe("Every Saturday");
  });

  it("names the day of the month as an ordinal", () => {
    expect(scheduleLabel("monthly", null, null, 3, "en")).toBe("On the 3rd");
    expect(scheduleLabel("monthly", null, null, 1, "en")).toBe("On the 1st");
    expect(scheduleLabel("monthly", null, null, 11, "en")).toBe("On the 11th");
  });

  it("adds the time when one was chosen", () => {
    expect(scheduleLabel("daily", 540, null, null, "en")).toBe(
      "Every day at 09:00",
    );
    expect(scheduleLabel("weekly", 0, 1, null, "en")).toBe(
      "Every Monday at 00:00",
    );
  });
});

describe("in Japanese", () => {
  it("names a manual worker", () => {
    expect(scheduleLabel("manual", null, null, null, "ja")).toBe("手動実行");
  });

  it("names a plain cadence", () => {
    expect(scheduleLabel("daily", null, null, null, "ja")).toBe("毎日");
    expect(scheduleLabel("weekly", null, null, null, "ja")).toBe("毎週");
    expect(scheduleLabel("monthly", null, null, null, "ja")).toBe("毎月");
  });

  it("names the weekday when one was chosen", () => {
    expect(scheduleLabel("weekly", null, 1, null, "ja")).toBe("毎週月曜日");
    expect(scheduleLabel("weekly", null, 0, null, "ja")).toBe("毎週日曜日");
  });

  /** 「毎月3日」— the bare number, because "the 3rd" is an English rule. */
  it("names the day of the month without an English ordinal", () => {
    expect(scheduleLabel("monthly", null, null, 3, "ja")).toBe("毎月3日");
    expect(scheduleLabel("monthly", null, null, 11, "ja")).toBe("毎月11日");
  });

  it("adds the time when one was chosen", () => {
    expect(scheduleLabel("daily", 540, null, null, "ja")).toBe("毎日 09:00");
  });
});

/**
 * The parts that are not language.
 *
 * A time is `HH:mm` in both, because Day 2A translates words and leaves date
 * and time formatting exactly where it was.
 */
describe("what the language does not change", () => {
  it("writes the clock the same way in both", () => {
    expect(scheduleLabel("daily", 545, null, null, "en")).toContain("09:05");
    expect(scheduleLabel("daily", 545, null, null, "ja")).toContain("09:05");
  });

  it("falls back to English for a language it does not know", () => {
    expect(scheduleLabel("daily", null, null, null, "fr")).toBe("Every day");
  });

  /** Callers that have not been given a language yet keep what they had. */
  it("still answers in English when none is given", () => {
    expect(scheduleLabel("manual")).toBe("Manual execution");
    expect(scheduleLabel("daily", 540)).toBe("Every day at 09:00");
  });

  /**
   * A weekday only means something for a weekly worker, and a day of the month
   * only for a monthly one — the same in both languages, because it is a
   * scheduling rule rather than a wording one.
   */
  it("ignores a weekday on a worker that has no week", () => {
    expect(scheduleLabel("daily", null, 3, null, "ja")).toBe("毎日");
    expect(scheduleLabel("monthly", null, 3, null, "ja")).toBe("毎月");
  });

  it("ignores a day of the month on a worker that has no month", () => {
    expect(scheduleLabel("daily", null, null, 3, "ja")).toBe("毎日");
    expect(scheduleLabel("weekly", null, null, 3, "ja")).toBe("毎週");
  });

  it("ignores a weekday outside the week it could name", () => {
    expect(scheduleLabel("weekly", null, 9, null, "en")).toBe("Every week");
    expect(scheduleLabel("weekly", null, 9, null, "ja")).toBe("毎週");
  });
});
