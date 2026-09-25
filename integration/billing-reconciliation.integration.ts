import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import {
  claimReconciliation,
  recordProviderEventReceipt,
} from "@/lib/billing/reconciliation-queue";
import {
  type ObservationOutcome,
  runReconciliation,
} from "@/lib/billing/orchestrate";
import { requireTestDatabaseUrl } from "@/integration/test-database";

/**
 * The reconciliation lease against a real PostgreSQL.
 *
 * **What only a real database can answer.** The unit tests fix what the code
 * does with a fake client; they cannot say what two runners do when they reach
 * the same conditional `UPDATE` at the same moment, because a mock has no rows
 * and no transactions. That question is this file's, and it is the one the
 * whole design rests on: reading provider state while holding the lease is what
 * orders two readings against each other, and nothing else does.
 *
 * **No provider is reachable.** Reading provider state is an injected function
 * throughout, so every case below is about the protocol rather than about
 * anybody's API.
 *
 * Opt-in: see `integration/README.md`.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireTestDatabaseUrl() }),
});

const RUN = `${process.pid}-${Date.now().toString(36)}`;
const USER = `lease-user-${RUN}`;
const OTHER_USER = `lease-user-b-${RUN}`;
const PROVIDER = "test-provider";
const SUB = `sub-a-${RUN}`;
const SUB_B = `sub-b-${RUN}`;

const PERIOD = {
  start: new Date("2026-10-01T00:00:00.000Z"),
  end: new Date("2026-11-01T00:00:00.000Z"),
};

let counter = 0;
const token = () => `tok-${RUN}-${(counter += 1)}`;
const eventId = () => `evt-${RUN}-${(counter += 1)}`;

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    provider: PROVIDER,
    providerEventId: eventId(),
    providerEventType: "provider.said.something",
    providerSubscriptionId: SUB,
    ...overrides,
  };
}

/** A reader that always answers with the same entitled state. */
function entitled(
  overrides: Record<string, unknown> = {},
  termination: "none" | "immediate" | "confirm-twice" = "none",
) {
  return async (): Promise<ObservationOutcome> => ({
    kind: "observed",
    observation: {
      termination,
      snapshot: {
        provider: PROVIDER,
        providerCustomerId: `cus-${RUN}`,
        providerSubscriptionId: SUB,
        userId: USER,
        plan: "standard",
        entitlement: "entitled",
        cancelAtPeriodEnd: false,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        observedAt: new Date("2026-10-15T00:00:00.000Z"),
        ...overrides,
      },
    },
  });
}

