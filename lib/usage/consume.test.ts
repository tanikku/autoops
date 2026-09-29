import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spending part of an allowance, and the one thing a mock cannot show.
 *
 * These reach the primitive with the database replaced, so what they fix is the
 * shape of the write: which row is matched, under what condition, and what each
 * answer means. **That the condition is actually exclusive is a property of
 * PostgreSQL**, and it is the same limit `lib/rate-limit.test.ts`,
 * `lib/execution-lease.test.ts` and `lib/manual-run-slot.test.ts` all record.
 *
 * What is worth fixing here is everything a race would be lost to: that the
 * comparison travels inside the `UPDATE` rather than being made in JavaScript
 * from a number read a moment earlier, and that the limit the decision was made
 * against is matched again so it cannot have moved underneath.
 *
 * **Nothing calls this.** No run spends anything on this version.
 */

const { findUnique, updateMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { usageCounter: { findUnique, updateMany } },
}));

const { allowanceRefusalOf, consumeUsage, spendAllowances } = await import(
  "@/lib/usage/consume"
);

const PERIOD = "usage-period-1";

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset();
});

/** The argument of the only `updateMany`. */
function updateCall() {
  return updateMany.mock.calls[0][0];
}

describe("taking from an allowance", () => {
  it("takes what was asked for when there is room", async () => {
    findUnique.mockResolvedValue({ limit: 150 });
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeUsage(PERIOD, "aiProcessing", 1)).toEqual({
      granted: true,
      limit: 150,
    });
  });

  it("addresses the one counter for this period and kind", async () => {
    findUnique.mockResolvedValue({ limit: 150 });
    updateMany.mockResolvedValue({ count: 1 });

    await consumeUsage(PERIOD, "discovery", 1);

    expect(findUnique.mock.calls[0][0].where).toEqual({
      periodId_kind: { periodId: PERIOD, kind: "discovery" },
    });
    expect(updateCall().where.periodId).toBe(PERIOD);
    expect(updateCall().where.kind).toBe("discovery");
  });

  /**
   * **The comparison is in the `where`, not in JavaScript.** A version that
   * read the row, compared, and then wrote would let two callers through at the
   * boundary, and the account would end the period over its allowance.
   */
  it("makes the decision inside the write", async () => {
    findUnique.mockResolvedValue({ limit: 150 });
    updateMany.mockResolvedValue({ count: 1 });

    await consumeUsage(PERIOD, "aiProcessing", 1);

    expect(updateCall().where.used).toEqual({ lte: 149 });
    expect(updateCall().data).toEqual({ used: { increment: 1 } });
  });

  /**
   * **The limit is matched again in the condition.** Prisma cannot compare two
   * columns, so the number has to come from a read — and re-matching it is what
   * makes that safe: if the stored limit moved in between, nothing is taken.
   */
  it("matches the limit the decision was made against", async () => {
    findUnique.mockResolvedValue({ limit: 30 });
    updateMany.mockResolvedValue({ count: 0 });

    await consumeUsage(PERIOD, "manualRun", 1);

    expect(updateCall().where.limit).toBe(30);
  });

  it("scales the room it asks for to the units it wants", async () => {
    findUnique.mockResolvedValue({ limit: 300 });
    updateMany.mockResolvedValue({ count: 1 });

    await consumeUsage(PERIOD, "aiProcessing", 5);

    expect(updateCall().where.used).toEqual({ lte: 295 });
    expect(updateCall().data).toEqual({ used: { increment: 5 } });
  });

  /**
   * **Units, not requests.** What one call to a model is worth is decided by
   * the caller from a table that can change; the counter holds product units,
   * so a re-weighting is a constant rather than a migration.
   */
  it("takes more than one unit for a single spend", async () => {
    findUnique.mockResolvedValue({ limit: 50 });
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeUsage(PERIOD, "aiProcessing", 3)).toEqual({
      granted: true,
      limit: 50,
    });
  });
});

