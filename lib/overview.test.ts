import { describe, expect, it } from "vitest";
import {
  isRunOverdue,
  latestExecution,
  summarizeWorkers,
} from "@/lib/overview";
import type { Routine, RunSummary } from "@/types";

/**
 * Overdue is a reading of `nextRunAt`, and the whole of what it means is
 * "active, scheduled, and the slot has passed". These fix the three parts,
 * because each has a way of drifting: a paused worker keeps its slot, a manual
 * one has none, and a slot landing exactly on the current instant has not
 * passed yet.
 *
 * The summary numbers are fixed alongside them for the same reason `stuck` is
 * in `lib/health.test.ts` — they are a fold over rows the page already has, so
 * nothing else would catch them changing.
 */

const NOW = new Date("2026-08-10T12:00:00.000Z");

const PAST = new Date("2026-08-10T11:00:00.000Z");
const FUTURE = new Date("2026-08-10T13:00:00.000Z");

function worker(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "worker-1",
    userId: "user-1",
    name: "Worker",
    description: "",
    prompt: "",
    kind: "prompt",
    status: "active",
    frequency: "daily",
    runAtMinutes: 540,
    runAtWeekday: null,
    runAtDay: null,
    nextRunAt: FUTURE,
    emailNotificationsEnabled: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("isRunOverdue", () => {
  it("is true for an active worker whose slot has passed", () => {
    expect(isRunOverdue(worker({ nextRunAt: PAST }), NOW)).toBe(true);
  });

  it("is false for a slot still ahead", () => {
    expect(isRunOverdue(worker({ nextRunAt: FUTURE }), NOW)).toBe(false);
  });

  /**
   * The comparison is `<`, so a slot landing on the current instant is due
   * rather than late — which is the same instant the scheduler would pick it
   * up on, `nextRunAt <= now`.
   */
  it("is false for a slot landing exactly now", () => {
    expect(isRunOverdue(worker({ nextRunAt: NOW }), NOW)).toBe(false);
  });

  it("is false for a worker with no slot", () => {
    expect(isRunOverdue(worker({ nextRunAt: null }), NOW)).toBe(false);
  });

  /**
   * Paused and draft workers keep whatever slot they had, and the scheduler
   * never selects them — so a slot of theirs sitting in the past is expected,
   * not a sign of anything.
   */
  it("is false for a paused worker with a past slot", () => {
    expect(
      isRunOverdue(worker({ status: "paused", nextRunAt: PAST }), NOW),
    ).toBe(false);
  });

  it("is false for a draft worker with a past slot", () => {
    expect(
      isRunOverdue(worker({ status: "draft", nextRunAt: PAST }), NOW),
    ).toBe(false);
  });
});

describe("summarizeWorkers", () => {
  it("counts nothing when there are no workers", () => {
    expect(summarizeWorkers([], null, NOW)).toEqual({
      total: 0,
      active: 0,
      paused: 0,
      nextScheduledRun: null,
      nextScheduledRunOverdue: false,
      lastExecution: null,
    });
  });

  it("counts workers by status", () => {
    const overview = summarizeWorkers(
      [
        worker({ id: "a", status: "active" }),
        worker({ id: "b", status: "paused" }),
        worker({ id: "c", status: "draft" }),
      ],
      null,
      NOW,
    );

    expect(overview.total).toBe(3);
    expect(overview.active).toBe(1);
    expect(overview.paused).toBe(1);
  });

  it("takes the soonest slot among active workers", () => {
    const soon = new Date("2026-08-10T12:30:00.000Z");

    const overview = summarizeWorkers(
      [worker({ id: "a", nextRunAt: FUTURE }), worker({ id: "b", nextRunAt: soon })],
      null,
      NOW,
    );

    expect(overview.nextScheduledRun).toEqual(soon);
  });

  /**
   * A paused worker keeps its slot but is never dispatched, so counting it
   * would advertise a run that does not happen.
   */
  it("ignores the slot of a worker that is not active", () => {
    const overview = summarizeWorkers(
      [
        worker({ id: "a", status: "paused", nextRunAt: PAST }),
        worker({ id: "b", status: "active", nextRunAt: FUTURE }),
      ],
      null,
      NOW,
    );

    expect(overview.nextScheduledRun).toEqual(FUTURE);
  });

  it("has no next run when every active worker is manual", () => {
    const overview = summarizeWorkers(
      [worker({ frequency: "manual", nextRunAt: null })],
      null,
      NOW,
    );

    expect(overview.nextScheduledRun).toBeNull();
    expect(overview.nextScheduledRunOverdue).toBe(false);
  });

  it("marks the soonest slot overdue once it has passed", () => {
    const overview = summarizeWorkers([worker({ nextRunAt: PAST })], null, NOW);

    expect(overview.nextScheduledRunOverdue).toBe(true);
  });

  it("does not mark a slot landing exactly now as overdue", () => {
    const overview = summarizeWorkers([worker({ nextRunAt: NOW })], null, NOW);

    expect(overview.nextScheduledRunOverdue).toBe(false);
  });

  /** Reported as given: the figure is counted by the database, not here. */
  it("reports the most recent execution it was handed", () => {
    const overview = summarizeWorkers([], PAST, NOW);

    expect(overview.lastExecution).toEqual(PAST);
  });

  it("reports none when no worker has ever run", () => {
    expect(summarizeWorkers([], null, NOW).lastExecution).toBeNull();
  });
});

/**
 * The account's most recent execution, taken from the per-worker summaries.
 *
 * **The number means "ever", so it cannot come from a bounded list.** The
 * activity list beside it shows the newest twenty rows; this is the newest of
 * every worker's own newest, each of which the database counted over that
 * worker's whole history.
 */
describe("latestExecution", () => {
  const summary = (lastRunAt: Date | null): RunSummary => ({
    totalRuns: lastRunAt === null ? 0 : 1,
    totalFailures: 0,
    lastResult: lastRunAt === null ? null : "completed",
    lastRunAt,
  });

  it("is null when there are no workers", () => {
    expect(latestExecution(new Map())).toBeNull();
  });

  it("is null when no worker has ever run", () => {
    expect(latestExecution(new Map([["worker-1", summary(null)]]))).toBeNull();
  });

  it("takes the newest across every worker", () => {
    const summaries = new Map([
      ["worker-1", summary(PAST)],
      ["worker-2", summary(NOW)],
      ["worker-3", summary(null)],
    ]);

    expect(latestExecution(summaries)).toEqual(NOW);
  });

  it("does not mind which order the workers arrive in", () => {
    const summaries = new Map([
      ["worker-2", summary(NOW)],
      ["worker-1", summary(PAST)],
    ]);

    expect(latestExecution(summaries)).toEqual(NOW);
  });
});