async function reset() {
  const users = [USER, OTHER_USER];

  await prisma.$executeRaw`DELETE FROM "BillingEvent" WHERE "userId" = ANY(${users})`;
  await prisma.$executeRaw`DELETE FROM "UsageCounter" WHERE "periodId" IN (SELECT "id" FROM "UsagePeriod" WHERE "userId" = ANY(${users}))`;
  await prisma.$executeRaw`DELETE FROM "UsagePeriod" WHERE "userId" = ANY(${users})`;
  await prisma.$executeRaw`DELETE FROM "Subscription" WHERE "userId" = ANY(${users})`;
  await prisma.$executeRaw`DELETE FROM "ProviderEventReceipt" WHERE "provider" = ${PROVIDER} AND "providerSubscriptionId" = ANY(ARRAY[${SUB}, ${SUB_B}])`;
  await prisma.$executeRaw`DELETE FROM "BillingReconciliation" WHERE "provider" = ${PROVIDER} AND "providerSubscriptionId" = ANY(ARRAY[${SUB}, ${SUB_B}])`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE "id" = ANY(${users})`;

  await prisma.user.createMany({
    data: [
      { id: USER, email: `lease-${RUN}@example.invalid` },
      { id: OTHER_USER, email: `lease-b-${RUN}@example.invalid` },
    ],
  });
}

const queue = () =>
  prisma.billingReconciliation.findUniqueOrThrow({
    where: {
      provider_providerSubscriptionId: {
        provider: PROVIDER,
        providerSubscriptionId: SUB,
      },
    },
  });

const receipts = () =>
  prisma.providerEventReceipt.findMany({
    where: { provider: PROVIDER, providerSubscriptionId: SUB },
    orderBy: { receivedAt: "asc" },
  });

/**
 * Every run in this file goes through the disposable client.
 *
 * **Not a convenience.** `runReconciliation` falls back to the module's own
 * client, which points at the development database; a call site that forgot to
 * pass one would quietly test the wrong server, and the first sign of it would
 * be a connection refused to a port this suite never meant to touch.
 */
function run(input: Omit<Parameters<typeof runReconciliation>[0], "client">) {
  return runReconciliation({ ...input, client: prisma });
}

beforeAll(async () => {
  const missing = await prisma.$queryRaw<{ found: bigint }[]>`
    SELECT count(*) AS found FROM information_schema.tables
    WHERE table_name IN ('ProviderEventReceipt', 'BillingReconciliation')
  `;

  if (Number(missing[0].found) !== 2) {
    throw new Error(
      "The test database is missing the reconciliation tables. Run `pnpm exec prisma migrate deploy` against it first.",
    );
  }
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

beforeEach(reset);

describe("recording what a provider said", () => {
  it("records one notification and marks the subscription as owing a look", async () => {
    const result = await recordProviderEventReceipt(receipt(), prisma);

    expect(result.outcome).toBe("recorded");
    expect((await receipts()).length).toBe(1);
    expect((await queue()).pendingSince).not.toBeNull();
  });

  /**
   * **Delivery idempotency, answered by the database.** Two copies of one
   * notification racing must leave one row — and the loser must come back as an
   * answer rather than as an aborted transaction.
   */
  it("keeps one row when the same delivery arrives twice at once", async () => {
    const input = receipt();

    const settled = await Promise.allSettled([
      recordProviderEventReceipt(input, prisma),
      recordProviderEventReceipt(input, prisma),
    ]);

    for (const s of settled) {
      expect(s.status, s.status === "rejected" ? String(s.reason) : "").toBe(
        "fulfilled",
      );
    }

    const outcomes = settled
      .map((s) => (s as PromiseFulfilledResult<{ outcome: string }>).value.outcome)
      .sort();

    expect(outcomes).toEqual(["duplicate", "recorded"]);
    expect((await receipts()).length).toBe(1);
  });

  it("leaves the pending work a duplicate found already there", async () => {
    const input = receipt();

    await recordProviderEventReceipt(input, prisma);
    const before = (await queue()).pendingSince;

    await recordProviderEventReceipt(input, prisma);

    expect((await queue()).pendingSince).toEqual(before);
  });

  /** The oldest unanswered notification, not the newest. */
  it("keeps pendingSince at the earliest arrival", async () => {
    const early = new Date("2026-10-01T00:00:00.000Z");
    const late = new Date("2026-10-02T00:00:00.000Z");

    await recordProviderEventReceipt(receipt(), prisma, late);
    await recordProviderEventReceipt(receipt(), prisma, early);

    expect((await queue()).pendingSince).toEqual(early);
  });
});

describe("taking the right to reconcile", () => {
  beforeEach(async () => {
    await recordProviderEventReceipt(receipt(), prisma);
  });

  /** Two runners, one lease. Unserialised reads are what this prevents. */
  it("grants it to exactly one of two racing runners", async () => {
    const [a, b] = await Promise.all([
      claimReconciliation(PROVIDER, SUB, token(), prisma),
      claimReconciliation(PROVIDER, SUB, token(), prisma),
    ]);

    expect([a, b].filter((lease) => lease !== null)).toHaveLength(1);
  });

  it("only the owner goes on to read the provider", async () => {
    let reads = 0;
    const read = async (): Promise<ObservationOutcome> => {
      reads += 1;
      return (await entitled()()) as ObservationOutcome;
    };

    const results = await Promise.all([
      run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read }),
      run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read }),
    ]);

    expect(reads).toBe(1);
    expect(results.filter((r) => r.outcome === "not-claimed")).toHaveLength(1);
  });

  it("refuses when nothing is owing", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    expect(await claimReconciliation(PROVIDER, SUB, token(), prisma)).toBeNull();
  });

  it("counts an attempt for each grant and none for a refusal", async () => {
    await claimReconciliation(PROVIDER, SUB, token(), prisma);
    const afterFirst = (await queue()).attempts;

    await claimReconciliation(PROVIDER, SUB, token(), prisma);

    expect(afterFirst).toBe(1);
    expect((await queue()).attempts).toBe(1);
  });

  it("grants it again once the lease has lapsed", async () => {
    const now = new Date("2026-10-15T00:00:00.000Z");
    const later = new Date("2026-10-15T00:05:00.000Z");

    expect(
      await claimReconciliation(PROVIDER, SUB, token(), prisma, now),
    ).not.toBeNull();
    expect(
      await claimReconciliation(PROVIDER, SUB, token(), prisma, later),
    ).not.toBeNull();
    expect((await queue()).attempts).toBe(2);
  });
});

/**
 * The observation boundary.
 *
 * **A notification that arrives after the claim has not been looked at.** The
 * provider was read once, at a moment that cannot be shown to include whatever
 * prompted the later notification — so answering it would be a claim nobody can
 * support.
 */
describe("which notifications a run answers for", () => {
  it("answers the ones present when it claimed, and no others", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const first = token();
    let arrivedDuringRead = false;

    const read = async (): Promise<ObservationOutcome> => {
      if (!arrivedDuringRead) {
        arrivedDuringRead = true;
        await recordProviderEventReceipt(receipt(), prisma);
      }

      return (await entitled()()) as ObservationOutcome;
    };

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: first,
      read,
    });

    const rows = await receipts();

    expect(rows).toHaveLength(2);
    expect(rows[0].resolvedAt).not.toBeNull();
    expect(rows[1].resolvedAt).toBeNull();
    expect(rows[1].reconciliationRunId).not.toBe(first);
  });

  it("leaves the queue owing a look for the one that arrived late", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    let arrived = false;
    const read = async (): Promise<ObservationOutcome> => {
      if (!arrived) {
        arrived = true;
        await recordProviderEventReceipt(receipt(), prisma);
      }
      return (await entitled()()) as ObservationOutcome;
    };

    await run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read });

    const rows = await receipts();

    expect((await queue()).pendingSince).toEqual(rows[1].receivedAt);
  });

  it("a later run answers it", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    let arrived = false;
    const read = async (): Promise<ObservationOutcome> => {
      if (!arrived) {
        arrived = true;
        await recordProviderEventReceipt(receipt(), prisma);
      }
      return (await entitled()()) as ObservationOutcome;
    };

    await run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read });
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    for (const row of await receipts()) {
      expect(row.resolvedAt).not.toBeNull();
    }
    expect((await queue()).pendingSince).toBeNull();
  });
});

describe("a runner that stopped without finishing", () => {
  it("does not strand the notifications it had claimed", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const dead = token();
    const now = new Date("2026-10-15T00:00:00.000Z");
    const later = new Date("2026-10-15T00:05:00.000Z");

    await claimReconciliation(PROVIDER, SUB, dead, prisma, now);
    expect((await receipts())[0].reconciliationRunId).toBe(dead);

    const alive = token();

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: alive,
      read: entitled(),
      clock: () => later,
    });

    const rows = await receipts();

    expect(rows[0].reconciliationRunId).toBe(alive);
    expect(rows[0].resolvedAt).not.toBeNull();
    expect((await queue()).pendingSince).toBeNull();
  });
});

/**
 * Fencing.
 *
 * **A runner whose lease lapsed may still be alive and about to write.** What
 * it holds describes a moment the new owner has already moved past, so it must
 * write nothing at all.
 */
describe("a runner that lost its lease while reading", () => {
  it("writes nothing when it comes back", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const now = new Date("2026-10-15T00:00:00.000Z");
    const later = new Date("2026-10-15T00:05:00.000Z");
    const overrun = token();
    const takeover = token();

    // The overrunning runner claims, then stalls inside its read.
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slowRead = async (): Promise<ObservationOutcome> => {
      await stalled;
      return (await entitled()()) as ObservationOutcome;
    };

    const overrunning = run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: overrun,
      read: slowRead,
      clock: () => now,
    });

    // Long enough for the claim to have committed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const takenOver = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: takeover,
      read: entitled(),
      clock: () => later,
    });

    expect(takenOver.outcome).toBe("reconciled");

    release();
    const fenced = await overrunning;

    expect(fenced).toEqual({ outcome: "fenced-out" });

    // Everything the new owner wrote is still what is there.
    const events = await prisma.billingEvent.findMany({ where: { userId: USER } });

    expect(events.map((e) => e.reconciliationRunId)).toEqual([takeover]);
    expect((await receipts())[0].reconciliationRunId).toBe(takeover);
  });

  it("records no confirmation sighting when it is fenced out", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const now = new Date("2026-10-15T00:00:00.000Z");
    const later = new Date("2026-10-15T00:05:00.000Z");
    const overrun = token();

    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });

    const overrunning = run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: overrun,
      read: async () => {
        await stalled;
        return (await entitled({}, "confirm-twice")()) as ObservationOutcome;
      },
      clock: () => now,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
      clock: () => later,
    });

    release();
    await overrunning;

    expect((await queue()).unpaidFirstSeenRunId).toBeNull();
  });
});

describe("two subscriptions belonging to one account", () => {
  /**
   * **Different leases, one account.** The leases are keyed by subscription, so
   * both runs read at once — correctly, they are different work. What they must
   * not do is race over the one `Subscription` row, which is why the account's
   * own row is locked before the domain reads anything.
   */
  it("binds exactly one of them", async () => {
    await recordProviderEventReceipt(receipt(), prisma);
    await recordProviderEventReceipt(
      receipt({ providerSubscriptionId: SUB_B }),
      prisma,
    );

    const readB = async (): Promise<ObservationOutcome> => ({
      kind: "observed",
      observation: {
        termination: "none",
        snapshot: {
          provider: PROVIDER,
          providerCustomerId: `cus-${RUN}`,
          providerSubscriptionId: SUB_B,
          userId: USER,
          plan: "standard",
          entitlement: "entitled",
          cancelAtPeriodEnd: false,
          periodStart: PERIOD.start,
          periodEnd: PERIOD.end,
          observedAt: new Date("2026-10-15T00:00:00.000Z"),
        },
      },
    });

    const [a, b] = await Promise.all([
      run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read: entitled() }),
      run({ provider: PROVIDER, providerSubscriptionId: SUB_B, token: token(), read: readB }),
    ]);

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: USER },
    });

    expect([SUB, SUB_B]).toContain(subscription.providerSubscriptionId);

    // One of them bound the account; the other found it already taken and
    // refused rather than writing over it.
    const outcomes = [a, b].map((r) =>
      r.outcome === "reconciled" ? r.result.outcome : r.outcome,
    );

    expect(outcomes).toContain("applied");
    expect(outcomes).toContain("provider-domain-mismatch");

    const periods = await prisma.usagePeriod.findMany({ where: { userId: USER } });

    expect(periods).toHaveLength(1);
  });
});

describe("a provider that cannot be read", () => {
  beforeEach(async () => {
    await recordProviderEventReceipt(receipt(), prisma);
  });

  it("leaves the work owing and the lease free", async () => {
    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        throw new TypeError("network is down");
      },
    });

    expect(result).toMatchObject({ outcome: "unavailable" });

    const row = await queue();

    expect(row.pendingSince).not.toBeNull();
    expect(row.leaseToken).toBeNull();
    expect(row.lastFailureReason).toBe("TypeError");
    expect((await receipts())[0].resolvedAt).toBeNull();
  });

  it("writes nothing to the domain", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        throw new Error("boom");
      },
    });

    expect(await prisma.subscription.findUnique({ where: { userId: USER } })).toBeNull();
    expect(await prisma.billingEvent.count({ where: { userId: USER } })).toBe(0);
  });

  it("is resolved by a later run that succeeds", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        throw new Error("boom");
      },
    });

    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    expect(result).toMatchObject({ outcome: "reconciled" });
    expect((await receipts())[0].resolvedAt).not.toBeNull();
    expect((await queue()).lastFailureReason).toBeNull();
  });

  it("records no confirmation sighting when the read fails", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        throw new Error("boom");
      },
    });

    expect((await queue()).unpaidFirstSeenRunId).toBeNull();
  });
});

describe("an ending the provider could still take back", () => {
  beforeEach(async () => {
    await recordProviderEventReceipt(receipt(), prisma);
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });
    await recordProviderEventReceipt(receipt(), prisma);
  });

  it("keeps the account entitled on the first sighting", async () => {
    const first = token();

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: first,
      read: entitled({}, "confirm-twice"),
    });

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: USER },
    });

    expect(subscription.state).toBe("grace");
    expect((await queue()).unpaidFirstSeenRunId).toBe(first);
  });

  it("withdraws it only when a second run agrees", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled({}, "confirm-twice"),
    });

    await recordProviderEventReceipt(receipt(), prisma);
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled({}, "confirm-twice"),
    });

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: USER },
    });

    expect(subscription.state).toBe("inactive");
  });

  it("starts counting again once the provider stops reporting it", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled({}, "confirm-twice"),
    });

    await recordProviderEventReceipt(receipt(), prisma);
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    expect((await queue()).unpaidFirstSeenRunId).toBeNull();

    await recordProviderEventReceipt(receipt(), prisma);
    const third = token();

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: third,
      read: entitled({}, "confirm-twice"),
    });

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: USER },
    });

    // Counted as a first sighting again, so the account keeps its entitlement.
    expect(subscription.state).toBe("grace");
    expect((await queue()).unpaidFirstSeenRunId).toBe(third);
  });

  /** An ending that cannot be undone needs no second opinion. */
  it("withdraws it at once when the ending is final", async () => {
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled({}, "immediate"),
    });

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: USER },
    });

    expect(subscription.state).toBe("inactive");
  });
});

describe("what a run records against the notifications it answered", () => {
  it("names the run that applied the transitions", async () => {
    await recordProviderEventReceipt(receipt(), prisma);
    const runId = token();

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: runId,
      read: entitled(),
    });

    const events = await prisma.billingEvent.findMany({ where: { userId: USER } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reconciliationRunId: runId,
      providerEventId: null,
      occurredAt: null,
    });
    expect(events[0].observedAt).not.toBeNull();
  });

  /** Several answered by one reading own none of it individually. */
  it("marks several answered together as coalesced", async () => {
    await recordProviderEventReceipt(receipt(), prisma);
    await recordProviderEventReceipt(receipt(), prisma);
    await recordProviderEventReceipt(receipt(), prisma);

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    const rows = await receipts();

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.outcome).toBe("coalesced");
      expect(row.userId).toBe(USER);
    }
  });

  it("marks a single one applied", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    expect((await receipts())[0].outcome).toBe("applied");
  });

  /** A quiet agreement is still an answer, and still a successful sync. */
  it("resolves them and records the sync when nothing differed", async () => {
    await recordProviderEventReceipt(receipt(), prisma);
    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    await recordProviderEventReceipt(receipt(), prisma);
    const second = token();

    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: second,
      read: entitled(),
    });

    expect(result).toMatchObject({
      outcome: "reconciled",
      result: { outcome: "already-converged" },
    });

    const rows = await receipts();

    expect(rows[1].outcome).toBe("already-converged");
    expect(await prisma.billingEvent.count({ where: { userId: USER } })).toBe(1);

    const subscription = await prisma.subscription.findUniqueOrThrow({
      where: { userId: USER },
    });

    expect(subscription.providerSyncedAt).not.toBeNull();
  });
});

/**
 * Atomicity.
 *
 * **The domain and the answering commit together or neither does.** A run whose
 * transaction failed after writing must leave the notifications owing, or the
 * work is lost with no record that it was ever attempted.
 */
describe("a run whose transaction fails part-way", () => {
  it("rolls back the domain and the answering together", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    // A period at the same start describing a different window is the
    // disagreement `openPaidPeriod` refuses to paper over.
    await prisma.usagePeriod.create({
      data: {
        userId: USER,
        periodStart: PERIOD.start,
        periodEnd: new Date("2027-06-01T00:00:00.000Z"),
        planAtStart: "standard",
      },
    });

    await expect(
      run({
        provider: PROVIDER,
        providerSubscriptionId: SUB,
        token: token(),
        read: entitled(),
      }),
    ).rejects.toThrow();

    expect(await prisma.subscription.findUnique({ where: { userId: USER } })).toBeNull();
    expect(await prisma.billingEvent.count({ where: { userId: USER } })).toBe(0);
    expect((await receipts())[0].resolvedAt).toBeNull();
    expect((await queue()).pendingSince).not.toBeNull();
  });
});

describe("the same race, repeated", () => {
  it("grants one lease every time", async () => {
    const problems: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      await reset();
      await recordProviderEventReceipt(receipt(), prisma);

      let reads = 0;
      const read = async (): Promise<ObservationOutcome> => {
        reads += 1;
        return (await entitled()()) as ObservationOutcome;
      };

      const results = await Promise.all([
        run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read }),
        run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read }),
        run({ provider: PROVIDER, providerSubscriptionId: SUB, token: token(), read }),
      ]);

      const claimed = results.filter((r) => r.outcome !== "not-claimed");

      if (reads !== 1) {
        problems.push(`iteration ${i}: ${reads} reads`);
      }
      if (claimed.length !== 1) {
        problems.push(`iteration ${i}: ${claimed.length} runners acted`);
      }

      const periods = await prisma.usagePeriod.findMany({ where: { userId: USER } });
      const events = await prisma.billingEvent.findMany({ where: { userId: USER } });

      if (periods.length !== 1 || events.length !== 1) {
        problems.push(
          `iteration ${i}: periods=${periods.length} events=${events.length}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });
});