describe("an allowance that is spent", () => {
  it("takes nothing and says so", async () => {
    findUnique.mockResolvedValue({ limit: 30 });
    updateMany.mockResolvedValue({ count: 0 });

    expect(await consumeUsage(PERIOD, "manualRun", 1)).toEqual({
      granted: false,
      reason: "exhausted",
    });
  });

  /**
   * **A spend larger than the whole allowance cannot squeeze in.** The
   * condition becomes one nothing satisfies rather than one that happens to
   * pass when the counter is empty.
   */
  it("refuses a spend bigger than the allowance", async () => {
    findUnique.mockResolvedValue({ limit: 10 });
    updateMany.mockResolvedValue({ count: 0 });

    await consumeUsage(PERIOD, "discovery", 11);

    expect(updateCall().where.used).toEqual({ lte: -1 });
  });
});

describe("a counter that is not there", () => {
  /**
   * Distinguished from an exhausted allowance because they mean opposite
   * things: one is an account that has spent what it had, the other is a period
   * that was never opened properly.
   */
  it("is its own answer, and writes nothing", async () => {
    findUnique.mockResolvedValue(null);

    expect(await consumeUsage(PERIOD, "aiProcessing", 1)).toEqual({
      granted: false,
      reason: "unknown-counter",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

/**
 * **Spent on the way in, and never given back.** The hourly allowances follow
 * the same rule for the same reason: a call that failed was still made, and a
 * refund would be a second way for two callers to disagree about what is left.
 */
describe("what the module deliberately does not offer", () => {
  it("has no way to return units", async () => {
    const exported = await import("@/lib/usage/consume");

    // Two ways to spend and one way to read why a spend was refused — and
    // nothing that gives a unit back.
    expect(Object.keys(exported).sort()).toEqual([
      "allowanceRefusalOf",
      "consumeUsage",
      "spendAllowances",
    ]);

    for (const name of Object.keys(exported)) {
      expect(name).not.toMatch(/refund|return|restore|release|credit/i);
    }
  });
});

describe("an amount that is not an amount", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("refuses %s before reading anything", async (_label, units) => {
    await expect(consumeUsage(PERIOD, "aiProcessing", units)).rejects.toThrow();

    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

/**
 * Spending several allowances for an account, all or nothing.
 *
 * **A fake database that can roll back.** Each of these hands `spendAllowances`
 * a client of its own — never the module's `prisma` — whose `$transaction`
 * keeps a copy of every row and restores it when the work inside throws. That
 * is what lets "nothing was taken" be checked as a fact about the rows rather
 * than inferred from which calls were made.
 *
 * **What this cannot show is PostgreSQL's locking.** Whether two transactions
 * really wait for each other on the account's row, and whether the conditional
 * `UPDATE` really re-reads after waiting, needs a real database; see the
 * report for the integration checks this leaves.
 */

const NOW = new Date("2026-10-15T09:00:00.000Z");
const USER = "116614511017733764020";

type CounterRow = { used: number; limit: number };
type PeriodRow = {
  id: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  planAtStart: string;
};

/** A client whose rows live in memory and whose transactions really undo. */
function fakeDatabase(options: {
  subscription?: Record<string, unknown> | null;
  periods?: PeriodRow[];
  counters?: Record<string, CounterRow>;
  createFailures?: number;
}) {
  let periods: PeriodRow[] = structuredClone(options.periods ?? []);
  let counters: Record<string, CounterRow> = structuredClone(options.counters ?? {});
  let createFailures = options.createFailures ?? 0;
  const calls: string[] = [];
  let transactions = 0;

  const key = (periodId: string, kind: string) => `${periodId}:${kind}`;

  const tx = {
    user: {
      update: vi.fn(async (args: { where: { id: string }; data: { id: string } }) => {
        calls.push(`lock:${args.where.id}`);
        return { id: args.where.id };
      }),
    },
    subscription: {
      findUnique: vi.fn(async () => {
        calls.push("subscription");
        return options.subscription === undefined ? null : structuredClone(options.subscription);
      }),
    },
    usagePeriod: {
      findUnique: vi.fn(
        async (args: {
          where: { userId_periodStart: { userId: string; periodStart: Date } };
        }) => {
          const { userId, periodStart } = args.where.userId_periodStart;
          const found = periods.find(
            (period) =>
              period.userId === userId &&
              period.periodStart.getTime() === periodStart.getTime(),
          );

          return found === undefined ? null : withCounters(found);
        },
      ),
      create: vi.fn(
        async (args: {
          data: PeriodRow & {
            counters: { create: { kind: string; used: number; limit: number }[] };
          };
        }) => {
          calls.push("period:create");

          if (createFailures > 0) {
            createFailures -= 1;
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }

          const period: PeriodRow = {
            id: `period-${periods.length + 1}`,
            userId: args.data.userId,
            periodStart: args.data.periodStart,
            periodEnd: args.data.periodEnd,
            planAtStart: args.data.planAtStart,
          };

          periods.push(period);

          for (const counter of args.data.counters.create) {
            counters[key(period.id, counter.kind)] = {
              used: counter.used,
              limit: counter.limit,
            };
          }

          return withCounters(period);
        },
      ),
    },
    usageCounter: {
      findUnique: vi.fn(
        async (args: { where: { periodId_kind: { periodId: string; kind: string } } }) => {
          const { periodId, kind } = args.where.periodId_kind;
          const counter = counters[key(periodId, kind)];

          return counter === undefined ? null : { limit: counter.limit };
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { periodId: string; kind: string; limit: number; used: { lte: number } };
          data: { used: { increment: number } };
        }) => {
          calls.push(`increment:${args.where.kind}`);
          const counter = counters[key(args.where.periodId, args.where.kind)];

          if (
            counter === undefined ||
            counter.limit !== args.where.limit ||
            counter.used > args.where.used.lte
          ) {
            return { count: 0 };
          }

          counter.used += args.data.used.increment;
          return { count: 1 };
        },
      ),
      aggregate: vi.fn(
        async (args: { where: { kind: string; period: { userId: string } } }) => {
          const owned = new Set(
            periods
              .filter((period) => period.userId === args.where.period.userId)
              .map((period) => period.id),
          );
          let sum: number | null = null;

          for (const [counterKey, counter] of Object.entries(counters)) {
            const [periodId, kind] = counterKey.split(":");

            if (owned.has(periodId) && kind === args.where.kind) {
              sum = (sum ?? 0) + counter.used;
            }
          }

          return { _sum: { used: sum } };
        },
      ),
    },
  };

  function withCounters(period: PeriodRow) {
    return {
      ...period,
      counters: Object.entries(counters)
        .filter(([counterKey]) => counterKey.startsWith(`${period.id}:`))
        .map(([counterKey, counter]) => ({
          kind: counterKey.split(":")[1],
          used: counter.used,
          limit: counter.limit,
        })),
    };
  }

  const client = {
    ...tx,
    $transaction: vi.fn(async (work: (inner: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      const savedPeriods = structuredClone(periods);
      const savedCounters = structuredClone(counters);

      try {
        return await work(tx);
      } catch (error) {
        periods = savedPeriods;
        counters = savedCounters;
        throw error;
      }
    }),
  };

  return {
    client,
    tx,
    calls,
    transactions: () => transactions,
    used: (periodId: string, kind: string) => counters[key(periodId, kind)]?.used,
    periods: () => periods,
  };
}

/** A paid Lite subscription in force, counted from 1 October to 1 November. */
function paidRow(overrides: Record<string, unknown> = {}) {
  return {
    plan: "lite",
    state: "active",
    source: "stripe",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
    notificationWorkerId: null,
    expiresAt: null,
    ...overrides,
  };
}

const PAID_PERIOD: PeriodRow = {
  id: "period-paid",
  userId: USER,
  periodStart: new Date("2026-10-01T00:00:00.000Z"),
  periodEnd: new Date("2026-11-01T00:00:00.000Z"),
  planAtStart: "lite",
};

/** Lite's counters, with room chosen per test. */
function liteCounters(used: { ai?: number; manual?: number; discovery?: number } = {}) {
  return {
    "period-paid:aiProcessing": { used: used.ai ?? 0, limit: 30 },
    "period-paid:manualRun": { used: used.manual ?? 0, limit: 20 },
    "period-paid:discovery": { used: used.discovery ?? 0, limit: 10 },
  };
}

function spend(
  db: ReturnType<typeof fakeDatabase>,
  items: { kind: "aiProcessing" | "manualRun" | "discovery"; units: number }[],
) {
  return spendAllowances({
    userId: USER,
    items,
    now: NOW,
    client: db.client as never,
  });
}

describe("spendAllowances — what it will not accept", () => {
  it.each([
    ["no allowances", []],
    ["zero units", [{ kind: "aiProcessing", units: 0 }]],
    ["negative units", [{ kind: "aiProcessing", units: -1 }]],
    ["a fraction of a unit", [{ kind: "aiProcessing", units: 1.5 }]],
    ["an allowance that does not exist", [{ kind: "tokens", units: 1 }]],
    [
      "the same allowance twice",
      [
        { kind: "manualRun", units: 1 },
        { kind: "manualRun", units: 1 },
      ],
    ],
  ])("throws for %s before touching anything", async (_label, items) => {
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters: liteCounters() });

    await expect(spend(db, items as never)).rejects.toThrow();
    expect(db.transactions()).toBe(0);
    expect(db.calls).toEqual([]);
  });
});

describe("spendAllowances — an account with room", () => {
  it("takes one allowance and says so", async () => {
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters: liteCounters() });

    expect(await spend(db, [{ kind: "manualRun", units: 1 }])).toEqual({ granted: true });
    expect(db.used("period-paid", "manualRun")).toBe(1);
  });

  it("takes the account's lock before reading anything", async () => {
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters: liteCounters() });

    await spend(db, [{ kind: "manualRun", units: 1 }]);

    expect(db.calls[0]).toBe(`lock:${USER}`);
    expect(db.tx.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { id: USER },
    });
  });

  it("takes several in a fixed order, whatever order they were asked in", async () => {
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters: liteCounters() });

    await spend(db, [
      { kind: "discovery", units: 1 },
      { kind: "manualRun", units: 1 },
      { kind: "aiProcessing", units: 1 },
    ]);

    expect(db.calls.filter((call) => call.startsWith("increment:"))).toEqual([
      "increment:aiProcessing",
      "increment:manualRun",
      "increment:discovery",
    ]);
  });

  /** The comparison travels inside the write, as `consumeUsage`'s does. */
  it("asks for the increment only while it still fits", async () => {
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters: liteCounters() });

    await spend(db, [{ kind: "aiProcessing", units: 3 }]);

    expect(db.tx.usageCounter.updateMany.mock.calls[0][0]).toEqual({
      where: { periodId: "period-paid", kind: "aiProcessing", limit: 30, used: { lte: 27 } },
      data: { used: { increment: 3 } },
    });
  });

  it("allows the very last unit and refuses the one after it", async () => {
    const db = fakeDatabase({
      subscription: paidRow(),
      periods: [PAID_PERIOD],
      counters: liteCounters({ manual: 19 }),
    });

    expect(await spend(db, [{ kind: "manualRun", units: 1 }])).toEqual({ granted: true });
    expect(await spend(db, [{ kind: "manualRun", units: 1 }])).toEqual({
      granted: false,
      reason: "exhausted",
      kind: "manualRun",
      scope: "period",
    });
    expect(db.used("period-paid", "manualRun")).toBe(20);
  });
});

