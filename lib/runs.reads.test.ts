import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What reading run history is allowed to cost.
 *
 * **Both screens used to load every run an account had ever had.** The
 * dashboard did it to draw a list of one line each, and the worker detail page
 * did it to work out four numbers — while showing no runs at all. Neither had
 * a limit, so what they read grew with the history and never levelled off.
 *
 * These fix the shape of the queries rather than their results, because the
 * property at stake is not what the numbers say but how much has to be read to
 * say it. The numbers themselves are fixed in `lib/health.test.ts`.
 *
 * **Prisma is stood in for.** What is under test is the argument handed to it —
 * the `take`, the `select`, the grouping — which is exactly the part a database
 * would obey and a test with a real one would have to infer.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    runHistory: { findMany: mocks.findMany, groupBy: mocks.groupBy },
  },
}));

const {
  listRecentRuns,
  RECENT_ACTIVITY_LIMIT,
  summarizeRunsByWorker,
  summarizeRunsForWorker,
} = await import("@/lib/runs");

/** One grouped row, as the aggregate returns it. */
function group(
  routineId: string,
  status: string,
  count: number,
  latest: string | null,
) {
  return {
    routineId,
    status,
    _count: { _all: count },
    _max: { startedAt: latest === null ? null : new Date(latest) },
  };
}

const activityRow = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  status: "completed",
  startedAt: new Date("2026-08-10T12:00:00.000Z"),
  output: "what the model said",
  routine: { name: "Daily digest" },
  ...overrides,
});

beforeEach(() => {
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.groupBy.mockReset().mockResolvedValue([]);
});

/** The one argument the query was given. */
const findManyArgs = () =>
  mocks.findMany.mock.calls.at(-1)?.[0] as Record<string, unknown>;

const groupByArgs = () =>
  mocks.groupBy.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe("the dashboard's activity list", () => {
  it("asks for the newest runs of this account only", async () => {
    await listRecentRuns("user-1");

    expect(findManyArgs().where).toEqual({ userId: "user-1" });
    expect(findManyArgs().orderBy).toEqual({ startedAt: "desc" });
  });

  it("asks for twenty of them", async () => {
    await listRecentRuns("user-1");

    expect(findManyArgs().take).toBe(20);
    expect(RECENT_ACTIVITY_LIMIT).toBe(20);
  });

  /**
   * **The bound is in the query, not in what the page does afterwards.** A list
   * sliced after the fact has already been read, serialised and sent.
   */
  it("never asks without a limit", async () => {
    await listRecentRuns("user-1");

    expect(findManyArgs()).toHaveProperty("take");
    expect(findManyArgs().take).toBeLessThanOrEqual(RECENT_ACTIVITY_LIMIT);
  });

  it("asks for the columns the list draws, and no others", async () => {
    await listRecentRuns("user-1");

    expect(findManyArgs().select).toEqual({
      id: true,
      status: true,
      startedAt: true,
      output: true,
      routine: { select: { name: true } },
    });
  });

  /**
   * The list shows what a run produced, so the column stays. Dropping it would
   * be a change to what the page says rather than to how much it reads.
   */
  it("keeps the output the list shows", async () => {
    await listRecentRuns("user-1");

    expect((findManyArgs().select as Record<string, unknown>).output).toBe(true);
  });

  /** The activity list has never shown a diagnostic; the run's own page does. */
  it("leaves the failure diagnostic behind", async () => {
    await listRecentRuns("user-1");

    const select = findManyArgs().select as Record<string, unknown>;
    expect(select).not.toHaveProperty("errorMessage");
    expect(select).not.toHaveProperty("finishedAt");
    expect(select).not.toHaveProperty("userId");
    expect(select).not.toHaveProperty("routineId");
  });

  it("carries the worker's name for each line", async () => {
    mocks.findMany.mockResolvedValue([activityRow()]);

    const [run] = await listRecentRuns("user-1");

    expect(run.routineName).toBe("Daily digest");
    expect(run.output).toBe("what the model said");
    expect(run.status).toBe("completed");
  });

  /** A stored status this version cannot read is shown as in progress, as ever. */
  it("narrows a status it does not recognise", async () => {
    mocks.findMany.mockResolvedValue([activityRow({ status: "corrupt" })]);

    const [run] = await listRecentRuns("user-1");

    expect(run.status).toBe("running");
  });
});