/**
 * A lease that ran out while nobody was waiting for it.
 *
 * **Distinct from being taken over, and the harder of the two.** When a
 * competitor arrives it changes the token, and any check on the token catches
 * the overrunning run. When nobody arrives, the token in the row is still the
 * slow run's own — so treating "my token is still there" as ownership would let
 * it apply a reading from minutes ago, and the expiry would only ever have
 * meant anything in the presence of a competitor.
 */
describe("a lease that ran out before anyone took over", () => {
  it("cannot apply what it read", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const claimedAt = new Date("2026-10-15T00:00:00.000Z");
    const afterExpiry = new Date("2026-10-15T00:02:00.000Z");
    let reads = 0;

    // Inside its lease when it claims; past the deadline by the time it writes.
    const clock = () => (reads === 0 ? claimedAt : afterExpiry);

    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        reads += 1;
        return (await entitled()()) as ObservationOutcome;
      },
      clock,
    });

    expect(result).toEqual({ outcome: "fenced-out" });
  });

  it("leaves the account and its notification exactly as they were", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const claimedAt = new Date("2026-10-15T00:00:00.000Z");
    const afterExpiry = new Date("2026-10-15T00:02:00.000Z");
    let reads = 0;

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        reads += 1;
        return (await entitled({}, "confirm-twice")()) as ObservationOutcome;
      },
      clock: () => (reads === 0 ? claimedAt : afterExpiry),
    });

    expect(
      await prisma.subscription.findUnique({ where: { userId: USER } }),
    ).toBeNull();
    expect(await prisma.usagePeriod.count({ where: { userId: USER } })).toBe(0);
    expect(await prisma.billingEvent.count({ where: { userId: USER } })).toBe(0);

    const row = await queue();

    expect(row.unpaidFirstSeenRunId).toBeNull();
    expect(row.pendingSince).not.toBeNull();
    expect((await receipts())[0].resolvedAt).toBeNull();
  });

  /** The work is still owing, so a later runner picks it up and finishes it. */
  it("leaves the work for whoever comes next", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const claimedAt = new Date("2026-10-15T00:00:00.000Z");
    const afterExpiry = new Date("2026-10-15T00:02:00.000Z");
    let reads = 0;

    await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        reads += 1;
        return (await entitled()()) as ObservationOutcome;
      },
      clock: () => (reads === 0 ? claimedAt : afterExpiry),
    });

    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
      clock: () => new Date("2026-10-15T00:03:00.000Z"),
    });

    expect(result).toMatchObject({ outcome: "reconciled" });
    expect((await receipts())[0].resolvedAt).not.toBeNull();
    expect((await queue()).pendingSince).toBeNull();
  });

  /** A run still inside its lease is not affected by the new condition. */
  it("does not disturb a run that is still within its lease", async () => {
    await recordProviderEventReceipt(receipt(), prisma);

    const claimedAt = new Date("2026-10-15T00:00:00.000Z");
    const stillValid = new Date("2026-10-15T00:00:30.000Z");
    let reads = 0;

    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: async () => {
        reads += 1;
        return (await entitled()()) as ObservationOutcome;
      },
      clock: () => (reads === 0 ? claimedAt : stillValid),
    });

    expect(result).toMatchObject({ outcome: "reconciled" });
  });
});

