import { describe, expect, it } from "vitest";
import {
  continuesFailureStreak,
  FAILURE_STREAK_LOOKBACK,
  isSilentFailure,
  type EarlierRun,
} from "@/lib/notify/failure-streak";
import { AI_ALLOWANCE_EXHAUSTED_MESSAGE } from "@/lib/usage/ai-allowance";
import { THROTTLED_MESSAGE } from "@/lib/watcher/errors";

/**
 * Whether a failure email would repeat one already sent.
 *
 * Earlier runs are listed newest first, as the lookup returns them. A run is
 * judged by its status alone; what went wrong only matters for telling the two
 * silent failures apart from the rest.
 */

const completed: EarlierRun = { status: "completed", errorMessage: null };
const running: EarlierRun = { status: "running", errorMessage: null };
const fetchFailed: EarlierRun = { status: "failed", errorMessage: "The site could not be reached." };
const providerFailed: EarlierRun = { status: "failed", errorMessage: "Claude is unavailable." };
const parseFailed: EarlierRun = { status: "failed", errorMessage: "The answer could not be read." };
const allowanceRefused: EarlierRun = { status: "failed", errorMessage: AI_ALLOWANCE_EXHAUSTED_MESSAGE };
const throttled: EarlierRun = { status: "failed", errorMessage: THROTTLED_MESSAGE };

/** Emails sent over a history, oldest first, as each failure would decide. */
function emailsOver(history: EarlierRun[]): number {
  let sent = 0;

  history.forEach((run, index) => {
    if (run.status !== "failed" || isSilentFailure(run)) {
      return;
    }

    const earlier = history.slice(0, index).reverse().slice(0, FAILURE_STREAK_LOOKBACK);
    if (!continuesFailureStreak(earlier)) {
      sent += 1;
    }
  });

  return sent;
}

describe("which failures are silent", () => {
  it("recognises an allowance refusal and a throttled fetch", () => {
    expect(isSilentFailure(allowanceRefused)).toBe(true);
    expect(isSilentFailure(throttled)).toBe(true);
  });

  it("treats every other failure, and anything not failed, as not silent", () => {
    expect(isSilentFailure(fetchFailed)).toBe(false);
    expect(isSilentFailure(providerFailed)).toBe(false);
    expect(isSilentFailure(completed)).toBe(false);
    expect(isSilentFailure({ status: "completed", errorMessage: THROTTLED_MESSAGE })).toBe(false);
  });
});

describe("failure emails over a worker's history", () => {
  it.each([
    ["completed → failed", [completed, fetchFailed], 1],
    ["completed → failed → failed", [completed, fetchFailed, fetchFailed], 1],
    [
      "completed → failed → failed → completed → failed",
      [completed, fetchFailed, fetchFailed, completed, fetchFailed],
      2,
    ],
    ["no earlier run → failed", [fetchFailed], 1],
    ["failed(fetch) → failed(provider)", [fetchFailed, providerFailed], 1],
    ["failed(provider) → failed(parse)", [providerFailed, parseFailed], 1],
    ["failed → completed → failed", [fetchFailed, completed, fetchFailed], 2],
    ["running → failed", [running, fetchFailed], 1],
  ] as const)("%s sends %i", (_label, history, expected) => {
    expect(emailsOver([...history])).toBe(expected);
  });
});

describe("silent failures neither start nor end a streak", () => {
  it.each([
    ["A: failed → allowance → failed", [fetchFailed, allowanceRefused, providerFailed], 1],
    ["B: completed → allowance → failed", [completed, allowanceRefused, fetchFailed], 1],
    ["C: failed → throttled → failed", [fetchFailed, throttled, fetchFailed], 1],
    ["D: completed → throttled → failed", [completed, throttled, fetchFailed], 1],
    ["E: allowance refusals alone", [completed, allowanceRefused, allowanceRefused], 0],
    ["F: throttled alone", [completed, throttled, throttled], 0],
  ] as const)("%s sends %i", (_label, history, expected) => {
    expect(emailsOver([...history])).toBe(expected);
  });

  it("G: sends when the whole lookback is silent", () => {
    const earlier = Array.from({ length: FAILURE_STREAK_LOOKBACK }, () => throttled);

    expect(continuesFailureStreak(earlier)).toBe(false);
  });

  it("H: suppresses when a failure sits behind 19 silent runs", () => {
    const earlier = [...Array.from({ length: 19 }, () => allowanceRefused), fetchFailed];

    expect(earlier).toHaveLength(FAILURE_STREAK_LOOKBACK);
    expect(continuesFailureStreak(earlier)).toBe(true);
  });

  it("I: sends when a completed run sits behind 19 silent runs", () => {
    const earlier = [...Array.from({ length: 19 }, () => throttled), completed];

    expect(continuesFailureStreak(earlier)).toBe(false);
  });

  it("looks back twenty runs, no more", () => {
    expect(FAILURE_STREAK_LOOKBACK).toBe(20);
  });
});
