import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduler's whole job is one query, so what these fix is the query.
 *
 * Not its literal shape — asserting the object Prisma is handed would fail the
 * next time an unrelated field moves — but the four things the rest of the
 * system relies on: that only `active` workers are selected, that only past
 * slots are, that the earliest comes first, and that the columns fetched are
 * the ones the dispatcher actually reads.
 *
 * `@/lib/prisma` is replaced rather than reached: there is no database here,
 * and the decision being tested is which query to make, not what a database
 * would answer.
 */

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { routine: { findMany } },
}));

const { getDueWorkers, MAX_DISPATCHES_PER_TICK } = await import(
  "@/lib/scheduler",
);

const NOW = new Date("2026-08-10T09:05:00.000Z");

/** The argument `getDueWorkers` handed to Prisma for a tick at `NOW`. */
async function queryFor(records: unknown[] = []) {
  findMany.mockResolvedValue(records);
  await getDueWorkers(NOW);
  return findMany.mock.calls[0][0];
}

/** A due worker as the query would return it, with every selected column. */
function dueRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "worker-1",
    userId: "user-1",
    nextRunAt: new Date("2026-08-10T09:00:00.000Z"),
    frequency: "daily",
    runAtMinutes: 540,
    runAtWeekday: null,
    runAtDay: null,
    ...overrides,
  };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("getDueWorkers", () => {
  it("selects only active workers", async () => {
    expect((await queryFor()).where.status).toBe("active");
  });

  it("selects only slots that have arrived", async () => {
    expect((await queryFor()).where.nextRunAt).toEqual({ lte: NOW });
  });

  it("returns the earliest slot first", async () => {
    expect((await queryFor()).orderBy).toEqual({ nextRunAt: "asc" });
  });

  /**
   * The dispatcher reads seven columns and never touches `prompt`, which is
   * the largest one a worker has. Fetching it for every due worker on every
   * tick is the cost this pins down.
   */
  it("fetches only the columns the dispatcher reads", async () => {
    expect(Object.keys((await queryFor()).select).sort()).toEqual([
      "frequency",
      "id",
      "nextRunAt",
      "runAtDay",
      "runAtMinutes",
      "runAtWeekday",
      "userId",
    ]);
  });

  it("does not fetch the prompt", async () => {
    expect((await queryFor()).select).not.toHaveProperty("prompt");
  });

  it("passes each worker through", async () => {
    const [worker] = await (async () => {
      findMany.mockResolvedValue([dueRecord()]);
      return getDueWorkers(NOW);
    })();

    expect(worker.id).toBe("worker-1");
    expect(worker.nextRunAt).toEqual(new Date("2026-08-10T09:00:00.000Z"));
  });

  /**
   * `frequency` is a plain string column, so the database can hold something
   * the application cannot read. It is narrowed here for the same reason
   * `toRoutine` narrows it: the dispatcher hands the value straight to
   * `lib/schedule.ts`, which accepts only the four it knows.
   *
   * **The fallback is `manual`, matching `toRoutine`.** A worker that falls
   * back stops being due rather than running on a cadence nobody chose.
   */
  it("falls back to manual for a frequency it cannot read", async () => {
    findMany.mockResolvedValue([dueRecord({ frequency: "fortnightly" })]);

    const [worker] = await getDueWorkers(NOW);

    expect(worker.frequency).toBe("manual");
  });

  it("keeps a frequency it can read", async () => {
    findMany.mockResolvedValue([dueRecord({ frequency: "monthly" })]);

    const [worker] = await getDueWorkers(NOW);

    expect(worker.frequency).toBe("monthly");
  });
});

/**
 * **How many due workers one tick will even look at.**
 *
 * The cap is in the query rather than applied to its result: a platform with a
 * thousand due workers should load five rows, not a thousand and then discard
 * most of them. What is not reached keeps its slot and is due again next tick,
 * so a backlog drains oldest-first rather than being lost.
 */
describe("how much of the backlog one tick takes", () => {
  it("asks the database for at most five", async () => {
    expect((await queryFor()).take).toBe(MAX_DISPATCHES_PER_TICK);
  });

  it("caps at five rather than at some other number", () => {
    expect(MAX_DISPATCHES_PER_TICK).toBe(5);
  });

  /**
   * The cap and the ordering only make sense together: taking five of an
   * unordered set would strand whichever workers kept losing the draw.
   */
  it("still takes the oldest slots first", async () => {
    const query = await queryFor();

    expect(query.orderBy).toEqual({ nextRunAt: "asc" });
    expect(query.take).toBe(MAX_DISPATCHES_PER_TICK);
  });

  it("does not decide anything else about which workers are due", async () => {
    const query = await queryFor();

    expect(query.where).toEqual({
      status: "active",
      nextRunAt: { lte: NOW },
    });
  });

  /** The dispatcher receives what the query returned, and nothing is re-filtered. */
  it("hands on every row the query returned", async () => {
    const records = [1, 2, 3, 4, 5].map((n) =>
      dueRecord({ id: `worker-${n}` }),
    );
    findMany.mockResolvedValue(records);

    expect(await getDueWorkers(NOW)).toHaveLength(5);
  });
});
