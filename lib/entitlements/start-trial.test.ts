import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When a trial starts, when it does not, and what it writes down.
 *
 * **These hold a fake transaction client and nothing else.** What the database
 * is asked, in what order, and with what — that is what a trial's correctness
 * consists of at this level, and it can be fixed without a server.
 *
 * **What cannot be tested here, said plainly.** That two concurrent first
 * activations are serialized is a property of the account lock
 * `claimWorkerCreation` and `claimWorkerActivation` take, which is PostgreSQL's
 * behaviour and not this module's — see `lib/worker-quota.ts`, whose own tests
 * say the same thing about the same lock. What is fixed below is everything
 * that would quietly disable it: that the count is read before anything is
 * written, that the write is a `create` rather than an `upsert`, and that a
 * second activation is answered from the count rather than from a trial column.
 *
 * **Nothing here enforces anything**, and no test asserts that it does. An
 * account whose trial ended still has every worker it had, and they still run.
 */

vi.mock("@/lib/prisma", () => ({ prisma: { subscription: { findUnique: vi.fn() } } }));

const { startTrialOnFirstWorkerActivation } = await import(
  "@/lib/entitlements/start-trial"
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-22T10:00:00.000Z");
const USER = "google-sub-1";

const routineCount = vi.fn();
const subscriptionFindUnique = vi.fn();
const subscriptionCreate = vi.fn();
const usagePeriodCreate = vi.fn();

const clientStub = {
  routine: { count: routineCount },
  subscription: { findUnique: subscriptionFindUnique, create: subscriptionCreate },
  usagePeriod: { create: usagePeriodCreate },
};

/** Stands in for a transaction client: the three tables a trial start touches. */
const client = clientStub as unknown as Parameters<
  typeof startTrialOnFirstWorkerActivation
>[0];

/** A stored entitlement, in the shape the eligibility rule reads. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    plan: "standard",
    state: "active",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    notificationWorkerId: null,
    source: "stripe",
    expiresAt: null,
    ...overrides,
  };
}

/** The five carried-over accounts, exactly as Production holds them. */
const ADMIN_BETA = record({
  plan: "beta",
  state: "active",
  source: "admin",
  expiresAt: new Date("2026-12-31T23:59:59.000Z"),
});

/** The data a `create` was called with, for reading fields off. */
function createdSubscription() {
  return subscriptionCreate.mock.calls[0][0].data;
}

function createdPeriod() {
  return usagePeriodCreate.mock.calls[0][0].data;
}

/** No worker is active, and no entitlement exists: the ordinary first hire. */
function eligibleAndFirst() {
  routineCount.mockResolvedValue(0);
  subscriptionFindUnique.mockResolvedValue(null);
}

beforeEach(() => {
  routineCount.mockReset();
  subscriptionFindUnique.mockReset();
  subscriptionCreate.mockReset().mockResolvedValue({ id: "sub" });
  usagePeriodCreate.mockReset().mockResolvedValue({ id: "period" });
});

describe("the first worker an account activates", () => {
  it("starts a trial", async () => {
    eligibleAndFirst();

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({
      outcome: "started",
      startedAt: NOW,
      endsAt: new Date(NOW.getTime() + 14 * DAY_MS),
    });
  });

  /**
   * **The count, not a column.** "First" means no worker of this account is
   * active, and it is read under the lock the caller already holds — see the
   * file docblock.
   */
  it("asks how many workers are active before it writes anything", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(routineCount).toHaveBeenCalledWith({
      where: { userId: USER, status: "active" },
    });
    expect(routineCount.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptionCreate.mock.invocationCallOrder[0],
    );
  });

  it("writes a trial subscription for this account", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(subscriptionCreate).toHaveBeenCalledTimes(1);
    expect(createdSubscription()).toMatchObject({
      userId: USER,
      plan: "trial",
      state: "trialing",
      source: "trial",
    });
  });

  /**
   * **`source: "trial"` is the schema's own word**, not a new one. The column
   * is documented as "trial", "admin", or a provider's name; a fourth value for
   * the case the vocabulary was written for would leave it meaning two things.
   */
  it("uses the source the column already documents", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdSubscription().source).toBe("trial");
    expect(createdSubscription().source).not.toBe("system");
  });

  it("ends the trial exactly fourteen days after it started", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const { trialStartedAt, trialEndsAt } = createdSubscription();

    expect(trialStartedAt).toEqual(NOW);
    expect(trialEndsAt.getTime() - trialStartedAt.getTime()).toBe(14 * DAY_MS);
  });

  /**
   * **Consumed at the start, not at the end.** What is spent is the offer, and
   * it is spent the moment it is taken up. A column filled in when the
   * fortnight ran out would need something to run to fill it in, and would be
   * wrong until it did.
   */
  it("marks the trial consumed at the instant it started", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const { trialStartedAt, trialConsumedAt } = createdSubscription();

    expect(trialConsumedAt).toEqual(trialStartedAt);
  });

  /** Nobody bought anything, so there is no provider and no billing cycle. */
  it("writes no provider or billing fields", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdSubscription()).toMatchObject({
      expiresAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      providerCustomerId: null,
      providerSubscriptionId: null,
      providerUpdatedAt: null,
    });
  });

  /**
   * **`create`, never `upsert`.** An upsert would accept a row the account
   * already had and write today's dates over it, which is the restart every
   * rule in this module exists to prevent.
   */
  it("creates the entitlement rather than upserting over one", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(clientStub.subscription).not.toHaveProperty("upsert");
    expect(subscriptionCreate).toHaveBeenCalledTimes(1);
  });
});

