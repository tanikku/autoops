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
const usageCounterAggregate = vi.fn();

/**
 * **Four tables, and `providerUsageEvent` is deliberately not one of them.**
 * A client that cannot reach the cost telemetry is how these fix that carry-in
 * is read from the product's own counters — anything querying the other table
 * would fail here rather than pass.
 */
const clientStub = {
  routine: { count: routineCount },
  subscription: { findUnique: subscriptionFindUnique, create: subscriptionCreate },
  usagePeriod: { create: usagePeriodCreate },
  usageCounter: { aggregate: usageCounterAggregate },
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

/** What the account has already spent on AI, as the aggregate reports it. */
function alreadyUsedAi(used: number | null) {
  usageCounterAggregate.mockResolvedValue({ _sum: { used } });
}

/** One counter from the period that was created, by kind. */
function createdCounter(kind: string) {
  return createdPeriod().counters.create.find(
    (counter: { kind: string }) => counter.kind === kind,
  );
}

beforeEach(() => {
  routineCount.mockReset();
  subscriptionFindUnique.mockReset();
  subscriptionCreate.mockReset().mockResolvedValue({ id: "sub" });
  usagePeriodCreate.mockReset().mockResolvedValue({ id: "period" });
  // Nothing observed yet, which is what an account that has done nothing looks
  // like: no counter rows, so no sum.
  usageCounterAggregate.mockReset().mockResolvedValue({ _sum: { used: null } });
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
  /**
   * **Four tables: three written, one read.** The counters are read to find out
   * what the account has already spent; everything else here is a write.
   */
  it("touches nothing but the four tables it needs", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(Object.keys(clientStub).sort()).toEqual([
      "routine",
      "subscription",
      "usageCounter",
      "usagePeriod",
    ]);
  });

  /**
   * **The cost telemetry is not among them, and that is the decision.**
   * `ProviderUsageEvent` says what a call to a model cost; an allowance is
   * denominated in product units, and the two move together today only because
   * of where the recording happens to sit. A client with no such table is how
   * that stays true: reaching for it would fail here rather than pass.
   */
  it("never reaches for the provider cost telemetry", async () => {
    eligibleAndFirst();

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(clientStub).not.toHaveProperty("providerUsageEvent");
    expect(usageCounterAggregate).toHaveBeenCalledTimes(1);
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


/**
 * The fourteenth day, read three ways, and the same answer from all of them.
 *
 * **One trial, described by three modules that must agree.** The entitlement
 * says it is over, the counting stops, and the screen still shows what it used
 * — and a reader who only saw one of those could reasonably expect the other
 * two to say something else. These hold them side by side.
 */
describe("a trial at the instant it ends", () => {
  const STARTED = new Date("2026-09-01T00:00:00.000Z");
  const ENDS = new Date("2026-09-15T00:00:00.000Z");

  const endedTrial = record({
    plan: "trial",
    state: "trialing",
    source: "trial",
    trialStartedAt: STARTED,
    trialEndsAt: ENDS,
    trialConsumedAt: STARTED,
  });

  it("is worked out as expired rather than written down as expired", async () => {
    const { computeEntitlement } = await import("@/lib/entitlements/index");

    const entitlement = computeEntitlement(endedTrial, ENDS);

    expect(entitlement.state).toBe("trial_expired");
    expect(entitlement.entitled).toBe(false);
    // The row still says `trialing`: nothing ran to change it, and nothing had
    // to. See `resolveState`.
    expect(endedTrial.state).toBe("trialing");
  });

  it("still reports what a trial allows, for a screen to explain with", async () => {
    const { computeEntitlement } = await import("@/lib/entitlements/index");

    expect(computeEntitlement(endedTrial, ENDS).limits).toMatchObject({
      aiProcessingLimit: 50,
      manualRunLimit: 20,
      discoveryLimit: 14,
    });
  });

  /** An account whose fortnight is over is not offered a second one. */
  it("cannot start another trial", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(endedTrial);

    expect(
      await startTrialOnFirstWorkerActivation(client, USER, ENDS),
    ).toEqual({ outcome: "already-trialing" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
  });

  /**
   * **And nothing stops.** An expired trial refuses a second trial and refuses
   * nothing else: no scheduler, dispatcher or run reads any of this, so the
   * account's workers run tomorrow exactly as they ran yesterday. Enforcement
   * is a later phase, and saying so in a test is how it stays one.
   */
  it("is enforced by nothing", async () => {
    const entitlements = await import("@/lib/entitlements/index");
    const startTrial = await import("@/lib/entitlements/start-trial");

    expect(Object.keys(entitlements).sort()).toEqual([
      "NO_ENTITLEMENT",
      "computeEntitlement",
      "getEffectiveEntitlement",
    ]);
    expect(Object.keys(startTrial)).toEqual([
      "startTrialOnFirstWorkerActivation",
    ]);
  });
});


/**
 * What the account already spent, arriving with the trial.
 *
 * **A trial is an offer to try Koqentra, not fifty more of it.** Drafting a
 * worker with AI, and both Creator features, all reach a model without any
 * worker being active — so an account can spend a good deal of AI processing
 * before it ever activates anything. Starting the fortnight at zero would make
 * that a way to have the allowance twice, and the second time would be free.
 *
 * **The carry-in is read from the product's own counters.** What is being
 * carried is units of AI processing, which is what `UsageCounter` counts;
 * `ProviderUsageEvent` counts what calls to a model cost, which is a different
 * question that happens to have the same answer today.
 */
describe("what an account has already spent on AI", () => {
  /** The ordinary case: somebody who has done nothing observable yet. */
  it("starts a trial at nothing when nothing was used", async () => {
    eligibleAndFirst();
    alreadyUsedAi(null);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdCounter("aiProcessing")).toEqual({
      kind: "aiProcessing",
      used: 0,
      limit: 50,
    });
  });

  /** A sum of zero is the same answer as no rows at all. */
  it("starts at nothing when the counters add up to nothing", async () => {
    eligibleAndFirst();
    alreadyUsedAi(0);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdCounter("aiProcessing").used).toBe(0);
  });

  it.each([
    ["a few drafts", 3],
    ["exactly the whole allowance", 50],
    ["one more than the allowance", 51],
    ["twice the allowance", 100],
    ["the sixty-three from the investigation", 63],
  ])("carries %s into the trial", async (_label, used) => {
    eligibleAndFirst();
    alreadyUsedAi(used);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdCounter("aiProcessing")).toEqual({
      kind: "aiProcessing",
      used,
      limit: 50,
    });
  });

  /**
   * **Nothing is clamped, and the limit does not move.** A counter reading
   * `63 / 50` is a true statement about an account that used sixty-three; a
   * clamp would lose the thirteen, and raising the limit would say a trial
   * allows more than it does. Over-limit is a state the counters can already
   * hold — see `usageStatusFor` — so there is nothing to invent.
   */
  it("neither clamps the number nor moves the limit", async () => {
    eligibleAndFirst();
    alreadyUsedAi(63);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const counter = createdCounter("aiProcessing");

    expect(counter.used).toBe(63);
    expect(counter.used).not.toBe(50);
    expect(counter.limit).toBe(50);
  });

  /** An account already past the allowance still gets its fourteen days. */
  it("starts the trial anyway when more was used than a trial allows", async () => {
    eligibleAndFirst();
    alreadyUsedAi(100);

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({
      outcome: "started",
      startedAt: NOW,
      endsAt: new Date(NOW.getTime() + 14 * DAY_MS),
    });
    expect(subscriptionCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * **Every period the account has, not the current month.** Observation falls
   * back to the calendar month, so somebody who drafted in September and
   * activated in October has two rows — and reading one would hand the other
   * back to them unspent. The database adds them up; nothing is loaded to be
   * summed here.
   */
  it("sums across every period the account has, through the account", async () => {
    eligibleAndFirst();
    alreadyUsedAi(5);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usageCounterAggregate).toHaveBeenCalledWith({
      _sum: { used: true },
      where: { kind: "aiProcessing", period: { userId: USER } },
    });
    expect(createdCounter("aiProcessing").used).toBe(5);
  });

  /**
   * **Read before the trial's own period exists**, which is what makes "every
   * counter this account has" mean "everything from before the trial". Asking
   * afterwards would include the row being created.
   */
  it("reads the total before it creates anything", async () => {
    eligibleAndFirst();
    alreadyUsedAi(4);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usageCounterAggregate.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptionCreate.mock.invocationCallOrder[0],
    );
    expect(usageCounterAggregate.mock.invocationCallOrder[0]).toBeLessThan(
      usagePeriodCreate.mock.invocationCallOrder[0],
    );
  });

  /**
   * **Only AI processing arrives already spent.** The other two allowances are
   * things an active worker does, and an account with no active worker has done
   * neither — so a number here would be invented rather than carried.
   */
  it("starts the other two allowances at nothing", async () => {
    eligibleAndFirst();
    alreadyUsedAi(40);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(createdCounter("manualRun")).toEqual({
      kind: "manualRun",
      used: 0,
      limit: 20,
    });
    expect(createdCounter("discovery")).toEqual({
      kind: "discovery",
      used: 0,
      limit: 14,
    });
  });

  it("still opens exactly three counters, and none for active workers", async () => {
    eligibleAndFirst();
    alreadyUsedAi(12);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    const counters = createdPeriod().counters.create;

    expect(counters).toHaveLength(3);
    expect(
      counters.map((counter: { kind: string }) => counter.kind).sort(),
    ).toEqual(["aiProcessing", "discovery", "manualRun"]);
  });

  /**
   * **Creator's AI is in the total without being named anywhere.** Creator
   * analysis and Creator memory record product AI processing through the same
   * path as every other feature, so they are already in the sum — there is no
   * Creator branch to get wrong, and this test exists to fix that there is not
   * one. The number below is deliberately made of both kinds of work.
   */
  it("includes Creator's AI through the same total, with no branch for it", async () => {
    eligibleAndFirst();
    // Three drafts and four Creator analyses, indistinguishable by the time
    // they reach a counter — which is the point.
    alreadyUsedAi(7);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usageCounterAggregate).toHaveBeenCalledTimes(1);
    expect(usageCounterAggregate.mock.calls[0][0].where).toEqual({
      kind: "aiProcessing",
      period: { userId: USER },
    });
    expect(createdCounter("aiProcessing").used).toBe(7);
  });
});

/**
 * When the total cannot be read.
 *
 * **The activation goes down with it.** A trial that began at zero because a
 * query failed would hand back an allowance the account had already spent, and
 * nothing afterwards could tell that trial from an honest one. Failing is the
 * only answer that cannot quietly give something away.
 */
describe("when the carry-in cannot be read", () => {
  it("lets the failure roll the activation back", async () => {
    eligibleAndFirst();
    usageCounterAggregate.mockRejectedValue(new Error("aggregate failed"));

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).rejects.toThrow("aggregate failed");
  });

  it("writes no trial and no period", async () => {
    eligibleAndFirst();
    usageCounterAggregate.mockRejectedValue(new Error("aggregate failed"));

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).rejects.toThrow();

    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /** Never absorbed into a zero, which is the specific mistake being refused. */
  it("does not start a trial at nothing instead", async () => {
    eligibleAndFirst();
    usageCounterAggregate.mockRejectedValue(new Error("aggregate failed"));

    await expect(
      startTrialOnFirstWorkerActivation(client, USER, NOW),
    ).rejects.toThrow();

    expect(subscriptionCreate).not.toHaveBeenCalled();
  });
});

/**
 * The activations that must not read the total at all.
 *
 * **Short-circuited before the aggregate, not after it.** An account that is
 * not starting a trial has no carry-in to work out, and a query run anyway
 * would be work done to throw away — and, for the carried-over cohort, a
 * question asked about an account this code has no business measuring.
 */
describe("activations that compute no carry-in", () => {
  it("asks nothing when a worker is already active", async () => {
    routineCount.mockResolvedValue(1);
    subscriptionFindUnique.mockResolvedValue(null);

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usageCounterAggregate).not.toHaveBeenCalled();
  });

  it("asks nothing for an account that was given the beta allowance", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(ADMIN_BETA);

    const result = await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(result).toEqual({ outcome: "not-eligible" });
    expect(usageCounterAggregate).not.toHaveBeenCalled();
    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /** A second activation during a trial leaves the carried number alone. */
  it("asks nothing, and rewrites nothing, on a second activation", async () => {
    routineCount.mockResolvedValue(1);
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

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usageCounterAggregate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  /**
   * Pausing every worker and switching one back on: the count is zero again,
   * so the trial row is what answers — and it answers before any total is read.
   */
  it("asks nothing when the last worker is switched back on", async () => {
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
    expect(usageCounterAggregate).not.toHaveBeenCalled();
    expect(usagePeriodCreate).not.toHaveBeenCalled();
  });

  it("asks nothing for an account a paid plan already entitles", async () => {
    routineCount.mockResolvedValue(0);
    subscriptionFindUnique.mockResolvedValue(record());

    await startTrialOnFirstWorkerActivation(client, USER, NOW);

    expect(usageCounterAggregate).not.toHaveBeenCalled();
  });
});