describe("the dashboard's per-worker summary", () => {
  it("asks the database to count, scoped to the account", async () => {
    await summarizeRunsByWorker("user-1");

    expect(groupByArgs().where).toEqual({ userId: "user-1" });
    expect(groupByArgs().by).toEqual(["routineId", "status"]);
  });

  /**
   * **One query, whatever the dashboard is showing.** Asking each worker for
   * its own numbers would trade a read that grows with the history for a set of
   * reads that grows with the cards.
   */
  it.each([1, 10, 100])(
    "makes exactly one query for an account with %i workers",
    async (workers) => {
      mocks.groupBy.mockResolvedValue(
        Array.from({ length: workers }, (_, index) =>
          group(`worker-${index}`, "completed", 3, "2026-08-10T12:00:00.000Z"),
        ),
      );

      await summarizeRunsByWorker("user-1");

      expect(mocks.groupBy).toHaveBeenCalledTimes(1);
      expect(mocks.findMany).not.toHaveBeenCalled();
    },
  );

  it("never reads what a run produced", async () => {
    await summarizeRunsByWorker("user-1");

    const args = JSON.stringify(groupByArgs());
    expect(args).not.toContain("output");
    expect(args).not.toContain("errorMessage");
  });

  /**
   * **The counts mean "ever", and the query is what makes that true.** Twenty
   * rows on screen and a hundred runs counted is the whole point of splitting
   * the two reads.
   */
  it("counts every run, not the ones a page would show", async () => {
    mocks.groupBy.mockResolvedValue([
      group("worker-1", "completed", 93, "2026-08-10T12:00:00.000Z"),
      group("worker-1", "failed", 7, "2026-08-09T12:00:00.000Z"),
    ]);

    const summary = (await summarizeRunsByWorker("user-1")).get("worker-1");

    expect(summary).toEqual({
      totalRuns: 100,
      totalFailures: 7,
      lastResult: "completed",
      lastRunAt: new Date("2026-08-10T12:00:00.000Z"),
    });
  });

  it("takes the last result from whichever status ran most recently", async () => {
    mocks.groupBy.mockResolvedValue([
      group("worker-1", "completed", 40, "2026-08-09T12:00:00.000Z"),
      group("worker-1", "failed", 1, "2026-08-10T12:00:00.000Z"),
    ]);

    const summary = (await summarizeRunsByWorker("user-1")).get("worker-1");

    expect(summary?.lastResult).toBe("failed");
    expect(summary?.lastRunAt).toEqual(new Date("2026-08-10T12:00:00.000Z"));
  });

  it("keeps each worker's numbers to itself", async () => {
    mocks.groupBy.mockResolvedValue([
      group("worker-1", "completed", 2, "2026-08-10T12:00:00.000Z"),
      group("worker-2", "failed", 5, "2026-08-08T12:00:00.000Z"),
    ]);

    const summaries = await summarizeRunsByWorker("user-1");

    expect(summaries.get("worker-1")?.totalRuns).toBe(2);
    expect(summaries.get("worker-1")?.totalFailures).toBe(0);
    expect(summaries.get("worker-2")?.totalRuns).toBe(5);
    expect(summaries.get("worker-2")?.totalFailures).toBe(5);
  });

  /**
   * A run stored with a status nothing here recognises still happened, so it
   * counts — what it cannot do is claim to be the last result, because there is
   * no word for what it was.
   */
  it("counts a run whose status it cannot read, without naming it", async () => {
    mocks.groupBy.mockResolvedValue([
      group("worker-1", "completed", 2, "2026-08-08T12:00:00.000Z"),
      group("worker-1", "corrupt", 1, "2026-08-10T12:00:00.000Z"),
    ]);

    const summary = (await summarizeRunsByWorker("user-1")).get("worker-1");

    expect(summary?.totalRuns).toBe(3);
    expect(summary?.lastResult).toBe("completed");
  });
});

describe("a single worker's summary", () => {
  it("is scoped by the worker and its owner", async () => {
    await summarizeRunsForWorker("worker-1", "user-1");

    expect(groupByArgs().where).toEqual({
      routineId: "worker-1",
      userId: "user-1",
    });
  });

  /** The page reads history once, and reads no rows of it. */
  it("makes one query and fetches no runs", async () => {
    await summarizeRunsForWorker("worker-1", "user-1");

    expect(mocks.groupBy).toHaveBeenCalledTimes(1);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("counts twenty-five runs of which seven failed", async () => {
    mocks.groupBy.mockResolvedValue([
      group("worker-1", "completed", 18, "2026-08-10T12:00:00.000Z"),
      group("worker-1", "failed", 7, "2026-08-09T12:00:00.000Z"),
    ]);

    expect(await summarizeRunsForWorker("worker-1", "user-1")).toEqual({
      totalRuns: 25,
      totalFailures: 7,
      lastResult: "completed",
      lastRunAt: new Date("2026-08-10T12:00:00.000Z"),
    });
  });

  it("reports a worker that has never run", async () => {
    expect(await summarizeRunsForWorker("worker-1", "user-1")).toEqual({
      totalRuns: 0,
      totalFailures: 0,
      lastResult: null,
      lastRunAt: null,
    });
  });

  it("never reads what a run produced", async () => {
    await summarizeRunsForWorker("worker-1", "user-1");

    const args = JSON.stringify(groupByArgs());
    expect(args).not.toContain("output");
    expect(args).not.toContain("errorMessage");
  });
});