describe("the period a trial is counted over", () => {
  /**
   * **The trial's own fortnight, not the calendar month.** A trial begun on the
   * twenty-eighth would otherwise have its allowance reset three days in.
   */
  it("covers exactly the trial", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usagePeriodCreate).toHaveBeenCalledTimes(1);
    expect(createdPeriod()).toMatchObject({
      userId: USER,
      periodStart: NOW,
      planAtStart: "trial",
    });
    expect(createdPeriod().periodEnd.getTime() - NOW.getTime()).toBe(
      14 * DAY_MS,
    );
  });

  it("matches the subscription's own trial dates", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdPeriod().periodStart).toEqual(
      createdSubscription().trialStartedAt,
    );
    expect(createdPeriod().periodEnd).toEqual(
      createdSubscription().trialEndsAt,
    );
  });

  /**
   * **Stamped with its own start.** `partialPeriod` is derived by comparing
   * `createdAt` against `periodStart`, so a row written a few milliseconds
   * later would report a period it covers entirely as covering part of one.
   */
  it("is stamped as created at the period's own first instant", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdPeriod().createdAt).toEqual(createdPeriod().periodStart);
  });

  it("opens exactly three counters, one per allowance", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const counters = createdPeriod().counters.create;

    expect(counters).toHaveLength(3);
    expect(counters.map((counter: { kind: string }) => counter.kind).sort()).toEqual(
      ["aiProcessing", "discovery", "manualRun"],
    );
  });

  it("copies the trial plan's numbers onto them", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const counters = createdPeriod().counters.create;
    const byKind = new Map(
      counters.map((counter: { kind: string }) => [counter.kind, counter]),
    );

    expect(byKind.get("aiProcessing")).toEqual({
      kind: "aiProcessing",
      used: 0,
      limit: 50,
    });
    expect(byKind.get("manualRun")).toEqual({
      kind: "manualRun",
      used: 0,
      limit: 20,
    });
    expect(byKind.get("discovery")).toEqual({
      kind: "discovery",
      used: 0,
      limit: 14,
    });
  });

  /**
   * **How many workers are active is live state, not consumption.** A period
   * does not accumulate active workers — it has however many there are at the
   * moment somebody asks — so a counter for it would be a number nothing could
   * spend and nothing could reset.
   */
  it("opens no counter for active workers", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const kinds = createdPeriod().counters.create.map(
      (counter: { kind: string }) => counter.kind,
    );

    expect(kinds).not.toContain("activeWorker");
    expect(kinds).not.toContain("activeWorkers");
  });
});