describe("spendAllowances — all or nothing", () => {
  it("takes nothing when one of two has no room", async () => {
    const db = fakeDatabase({
      subscription: paidRow(),
      periods: [PAID_PERIOD],
      counters: liteCounters({ manual: 19, ai: 30 }),
    });

    expect(
      await spend(db, [
        { kind: "manualRun", units: 1 },
        { kind: "aiProcessing", units: 1 },
      ]),
    ).toEqual({ granted: false, reason: "exhausted", kind: "aiProcessing", scope: "period" });
    expect(db.used("period-paid", "manualRun")).toBe(19);
    expect(db.used("period-paid", "aiProcessing")).toBe(30);
  });

  /** The one that fails last is undone too: the increment before it rolls back. */
  it("undoes an allowance already taken when a later one is refused", async () => {
    const db = fakeDatabase({
      subscription: paidRow(),
      periods: [PAID_PERIOD],
      counters: liteCounters({ discovery: 10 }),
    });

    expect(
      await spend(db, [
        { kind: "discovery", units: 1 },
        { kind: "manualRun", units: 1 },
      ]),
    ).toEqual({ granted: false, reason: "exhausted", kind: "discovery", scope: "period" });
    // manualRun comes first in the fixed order, so it was incremented and then
    // rolled back with the transaction.
    expect(db.calls).toContain("increment:manualRun");
    expect(db.used("period-paid", "manualRun")).toBe(0);
  });

  it("names the missing counter and undoes the rest", async () => {
    const counters = liteCounters();
    delete (counters as Record<string, CounterRow>)["period-paid:discovery"];
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters });

    expect(
      await spend(db, [
        { kind: "manualRun", units: 1 },
        { kind: "discovery", units: 1 },
      ]),
    ).toEqual({ granted: false, reason: "unknown-counter", kind: "discovery" });
    expect(db.used("period-paid", "manualRun")).toBe(0);
  });
});

