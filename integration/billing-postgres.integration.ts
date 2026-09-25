import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { applyBillingEvent } from "@/lib/billing/transition";
import type { BillingEventInput } from "@/lib/billing/events";
import { requireTestDatabaseUrl } from "@/integration/test-database";

/**
 * The billing transition layer against a real PostgreSQL.
 *
 * **What only a real database can answer.** `lib/billing/transition.test.ts`
 * fixes the shape of the code — the order of the steps, which branch writes
 * what — against a fake client that answers immediately. It cannot say what two
 * transactions do when they reach the same unique index at the same moment,
 * because a mock has no unique index and no transactions. That question is this
 * file's, and it is the one the webhook depends on: a provider will redeliver,
 * and two deliveries will overlap.
 *
 * **Opt-in, and it does not run with `pnpm test`.** The filename ends
 * `.integration.ts` rather than `.test.ts`, which the default Vitest discovery
 * does not match, and the run needs `BILLING_TEST_DATABASE_URL` pointing at a
 * disposable database. See `integration/README.md`.
 *
 * **M1E-3 proved the race itself, once, with the server's own log.** With
 * `log_statement=all` the losing INSERT was recorded before the winner's
 * COMMIT — so the loser genuinely blocked on the uncommitted index entry rather
 * than arriving afterwards — and it ended in ROLLBACK, never a COMMIT on an
 * aborted transaction. Scraping logs every run would be brittle for little
 * gain, so what this file asserts is the public contract that ordering
 * produces: one `applied`, one `duplicate`, no raw error, correct rows.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireTestDatabaseUrl() }),
});

/**
 * **A fixture of this run's own.** Two people running the suite against the
 * same disposable database would otherwise delete each other's rows halfway
 * through a race and blame the code.
 */
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const USER_ID = `billing-integration-${RUN}`;
const EMAIL = `billing-concurrency-${RUN}@example.invalid`;

const OCCURRED = new Date("2026-10-01T00:00:00.000Z");
const P1_START = new Date("2026-10-01T00:00:00.000Z");
const P1_END = new Date("2026-11-01T00:00:00.000Z");
const P2_START = new Date("2026-11-01T00:00:00.000Z");
const P2_END = new Date("2026-12-01T00:00:00.000Z");

/** Event ids are per-run too, since they are the idempotency key. */
const id = (name: string) => `evt-${name}-${RUN}`;

function activation(
  overrides: Partial<BillingEventInput> = {},
): BillingEventInput {
  return {
    provider: "test-provider",
    providerEventId: id("activate"),
    kind: "subscription.activated",
    userId: USER_ID,
    plan: "standard",
    periodStart: P1_START,
    periodEnd: P1_END,
    occurredAt: OCCURRED,
    providerCustomerId: `cust-${RUN}`,
    providerSubscriptionId: `sub-${RUN}`,
    ...overrides,
  };
}

/** This run's rows, removed in dependency order, then the account remade. */
async function resetFixture() {
  await prisma.$executeRaw`DELETE FROM "BillingEvent" WHERE "userId" = ${USER_ID}`;
  await prisma.$executeRaw`DELETE FROM "UsageCounter" WHERE "periodId" IN (SELECT "id" FROM "UsagePeriod" WHERE "userId" = ${USER_ID})`;
  await prisma.$executeRaw`DELETE FROM "UsagePeriod" WHERE "userId" = ${USER_ID}`;
  await prisma.$executeRaw`DELETE FROM "Subscription" WHERE "userId" = ${USER_ID}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${USER_ID}`;
  await prisma.user.create({ data: { id: USER_ID, email: EMAIL } });
}

type Settled =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error };

/**
 * Several deliveries of one event, genuinely at once.
 *
 * `Promise.all` rather than a loop: each call opens its own interactive
 * transaction on its own pooled connection, which is what a provider
 * redelivering to two instances looks like.
 */
async function race(
  count: number,
  make: () => BillingEventInput,
): Promise<Settled[]> {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, () => applyBillingEvent(make(), prisma)),
  );

  return settled.map((result) =>
    result.status === "fulfilled"
      ? ({ ok: true, value: result.value } as const)
      : ({ ok: false, error: result.reason as Error } as const),
  );
}

/**
 * What each call returned — or, for one that threw, a marker naming the error.
 *
 * **A throw is reported rather than rethrown**, so a failing assertion says
 * "expected applied+duplicate, got applied+THREW" instead of surfacing a raw
 * Prisma error with no indication of which of the two racers produced it.
 */
function outcomes(settled: Settled[]): string[] {
  return settled.map((s) =>
    s.ok
      ? (s.value as { outcome: string }).outcome
      : `THREW:${s.error.constructor.name}`,
  );
}