/**
 * An expired runner and a fresh claimant, at the same moment.
 *
 * **Whichever order the two reach the row, the stale reading must not land.**
 * Either the newcomer changes the token first and the old run fails on that, or
 * the old run checks first and fails on its own deadline — and then the
 * newcomer is free to take the row.
 */
describe("an expired runner racing a takeover", () => {
  it("never lets the expired one apply, over ten attempts", async () => {
    const problems: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      await reset();
      await recordProviderEventReceipt(receipt(), prisma);

      const claimedAt = new Date("2026-10-15T00:00:00.000Z");
      const afterExpiry = new Date("2026-10-15T00:02:00.000Z");
      const stale = token();
      let staleReads = 0;

      let release!: () => void;
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });

      const overrunning = run({
        provider: PROVIDER,
        providerSubscriptionId: SUB,
        token: stale,
        read: async () => {
          staleReads += 1;
          await stalled;
          return (await entitled()()) as ObservationOutcome;
        },
        clock: () => (staleReads === 0 ? claimedAt : afterExpiry),
      });

      // Long enough for the stale run's claim to have committed.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const fresh = token();

      // Both reach the row at once: one releases the stalled run as the other
      // tries to take over.
      const [staleResult, freshResult] = await Promise.all([
        (async () => {
          release();
          return overrunning;
        })(),
        run({
          provider: PROVIDER,
          providerSubscriptionId: SUB,
          token: fresh,
          read: entitled(),
          clock: () => afterExpiry,
        }),
      ]);

      if (staleResult.outcome !== "fenced-out") {
        problems.push(`iteration ${i}: stale run returned ${staleResult.outcome}`);
      }

      const events = await prisma.billingEvent.findMany({
        where: { userId: USER },
      });

      if (events.some((event) => event.reconciliationRunId === stale)) {
        problems.push(`iteration ${i}: stale token wrote a billing event`);
      }

      if (events.length > 1) {
        problems.push(`iteration ${i}: ${events.length} events`);
      }

      const periods = await prisma.usagePeriod.count({ where: { userId: USER } });

      if (periods > 1) {
        problems.push(`iteration ${i}: ${periods} periods`);
      }

      // Whoever was authoritative, the work must not be left half-done.
      if (freshResult.outcome === "reconciled" && events.length !== 1) {
        problems.push(`iteration ${i}: fresh run applied but ${events.length} events`);
      }
    }

    expect(problems).toEqual([]);
  });
});

