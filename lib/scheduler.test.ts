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

/**
 * What a tick looks like once more than one person is using AutoOps.
 *
 * **The cap is on the tick, not on the account**, and that is the whole of the
 * fairness story: five accounts with two due workers each produce ten slots,
 * and a tick takes the five that have been waiting longest whoever owns them.
 * Nobody is served first because of who they are, and nobody is served first
 * because they asked for more — a busy account's extra workers are simply
 * further down the same queue.
 *
 * **Not round-robin, and these do not make it one.** Per-account turn-taking
 * would be a different scheduler with a different failure mode; what is fixed
 * here is the behaviour that exists, so that a later change to it is a decision
 * somebody makes rather than one that happens.
 */
describe("a tick with several accounts waiting", () => {
  /** Five owners, two workers each, every slot already past. */
  function tenDueWorkers() {
    return Array.from({ length: 10 }, (_, index) => {
      const owner = Math.floor(index / 2) + 1;

      return dueRecord({
        id: `worker-${String(index).padStart(2, "0")}`,
        userId: `user-${owner}`,
        // A minute apart, oldest first, so "waiting longest" is unambiguous.
        nextRunAt: new Date(Date.UTC(2026, 7, 10, 8, 50 + index)),
      });
    });
  }

  /**
   * **Ten due, five taken, and the five are the oldest.** The other five keep
   * their slots — nothing was claimed for them — so the next tick finds them
   * exactly where they were, at the front of the same queue.
   */
  it("takes the five oldest slots, whoever they belong to", async () => {
    const due = tenDueWorkers();
    // The query itself does the ordering and the cap; the double replaces
    // PostgreSQL doing so, which is what makes this about the request.
    findMany.mockImplementation(async (args: { take: number }) =>
      [...due]
        .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
        .slice(0, args.take),
    );

    const selected = await getDueWorkers(NOW);
    const owners = new Set(selected.map((worker) => worker.userId));

    expect(selected).toHaveLength(MAX_DISPATCHES_PER_TICK);
    expect(selected.map((worker) => worker.id)).toEqual([
      "worker-00",
      "worker-01",
      "worker-02",
      "worker-03",
      "worker-04",
    ]);
    // Three accounts in the first five, which is what "oldest first" produces
    // here — the point being that it is not one account's five.
    expect(owners.size).toBeGreaterThan(1);
  });

  /**
   * **The scheduler is the one read in AutoOps that is deliberately not an
   * account's.** Everything a person can reach is scoped by `userId`, several
   * of them twice over; this runs on behalf of nobody and must see every due
   * worker there is.
   *
   * Scoping it to an account would not look like a leak — it would look like
   * workers quietly never running, for everyone but whoever the filter named.
   * That is the regression this exists to catch, and it is a different claim
   * from the shape assertion above: this one names the hazard, so a filter
   * added at any depth fails here rather than only where the whole object is
   * compared.
   */
  it("never narrows the query to one account", async () => {
    const where = (await queryFor()).where as Record<string, unknown>;

    expect(where).not.toHaveProperty("userId");
    expect(where).not.toHaveProperty("user");
    expect(JSON.stringify(where)).not.toContain("userId");
  });
});