describe("spendAllowances — who may spend, and from where", () => {
  it.each([
    ["an active paid plan", paidRow()],
    ["a paid plan whose payment needs attention", paidRow({ state: "grace" })],
    ["a cancellation still inside its period", paidRow({ state: "canceled_active" })],
  ])("spends %s from its billing period", async (_label, row) => {
    const db = fakeDatabase({ subscription: row, periods: [PAID_PERIOD], counters: liteCounters() });

    expect(await spend(db, [{ kind: "manualRun", units: 1 }])).toEqual({ granted: true });
    expect(db.used("period-paid", "manualRun")).toBe(1);
    expect(db.tx.usagePeriod.create).not.toHaveBeenCalled();
  });

  it("spends a running trial from the trial's own fortnight", async () => {
    const trialStart = new Date("2026-10-10T00:00:00.000Z");
    const trialEnd = new Date("2026-10-24T00:00:00.000Z");
    const db = fakeDatabase({
      subscription: paidRow({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: trialStart,
        trialEndsAt: trialEnd,
        trialConsumedAt: trialStart,
        trialForfeitedAt: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    });

    expect(await spend(db, [{ kind: "manualRun", units: 1 }])).toEqual({ granted: true });

    const [period] = db.periods();
    expect(period.periodStart).toEqual(trialStart);
    expect(period.periodEnd).toEqual(trialEnd);
    expect(period.planAtStart).toBe("trial");
  });

  it("spends a valid Beta grant from the calendar month", async () => {
    const db = fakeDatabase({
      subscription: paidRow({
        plan: "beta",
        source: "admin",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      }),
    });

    expect(await spend(db, [{ kind: "manualRun", units: 1 }])).toEqual({ granted: true });

    const [period] = db.periods();
    expect(period.periodStart).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(period.periodEnd).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(period.planAtStart).toBe("beta");
  });

  it.each([
    [
      "a trial that has run out",
      paidRow({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-09-20T00:00:00.000Z"),
        trialEndsAt: new Date("2026-10-04T00:00:00.000Z"),
        trialConsumedAt: new Date("2026-09-20T00:00:00.000Z"),
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    ],
    [
      "a Beta grant past its expiry",
      paidRow({ plan: "beta", source: "admin", expiresAt: new Date("2026-10-01T00:00:00.000Z") }),
    ],
    ["a subscription that has ended", paidRow({ state: "inactive" })],
    [
      "a cancellation whose period has run out",
      paidRow({ state: "canceled_active", currentPeriodEnd: new Date("2026-10-10T00:00:00.000Z") }),
    ],
    ["a state this version does not know", paidRow({ state: "frozen" })],
    ["a plan this version does not know", paidRow({ plan: "enterprise" })],
  ])("spends nothing for %s, and opens no period", async (_label, row) => {
    const db = fakeDatabase({ subscription: row, periods: [PAID_PERIOD], counters: liteCounters() });

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({
      granted: false,
      reason: "not-entitled",
    });
    expect(db.tx.usagePeriod.create).not.toHaveBeenCalled();
    expect(db.tx.usageCounter.updateMany).not.toHaveBeenCalled();
  });

  /** An entitled row the window resolver will not count is not a grant. */
  it("says not-counted for a trial it cannot place, and takes nothing", async () => {
    const db = fakeDatabase({
      subscription: paidRow({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: null,
        trialEndsAt: new Date("2026-10-24T00:00:00.000Z"),
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    });

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({
      granted: false,
      reason: "not-counted",
    });
    expect(db.tx.usagePeriod.create).not.toHaveBeenCalled();
  });
});

describe("spendAllowances — before a trial", () => {
  /** Counters from earlier months, as observation opened them. */
  function preTrial(usedByMonth: number[]) {
    const periods: PeriodRow[] = [];
    const counters: Record<string, CounterRow> = {};

    usedByMonth.forEach((used, index) => {
      const id = `month-${index}`;
      periods.push({
        id,
        userId: USER,
        periodStart: new Date(Date.UTC(2026, 9 - index, 1)),
        periodEnd: new Date(Date.UTC(2026, 10 - index, 1)),
        planAtStart: "beta",
      });
      counters[`${id}:aiProcessing`] = { used, limit: 300 };
      counters[`${id}:manualRun`] = { used: 0, limit: 300 };
      counters[`${id}:discovery`] = { used: 0, limit: 150 };
    });

    return fakeDatabase({ subscription: null, periods, counters });
  }

  it("allows AI while the lifetime total stays within the trial's allowance", async () => {
    const db = preTrial([49]);

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({ granted: true });
    expect(db.used("month-0", "aiProcessing")).toBe(50);
  });

  it.each([
    ["49 used and 2 asked", [49], 2],
    ["50 used and 1 asked", [50], 1],
  ])("refuses with %s", async (_label, used, units) => {
    const db = preTrial(used);

    expect(await spend(db, [{ kind: "aiProcessing", units }])).toEqual({
      granted: false,
      reason: "exhausted",
      kind: "aiProcessing",
      scope: "pre-trial",
    });
    expect(db.used("month-0", "aiProcessing")).toBe(used[0]);
  });

  /** A month boundary does not refill it: the pool is the whole history. */
  it("counts every earlier month, not only this one", async () => {
    const db = preTrial([10, 40]);

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({
      granted: false,
      reason: "exhausted",
      kind: "aiProcessing",
      scope: "pre-trial",
    });
  });

  it("measures the pool against the trial's AI allowance from the catalogue", async () => {
    const { getPlanDefinition } = await import("@/lib/plans");
    const limit = getPlanDefinition("trial").aiProcessingLimit;
    const db = preTrial([limit - 1]);

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({ granted: true });
    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toMatchObject({
      reason: "exhausted",
      scope: "pre-trial",
    });
  });

  it.each(["manualRun", "discovery"] as const)(
    "refuses %s outright",
    async (kind) => {
      const db = preTrial([0]);

      expect(await spend(db, [{ kind, units: 1 }])).toEqual({
        granted: false,
        reason: "not-entitled",
      });
      expect(db.tx.usageCounter.updateMany).not.toHaveBeenCalled();
    },
  );

  it("opens this month's period for the first use", async () => {
    const db = fakeDatabase({ subscription: null });

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({ granted: true });
    expect(db.periods()).toHaveLength(1);
    expect(db.periods()[0].periodStart).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });
});

describe("spendAllowances — a period opened by observation at the same moment", () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
  });

  it("begins again once, and says so without naming anybody", async () => {
    const db = fakeDatabase({ subscription: null, createFailures: 1 });

    expect(await spend(db, [{ kind: "aiProcessing", units: 1 }])).toEqual({ granted: true });
    expect(db.transactions()).toBe(2);
    expect(warnings).toEqual(["[usage] allowance period conflict — retried"]);
  });

  it("gives up after the second collision", async () => {
    const db = fakeDatabase({ subscription: null, createFailures: 2 });

    await expect(spend(db, [{ kind: "aiProcessing", units: 1 }])).rejects.toMatchObject({
      code: "P2002",
    });
    expect(db.transactions()).toBe(2);
  });

  it.each([
    ["a write conflict", "P2034"],
    ["anything else", "P9999"],
  ])("does not retry %s", async (_label, code) => {
    const db = fakeDatabase({ subscription: null });
    db.tx.usagePeriod.create.mockRejectedValueOnce(Object.assign(new Error("boom"), { code }));

    await expect(spend(db, [{ kind: "aiProcessing", units: 1 }])).rejects.toMatchObject({ code });
    expect(db.transactions()).toBe(1);
    expect(warnings).toEqual([]);
  });
});

describe("spendAllowances — inside a caller's transaction", () => {
  function joinTransaction(db: ReturnType<typeof fakeDatabase>) {
    return spendAllowances({
      userId: USER,
      items: [{ kind: "manualRun", units: 1 }],
      now: NOW,
      client: db.tx as never,
    });
  }

  it("joins it rather than opening one", async () => {
    const db = fakeDatabase({ subscription: paidRow(), periods: [PAID_PERIOD], counters: liteCounters() });

    expect(await joinTransaction(db)).toEqual({ granted: true });
    expect(db.transactions()).toBe(0);
  });

  /** The caller's transaction has to end with the refusal; it is thrown to make sure. */
  it("throws a refusal so the caller's transaction aborts, and it can be read back", async () => {
    const db = fakeDatabase({
      subscription: paidRow(),
      periods: [PAID_PERIOD],
      counters: liteCounters({ manual: 20 }),
    });

    const error = await joinTransaction(db).catch((caught: unknown) => caught);

    expect(allowanceRefusalOf(error)).toEqual({
      granted: false,
      reason: "exhausted",
      kind: "manualRun",
      scope: "period",
    });
  });

  it("never retries a collision in somebody else's transaction", async () => {
    const db = fakeDatabase({ subscription: null, createFailures: 1 });

    await expect(
      spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        now: NOW,
        client: db.tx as never,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(db.tx.usagePeriod.create).toHaveBeenCalledTimes(1);
  });

  it("reads no refusal from an ordinary error", () => {
    expect(allowanceRefusalOf(new Error("other"))).toBeNull();
  });
});

describe("spendAllowances — what it does not do", () => {
  it("has no caller yet", async () => {
    const { execSync } = await import("node:child_process");
    const found = execSync(
      "git grep -l 'spendAllowances' -- app lib components ':!lib/usage/consume.ts' ':!lib/usage/consume.test.ts' || true",
      { encoding: "utf8" },
    ).trim();

    expect(found).toBe("");
  });

  it("keeps no copy of any plan's numbers", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/usage/consume.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const limit of ["50", "30", "20", "14", "150", "300"]) {
      expect(source, `holds ${limit}`).not.toMatch(new RegExp(`\\b${limit}\\b`));
    }
  });
});

/**
 * Which instant a spend is judged at, when the caller does not say.
 *
 * **Read once the account's lock is held.** A trial start that took the lock
 * first has committed its start instant by the time a waiting spend gets the
 * lock; a clock read before waiting would fall just before that start — outside
 * the trial and inside no period — and the spend would be refused as not
 * counted. That is the race the PostgreSQL run found, reproduced here with the
 * lock standing in as the moment time moves.
 */
describe("spendAllowances — the instant it is judged at", () => {
  const BEFORE_TRIAL = new Date("2026-10-15T09:00:00.000Z");
  const TRIAL_START = new Date("2026-10-15T09:00:01.000Z");
  const TRIAL_END = new Date("2026-10-29T09:00:01.000Z");
  const AFTER_LOCK = new Date("2026-10-15T09:00:02.000Z");

  /** The trial another transaction committed while this one waited. */
  const startedTrial = {
    plan: "trial",
    state: "trialing",
    source: "trial",
    trialStartedAt: TRIAL_START,
    trialEndsAt: TRIAL_END,
    trialConsumedAt: TRIAL_START,
    trialForfeitedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    notificationWorkerId: null,
    expiresAt: null,
  };

  /** Moves the clock the moment the lock is granted, as waiting would. */
  function clockMovesAtLock(db: ReturnType<typeof fakeDatabase>, ...instants: Date[]) {
    for (const instant of instants) {
      db.tx.user.update.mockImplementationOnce(
        async (args: { where: { id: string } }) => {
          db.calls.push(`lock:${args.where.id}`);
          vi.setSystemTime(instant);
          return { id: args.where.id };
        },
      );
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_TRIAL);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spends from a trial that started while it waited for the lock", async () => {
    const db = fakeDatabase({ subscription: startedTrial });
    clockMovesAtLock(db, AFTER_LOCK);

    expect(
      await spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        client: db.client as never,
      }),
    ).toEqual({ granted: true });

    const [period] = db.periods();
    expect(period.planAtStart).toBe("trial");
    expect(period.periodStart).toEqual(TRIAL_START);
    expect(db.used(period.id, "aiProcessing")).toBe(1);
  });

  /** The same trial, judged at an instant the caller named: used as given. */
  it("uses an explicit instant exactly as given, even one before the trial", async () => {
    const db = fakeDatabase({ subscription: startedTrial });
    clockMovesAtLock(db, AFTER_LOCK);

    expect(
      await spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        now: BEFORE_TRIAL,
        client: db.client as never,
      }),
    ).toEqual({ granted: false, reason: "not-counted" });
    expect(db.periods()).toEqual([]);
  });

  /** Spend first, trial later: nothing about the pre-trial path changes. */
  it("still spends from the pre-trial pool when it gets the lock first", async () => {
    const db = fakeDatabase({ subscription: null });
    clockMovesAtLock(db, AFTER_LOCK);

    expect(
      await spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        client: db.client as never,
      }),
    ).toEqual({ granted: true });

    const [period] = db.periods();
    expect(period.planAtStart).toBe("beta");
    expect(period.periodStart).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });

  it("reads the clock after the lock, not before it", async () => {
    const db = fakeDatabase({ subscription: startedTrial });
    const order: string[] = [];
    db.tx.user.update.mockImplementationOnce(async (args: { where: { id: string } }) => {
      order.push("lock");
      vi.setSystemTime(AFTER_LOCK);
      return { id: args.where.id };
    });
    db.tx.subscription.findUnique.mockImplementation(async () => {
      order.push(`read at ${new Date().toISOString()}`);
      return structuredClone(startedTrial);
    });

    await spendAllowances({
      userId: USER,
      items: [{ kind: "aiProcessing", units: 1 }],
      client: db.client as never,
    });

    expect(order[0]).toBe("lock");
    expect(order.slice(1).every((line) => line === `read at ${AFTER_LOCK.toISOString()}`)).toBe(
      true,
    );
  });

  /**
   * **A retry reads the clock again.** The first attempt's instant belongs to a
   * transaction that no longer exists; the second is judged at its own lock.
   * Crossing a month boundary between the two makes the difference visible.
   */
  it("reads a fresh instant for the retry after a period collision", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDatabase({ subscription: null, createFailures: 1 });
    clockMovesAtLock(
      db,
      new Date("2026-10-31T23:59:59.000Z"),
      new Date("2026-11-01T00:00:01.000Z"),
    );

    expect(
      await spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        client: db.client as never,
      }),
    ).toEqual({ granted: true });

    const [period] = db.periods();
    expect(period.periodStart).toEqual(new Date("2026-11-01T00:00:00.000Z"));
  });

  it("keeps an explicit instant across the retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDatabase({ subscription: null, createFailures: 1 });
    clockMovesAtLock(
      db,
      new Date("2026-10-31T23:59:59.000Z"),
      new Date("2026-11-01T00:00:01.000Z"),
    );

    expect(
      await spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        now: new Date("2026-10-20T00:00:00.000Z"),
        client: db.client as never,
      }),
    ).toEqual({ granted: true });

    const [period] = db.periods();
    expect(period.periodStart).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });

  it("reads it after the lock inside a caller's transaction too", async () => {
    const db = fakeDatabase({ subscription: startedTrial });
    clockMovesAtLock(db, AFTER_LOCK);

    expect(
      await spendAllowances({
        userId: USER,
        items: [{ kind: "aiProcessing", units: 1 }],
        client: db.tx as never,
      }),
    ).toEqual({ granted: true });
    expect(db.periods()[0].planAtStart).toBe("trial");
  });
});