describe("activations that must not start a trial", () => {
  /** A worker is already active, so this is not the first one. */
  it("refuses when the account already has an active worker", async () => {
    routineCount.mockResolvedValue(1);
    subscriptionFindUnique.mockResolvedValue(null);

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "not-first-activation" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /**
   * **Not even read.** Most activations are not the first, and those should not
   * cost a read of an entitlement to find that out.
   */
  it("does not read an entitlement when it is not the first activation", async () => {
    routineCount.mockResolvedValue(3);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(subscriptionFindUnique).not.toHaveBeenCalled();
  });

  /**
   * §14: pausing every worker and switching one back on does not restart the
   * clock. The count is zero again, and the trial row is what answers.
   */
  it("refuses when a trial is already running, however many workers are paused", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(
      record({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-09-15T00:00:00.000Z"),
        trialEndsAt: new Date("2026-09-29T00:00:00.000Z"),
        trialConsumedAt: new Date("2026-09-15T00:00:00.000Z"),
      }),
    );

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "already-trialing" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /**
   * **A trial whose fortnight has run out is still that account's trial.** The
   * row says `trialing` and the clock says it is over; what the clock says is
   * worked out rather than stored, and an activation may not wind it back.
   */
  it("refuses when the trial has already run out", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(
      record({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
        trialEndsAt: new Date("2026-08-15T00:00:00.000Z"),
        trialConsumedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    );

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "already-trialing" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
  });

  /** §4: the offer is spent, whatever became of the fortnight. */
  it("refuses an account that has had its trial and moved on", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(
      record({ trialConsumedAt: new Date("2026-05-01T00:00:00.000Z") }),
    );

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "not-eligible" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
  });

  it("refuses an account a paid plan already entitles", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(record());

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "not-eligible" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
  });
});

/**
 * The five carried-over accounts, and the activation that must leave them
 * exactly as it found them.
 *
 * **Not a special case in the code.** The refusal comes from the same rule that
 * refuses them a trial anywhere else — see `isAdminGrantedBeta`. What these fix
 * is that the rule is actually reached from here, and that nothing is written
 * when it is.
 */
describe("an account that was given the beta allowance", () => {
  beforeEach(() => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(ADMIN_BETA);
  });

  it("starts no trial when it activates a worker", async () => {
    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "not-eligible" });
  });

  it("has nothing written about it at all", async () => {
    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /** After its grant expires, the answer is the same one. */
  it("starts no trial after the grant has expired either", async () => {
    const afterExpiry = new Date("2027-01-01T00:00:00.000Z");

    const result = await startTrialOnFirstWorkerActivation(
      client,
      USER,
      afterExpiry,
    );

    expect(result).toEqual({ outcome: "not-eligible" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
  });
});

/**
 * **What a trial start must never reach.** A transaction holding a lock on an
 * account has no business waiting on a network, and a trial is a fact about a
 * row rather than an event anybody needs to be told about yet.
 */
describe("what starting a trial does not do", () => {
  it("touches nothing but the three tables it writes", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(Object.keys(clientStub).sort()).toEqual([
      "routine",
      "subscription",
      "usagePeriod",
    ]);
  });

  /**
   * A client offering only these three tables is enough to run it, which is
   * the assertion: anything calling a provider, sending mail or writing a
   * notification would have failed on this stub rather than passed.
   */
  it("calls no provider, sends no mail and writes no notification", async () => {
    eligibleAndFirst();

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).resolves.toMatchObject({ outcome: "started" });
  });
});

/**
 * Two first activations arriving together, and the transaction that fails.
 *
 * **The serialization itself is PostgreSQL's**, taken by the account lock the
 * caller already holds — see the file docblock, and `lib/worker-quota.test.ts`,
 * which says the same thing about the same lock. What is fixed here is the two
 * things that would still have to be true if the lock were ever lost: that the
 * second caller reads the first one's worker, and that a refused write is not
 * reported as a trial.
 */
describe("when two activations arrive at once", () => {
  /** Serialized by the lock, the second transaction counts the first's worker. */
  it("answers the second one from the count, without writing", async () => {
    routineCount.mockResolvedValue(1);

    const second = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(second).toEqual({ outcome: "not-first-activation" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
  });

  /**
   * **The constraint is the second guarantee.** `Subscription.userId` is
   * unique, so a write that somehow raced past the lock is refused by the
   * database rather than producing a second trial. The refusal is left to
   * propagate: it aborts the caller's transaction, which is what rolls the
   * activation back.
   */
  it("lets a refused entitlement write roll the activation back", async () => {
    eligibleAndFirst();
    const conflict = Object.assign(new Error("unique constraint"), {
      code: "P2002",
    });
    subscriptionCreate.mockRejectedValue(conflict);

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).rejects.toThrow(conflict);

    // Not caught and not reported as a trial: the caller's transaction is what
    // decides, and it has already been told.
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /**
   * §7: a trial and the period it is counted over are one or the other, never
   * half. A period that could not be written takes the entitlement with it,
   * because both are in the caller's transaction.
   */
  it("reports no trial when the period cannot be written", async () => {
    eligibleAndFirst();
    usagePeriodCreate.mockRejectedValue(new Error("rolled back"));

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).rejects.toThrow("rolled back");
  });

  /**
   * **A trial period collides with an observation month only if it begins at
   * exactly one.** `@@unique([userId, periodStart])` covers both, so an account
   * that had been observed this month and then activated its first worker at
   * precisely midnight on the first would have its activation refused rather
   * than silently counted against a beta month's numbers. The refusal is the
   * correct half of that trade; see the phase report.
   */
  it("refuses rather than reusing somebody else's period on a collision", async () => {
    eligibleAndFirst();
    usagePeriodCreate.mockRejectedValue(
      Object.assign(new Error("unique constraint"), { code: "P2002" }),
    );

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