/** Asserts that nothing escaped, naming the error if something did. */
function expectNothingThrown(settled: Settled[]): void {
  for (const s of settled) {
    expect(s.ok, s.ok ? "" : `escaped to the caller: ${s.error.message}`).toBe(
      true,
    );
  }
}

async function state() {
  const [events, subscription, periods, counters] = await Promise.all([
    prisma.billingEvent.findMany({
      where: { userId: USER_ID },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.subscription.findUnique({ where: { userId: USER_ID } }),
    prisma.usagePeriod.findMany({
      where: { userId: USER_ID },
      orderBy: { periodStart: "asc" },
    }),
    prisma.usageCounter.findMany({
      where: { period: { userId: USER_ID } },
      orderBy: [{ periodId: "asc" }, { kind: "asc" }],
    }),
  ]);

  return { events, subscription, periods, counters };
}

/** Sets one counter of the current period, to stand in for real usage. */
async function spend(kind: string, used: number) {
  const period = await prisma.usagePeriod.findFirstOrThrow({
    where: { userId: USER_ID },
    orderBy: { periodStart: "desc" },
  });

  await prisma.usageCounter.update({
    where: { periodId_kind: { periodId: period.id, kind } },
    data: { used },
  });
}

/**
 * **The schema is checked before the first race, not assumed.** Run against a
 * database that never had `prisma migrate deploy`, every case below would fail
 * on a missing table and the report would read as a concurrency defect.
 */
beforeAll(async () => {
  const [{ server_version }] = await prisma.$queryRaw<
    { server_version: string }[]
  >`SHOW server_version`;

  const required = await prisma.$queryRaw<{ name: string; found: bigint }[]>`
    SELECT 'BillingEvent' AS name,
           count(*) AS found
      FROM information_schema.tables WHERE table_name = 'BillingEvent'
    UNION ALL
    SELECT 'Subscription.trialForfeitedAt', count(*)
      FROM information_schema.columns
     WHERE table_name = 'Subscription' AND column_name = 'trialForfeitedAt'
    UNION ALL
    SELECT 'unique(provider, providerEventId)', count(*)
      FROM pg_indexes
     WHERE tablename = 'BillingEvent'
       AND indexdef ILIKE '%UNIQUE%provider%providerEventId%'
    UNION ALL
    SELECT 'unique(userId, periodStart)', count(*)
      FROM pg_indexes
     WHERE tablename = 'UsagePeriod'
       AND indexdef ILIKE '%UNIQUE%userId%periodStart%'
    UNION ALL
    SELECT 'unique(periodId, kind)', count(*)
      FROM pg_indexes
     WHERE tablename = 'UsageCounter'
       AND indexdef ILIKE '%UNIQUE%periodId%kind%'
  `;

  // `count(*)` comes back as a BigInt; the literal form of one needs a newer
  // target than this project compiles to.
  const missing = required
    .filter((row) => Number(row.found) === 0)
    .map((row) => row.name);

  if (missing.length > 0) {
    throw new Error(
      `The test database is missing ${missing.join(", ")}. ` +
        "Run `pnpm exec prisma migrate deploy` against it first.",
    );
  }

  console.log(`PostgreSQL ${server_version}`);
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "BillingEvent" WHERE "userId" = ${USER_ID}`;
  await prisma.$executeRaw`DELETE FROM "UsageCounter" WHERE "periodId" IN (SELECT "id" FROM "UsagePeriod" WHERE "userId" = ${USER_ID})`;
  await prisma.$executeRaw`DELETE FROM "UsagePeriod" WHERE "userId" = ${USER_ID}`;
  await prisma.$executeRaw`DELETE FROM "Subscription" WHERE "userId" = ${USER_ID}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${USER_ID}`;
  await prisma.$disconnect();
});

describe("the same activation delivered twice at once", () => {
  beforeEach(resetFixture);

  it("applies one and recognises the other as a duplicate", async () => {
    const settled = await race(2, activation);

    expectNothingThrown(settled);
    expect(outcomes(settled).sort()).toEqual(["applied", "duplicate"]);
  });

  /**
   * **The unique violation must not reach the caller.** A webhook route reading
   * a raw `P2002`, or a transaction-aborted error, would have to know about
   * Prisma error codes to answer the provider — and would most likely answer
   * 500 and be redelivered forever.
   */
  it("lets no P2002 or aborted-transaction error escape", async () => {
    const settled = await race(2, activation);

    expectNothingThrown(settled);
    for (const s of settled) {
      expect(outcomes([s])[0]).toMatch(/^(applied|duplicate)$/);
    }
  });

  it("leaves exactly one of everything", async () => {
    await race(2, activation);
    const { events, subscription, periods, counters } = await state();

    expect(events).toHaveLength(1);
    expect(periods).toHaveLength(1);
    expect(counters).toHaveLength(3);
    expect(subscription).toMatchObject({
      plan: "standard",
      state: "active",
      source: "test-provider",
      trialConsumedAt: null,
    });
    expect(subscription?.trialForfeitedAt?.toISOString()).toBe(
      OCCURRED.toISOString(),
    );
    for (const counter of counters) {
      expect(counter.used).toBe(0);
    }
  });
});

/**
 * **What a redelivery must never do.** A provider can resend an event weeks
 * later; if that reopened the period, somebody's month of usage would go back
 * to zero and they would get their allowance twice.
 */
describe("a redelivery arriving after usage has been spent", () => {
  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);
    await spend("aiProcessing", 17);
    await spend("manualRun", 4);
    await spend("discovery", 2);
  });

  it("answers duplicate to both copies and erases nothing", async () => {
    const settled = await race(2, activation);

    expectNothingThrown(settled);
    expect(outcomes(settled)).toEqual(["duplicate", "duplicate"]);

    const { events, periods, counters } = await state();
    const used = Object.fromEntries(counters.map((c) => [c.kind, c.used]));

    expect(events).toHaveLength(1);
    expect(periods).toHaveLength(1);
    expect(used).toEqual({ aiProcessing: 17, manualRun: 4, discovery: 2 });
  });
});

describe("a renewal delivered twice at once", () => {
  const renewal = () =>
    activation({
      providerEventId: id("renew"),
      kind: "subscription.renewed",
      plan: null,
      periodStart: P2_START,
      periodEnd: P2_END,
      occurredAt: P2_START,
    });

  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);
    await spend("aiProcessing", 17);
  });

  it("opens exactly one new period and leaves the last one alone", async () => {
    const settled = await race(2, renewal);

    expectNothingThrown(settled);
    expect(outcomes(settled).sort()).toEqual(["applied", "duplicate"]);

    const { events, periods, counters } = await state();
    const fresh = periods.find(
      (p) => p.periodStart.getTime() === P2_START.getTime(),
    );
    const freshCounters = counters.filter((c) => c.periodId === fresh?.id);
    const previous = counters.filter((c) => c.periodId !== fresh?.id);

    expect(events).toHaveLength(2);
    expect(periods).toHaveLength(2);
    expect(freshCounters).toHaveLength(3);
    for (const counter of freshCounters) {
      expect(counter.used).toBe(0);
    }
    expect(previous.find((c) => c.kind === "aiProcessing")?.used).toBe(17);
  });
});

describe("an upgrade delivered twice at once", () => {
  const upgrade = () =>
    activation({
      providerEventId: id("upgrade"),
      kind: "subscription.plan_changed",
      plan: "pro",
      occurredAt: new Date("2026-10-15T00:00:00.000Z"),
    });

  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);
    await spend("aiProcessing", 17);
  });

  /** More room, in the period they are already in, without a second grant. */
  it("raises the limits once and keeps what was spent", async () => {
    const before = await prisma.usagePeriod.findFirstOrThrow({
      where: { userId: USER_ID },
    });

    const settled = await race(2, upgrade);

    expectNothingThrown(settled);
    expect(outcomes(settled).sort()).toEqual(["applied", "duplicate"]);

    const { events, subscription, periods, counters } = await state();
    const ai = counters.find((c) => c.kind === "aiProcessing");

    expect(events).toHaveLength(2);
    expect(periods).toHaveLength(1);
    expect(periods[0].id).toBe(before.id);
    // The period did open on Standard, and that stays true.
    expect(periods[0].planAtStart).toBe("standard");
    expect(subscription?.plan).toBe("pro");
    expect(ai?.used).toBe(17);
    expect(ai?.limit).toBeGreaterThan(0);
  });
});

describe("two events claiming the same instant", () => {
  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);
  });

  it("reports the ambiguity and writes nothing", async () => {
    const before = await state();

    const result = await applyBillingEvent(
      activation({
        providerEventId: id("ambiguous"),
        kind: "subscription.canceled",
        plan: null,
        occurredAt: OCCURRED,
      }),
      prisma,
    );

    expect(result).toEqual({ outcome: "ambiguous-order" });

    const after = await state();
    expect(after.events).toHaveLength(before.events.length);
    expect(after.subscription?.state).toBe(before.subscription?.state);
    expect(after.subscription?.plan).toBe(before.subscription?.plan);
  });
});

describe("an event the provider has already superseded", () => {
  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);
    await applyBillingEvent(
      activation({
        providerEventId: id("newer"),
        kind: "subscription.payment_grace",
        plan: null,
        occurredAt: new Date("2026-10-20T00:00:00.000Z"),
      }),
      prisma,
    );
  });

  it("reports it stale and writes nothing", async () => {
    const before = await state();

    const result = await applyBillingEvent(
      activation({
        providerEventId: id("stale"),
        kind: "subscription.reactivated",
        plan: null,
        occurredAt: new Date("2026-10-10T00:00:00.000Z"),
      }),
      prisma,
    );

    expect(result).toEqual({ outcome: "stale" });

    const after = await state();
    expect(after.events).toHaveLength(before.events.length);
    // The newer event said grace; the older one must not undo it.
    expect(after.subscription?.state).toBe("grace");
    expect(after.periods).toHaveLength(before.periods.length);
    expect(after.counters.map((c) => c.used)).toEqual(
      before.counters.map((c) => c.used),
    );
  });
});

/**
 * **What makes `BillingEvent` readable.** The table has no outcome column, so a
 * row can only mean one thing. These two cases hold that meaning against a real
 * database: a refusal and a failure both leave the table as they found it.
 */
describe("an event that is refused", () => {
  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);
  });

  it("rolls its own event row back with the refusal", async () => {
    const before = await state();

    const result = await applyBillingEvent(
      activation({
        providerEventId: id("downgrade"),
        kind: "subscription.plan_changed",
        plan: "lite",
        occurredAt: new Date("2026-10-15T00:00:00.000Z"),
      }),
      prisma,
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "downgrade-not-supported-yet",
    });

    const after = await state();

    expect(
      after.events.find((e) => e.providerEventId === id("downgrade")),
    ).toBeUndefined();
    expect(after.events).toHaveLength(before.events.length);
    expect(after.subscription?.plan).toBe("standard");
    expect(after.counters.map((c) => c.limit)).toEqual(
      before.counters.map((c) => c.limit),
    );
  });
});

describe("a failure after the event row was written", () => {
  /**
   * **The failure is arranged in the fixture, not in the code under test.** A
   * period is planted at the renewal's own start but describing a different
   * window — the disagreement `openPaidPeriod` refuses to paper over. By the
   * time it throws, `BillingEvent.create` has already succeeded, so a row that
   * survived would prove the two were not atomic.
   */
  beforeEach(async () => {
    await resetFixture();
    await applyBillingEvent(activation(), prisma);

    await prisma.usagePeriod.create({
      data: {
        userId: USER_ID,
        periodStart: P2_START,
        periodEnd: new Date("2027-06-01T00:00:00.000Z"),
        planAtStart: "standard",
      },
    });
  });

  it("takes the event row down with it", async () => {
    const before = await state();

    await expect(
      applyBillingEvent(
        activation({
          providerEventId: id("atomic"),
          kind: "subscription.renewed",
          plan: null,
          periodStart: P2_START,
          periodEnd: P2_END,
          occurredAt: P2_START,
        }),
        prisma,
      ),
    ).rejects.toThrow();

    const after = await state();

    expect(
      after.events.find((e) => e.providerEventId === id("atomic")),
    ).toBeUndefined();
    expect(after.events).toHaveLength(before.events.length);
    expect(after.subscription?.plan).toBe(before.subscription?.plan);
    expect(after.periods).toHaveLength(before.periods.length);
    expect(after.counters).toHaveLength(before.counters.length);
  });
});

/**
 * **Once is not evidence about a race.** Whichever transaction reaches the
 * index first varies with connection timing, so a single pass can pass by
 * luck — including the luck of the two never actually overlapping.
 */
describe("the same race, repeated", () => {
  it("holds every iteration", async () => {
    const tally: Record<string, number> = {};
    const problems: string[] = [];

    for (let iteration = 0; iteration < 10; iteration += 1) {
      await resetFixture();
      const settled = await race(2, activation);

      for (const outcome of outcomes(settled)) {
        tally[outcome] = (tally[outcome] ?? 0) + 1;
      }

      const got = outcomes(settled).sort().join("+");
      if (got !== "applied+duplicate") {
        problems.push(`iteration ${iteration}: ${got}`);
      }

      const { events, periods, counters } = await state();
      if (
        events.length !== 1 ||
        periods.length !== 1 ||
        counters.length !== 3 ||
        counters.some((c) => c.used !== 0)
      ) {
        problems.push(
          `iteration ${iteration}: events=${events.length} periods=${periods.length} counters=${counters.length}`,
        );
      }
    }

    expect(problems).toEqual([]);
    expect(tally).toEqual({ applied: 10, duplicate: 10 });
  });
});