/**
 * A delivery that outlived the process that recorded it.
 *
 * **The reason the webhook writes before it answers.** Stripe stops retrying
 * once it sees a `2xx`, so if the record did not survive the response there
 * would be nothing left to ask again — and the subscription would simply never
 * be reconciled. What this holds is the half that can be proven here: once the
 * record is committed, a later sweep finds it without any help from the process
 * that took the delivery.
 */
describe("work recorded by one process and finished by another", () => {
  it("survives the recording process disappearing", async () => {
    // All the webhook does: record the delivery, commit, answer.
    const recorded = await recordProviderEventReceipt(receipt(), prisma);

    expect(recorded.outcome).toBe("recorded");

    // Nothing else of that request exists any more — no lease, no in-flight
    // work, no scheduled promise. Only what the database kept.
    expect((await queue()).pendingSince).not.toBeNull();
    expect((await receipts())[0].resolvedAt).toBeNull();

    // A sweep that knows nothing about it finds the work and finishes it.
    const result = await run({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      token: token(),
      read: entitled(),
    });

    expect(result).toMatchObject({ outcome: "reconciled" });
    expect((await receipts())[0].resolvedAt).not.toBeNull();
    expect((await queue()).pendingSince).toBeNull();
    expect(
      await prisma.subscription.findUnique({ where: { userId: USER } }),
    ).not.toBeNull();
  });
});
