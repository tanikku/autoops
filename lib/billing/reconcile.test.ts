import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a look at a provider's current state does to an account.
 *
 * **These hold a fake transaction client.** No provider is reachable and no SDK
 * is installed, which is the point of the layer under test: the whole billing
 * domain can be exercised from a snapshot, without anybody's API and without
 * any question of ordering.
 *
 * **What cannot be tested here, said plainly.** That two concurrent looks
 * cannot apply an older view over a newer one is a property of holding the
 * reconciliation lease across the read, and nothing in this file holds a lease.
 * What is fixed below is what must be true for that to be worth having: the
 * difference is computed against what is stored at the time, refusals are
 * whole, and a run that finds nothing writes nothing.
 */

const subscriptionFindUnique = vi.fn();
const subscriptionCreate = vi.fn();
const subscriptionUpdate = vi.fn();
const periodFindUnique = vi.fn();
const periodCreate = vi.fn();
const counterUpdateMany = vi.fn();
const billingCreate = vi.fn();
const transaction = vi.fn();

/**
 * **Six tables and no seventh.** `routine` and `providerUsageEvent` are
 * deliberately absent: a branch that paused a worker or touched cost telemetry
 * would fail here rather than pass.
 */
const clientStub = {
  subscription: {
    findUnique: subscriptionFindUnique,
    create: subscriptionCreate,
    update: subscriptionUpdate,
  },
  usagePeriod: { findUnique: periodFindUnique, create: periodCreate },
  usageCounter: { updateMany: counterUpdateMany },
  billingEvent: { create: billingCreate },
  $transaction: transaction,
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));

const { reconcileProviderSubscription } = await import(
  "@/lib/billing/reconcile"
);
const { getPlanDefinition } = await import("@/lib/plans");

const USER = "google-sub-1";
const SUB = "provider-sub-1";
const RUN = "run-1";
const OBSERVED = new Date("2026-10-15T00:00:00.000Z");
const P1 = {
  start: new Date("2026-10-01T00:00:00.000Z"),
  end: new Date("2026-11-01T00:00:00.000Z"),
};
const P2 = {
  start: new Date("2026-11-01T00:00:00.000Z"),
  end: new Date("2026-12-01T00:00:00.000Z"),
};

type Snapshot = Parameters<typeof reconcileProviderSubscription>[0];

/** What the provider currently says. No provider's own vocabulary appears. */
function snapshot(overrides: Record<string, unknown> = {}): Snapshot {
  return {
    provider: "test-provider",
    providerCustomerId: "cus-1",
    providerSubscriptionId: SUB,
    userId: USER,
    plan: "standard",
    entitlement: "entitled",
    cancelAtPeriodEnd: false,
    periodStart: P1.start,
    periodEnd: P1.end,
    observedAt: OBSERVED,
    ...overrides,
  } as Snapshot;
}

/** A stored entitlement, as reconciliation reads it. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    plan: "standard",
    state: "active",
    source: "test-provider",
    expiresAt: null,
    currentPeriodStart: P1.start,
    currentPeriodEnd: P1.end,
    trialForfeitedAt: null,
    providerCustomerId: "cus-1",
    providerSubscriptionId: SUB,
    providerUpdatedAt: null,
    providerSyncedAt: null,
    ...overrides,
  };
}

/** The five carried-over accounts, as Production holds them. */
const ADMIN_BETA = stored({
  plan: "beta",
  state: "active",
  source: "admin",
  expiresAt: new Date("2026-12-31T23:59:59.000Z"),
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialForfeitedAt: new Date("2026-09-22T10:05:58.508Z"),
  providerCustomerId: null,
  providerSubscriptionId: null,
});

/** An account part-way through its trial. */
const TRIALING = stored({
  plan: "trial",
  state: "trialing",
  source: "trial",
  currentPeriodStart: null,
  currentPeriodEnd: null,
  providerCustomerId: null,
  providerSubscriptionId: null,
});

/** The kinds written to BillingEvent, in the order they were written. */
function writtenKinds(): string[] {
  return billingCreate.mock.calls.map((call) => call[0].data.kind);
}

/** The data of the update that set a given field, or undefined. */
function updateWith(field: string): Record<string, unknown> | undefined {
  return subscriptionUpdate.mock.calls
    .map((call) => call[0].data as Record<string, unknown>)
    .find((data) => field in data);
}

beforeEach(() => {
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
  subscriptionCreate.mockReset().mockResolvedValue({ id: "s1" });
  subscriptionUpdate.mockReset().mockResolvedValue({ id: "s1" });
  periodFindUnique.mockReset().mockResolvedValue(null);
  periodCreate.mockReset().mockResolvedValue({ id: "p1" });
  counterUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  billingCreate.mockReset().mockResolvedValue({ id: "b1" });
  transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) =>
      run(clientStub),
    );
});

describe("an account that has never paid", () => {
  it("becomes a paid subscription", async () => {
    const result = await reconcileProviderSubscription(snapshot(), RUN);

    expect(result).toEqual({
      outcome: "applied",
      kinds: ["subscription.activated"],
    });
    expect(subscriptionCreate.mock.calls[0][0].data).toMatchObject({
      userId: USER,
      plan: "standard",
      state: "active",
      source: "test-provider",
      expiresAt: null,
      providerSubscriptionId: SUB,
    });
  });

  /** The hole this closes: buy, cancel, and be offered a trial never owed. */
  it("takes the trial offer away for good", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(subscriptionCreate.mock.calls[0][0].data.trialForfeitedAt).toEqual(
      OBSERVED,
    );
  });

  it("opens a paid period that has been spent nothing of", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    const period = periodCreate.mock.calls[0][0].data;
    const standard = getPlanDefinition("standard");

    expect(period.planAtStart).toBe("standard");
    expect(period.counters.create).toHaveLength(3);
    for (const counter of period.counters.create) {
      expect(counter.used).toBe(0);
    }
    expect(
      period.counters.create.find(
        (c: { kind: string }) => c.kind === "aiProcessing",
      ).limit,
    ).toBe(standard.aiProcessingLimit);
  });

  /** A snapshot that says nothing is owed matches an account with nothing. */
  it("does nothing for an account the provider says has ended", async () => {
    const result = await reconcileProviderSubscription(
      snapshot({ entitlement: "ended" }),
      RUN,
    );

    expect(result).toEqual({ outcome: "already-converged" });
    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });
});

describe("an account on a trial that buys a plan", () => {
  beforeEach(() => subscriptionFindUnique.mockResolvedValue(TRIALING));

  it("becomes paid", async () => {
    const result = await reconcileProviderSubscription(snapshot(), RUN);

    expect(result).toMatchObject({ kinds: ["subscription.activated"] });
    expect(updateWith("plan")).toMatchObject({
      plan: "standard",
      state: "active",
      source: "test-provider",
    });
  });

  /** What they did with their trial is a fact about the past. */
  it("rewrites none of the trial's own columns", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    const data = updateWith("plan") ?? {};

    expect(data).not.toHaveProperty("trialStartedAt");
    expect(data).not.toHaveProperty("trialEndsAt");
    expect(data).not.toHaveProperty("trialConsumedAt");
  });

  /** §F-53: what a trial used belongs to the trial. */
  it("starts the paid period empty", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    for (const counter of periodCreate.mock.calls[0][0].data.counters.create) {
      expect(counter.used).toBe(0);
    }
  });
});

describe("a granted beta account that buys a plan", () => {
  beforeEach(() => subscriptionFindUnique.mockResolvedValue(ADMIN_BETA));

  /**
   * **The line that would otherwise expire a paid subscription.** Entitlement
   * resolution reads `expiresAt` before anything else, so a beta account that
   * kept its grant's expiry would resolve as expired on the last day of the
   * year, for a reason nobody looking at the paid plan would check.
   */
  it("clears the grant's expiry", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(updateWith("expiresAt")?.expiresAt).toBeNull();
  });

  it("keeps the forfeit date it already had", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(updateWith("plan")).not.toHaveProperty("trialForfeitedAt");
  });

  it("moves the source from the operator to the provider", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(updateWith("source")?.source).toBe("test-provider");
  });
});

describe("the period the provider reports", () => {
  beforeEach(() => subscriptionFindUnique.mockResolvedValue(stored()));

  it("does nothing when it is the one already in force", async () => {
    const result = await reconcileProviderSubscription(snapshot(), RUN);

    expect(result).toEqual({ outcome: "already-converged" });
    expect(periodCreate).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });

  it("opens the next one when the cycle has advanced", async () => {
    const result = await reconcileProviderSubscription(
      snapshot({ periodStart: P2.start, periodEnd: P2.end }),
      RUN,
    );

    expect(result).toEqual({
      outcome: "applied",
      kinds: ["subscription.renewed"],
    });
    expect(periodCreate.mock.calls[0][0].data).toMatchObject({
      periodStart: P2.start,
      periodEnd: P2.end,
      planAtStart: "standard",
    });
  });

  it("opens exactly one, not the ones an outage skipped", async () => {
    await reconcileProviderSubscription(
      snapshot({
        periodStart: new Date("2027-02-01T00:00:00.000Z"),
        periodEnd: new Date("2027-03-01T00:00:00.000Z"),
      }),
      RUN,
    );

    expect(periodCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * **Billing periods move forwards.** One that appears to have moved back is a
   * stale read or a provider fault, and reopening it would hand back an
   * allowance that has been spent.
   */
  it("refuses one earlier than the period in force", async () => {
    const result = await reconcileProviderSubscription(
      snapshot({
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
      RUN,
    );

    expect(result).toEqual({ outcome: "provider-domain-regression" });
  });

  it("writes nothing at all when it refuses one", async () => {
    await reconcileProviderSubscription(
      snapshot({
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      }),
      RUN,
    );

    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });
});

describe("the plan the provider reports", () => {
  beforeEach(() => subscriptionFindUnique.mockResolvedValue(stored()));

  it("does nothing when it is the plan already held", async () => {
    const result = await reconcileProviderSubscription(snapshot(), RUN);

    expect(result).toEqual({ outcome: "already-converged" });
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });

  it("raises the ceiling when it is higher", async () => {
    periodFindUnique.mockResolvedValue({ id: "current-period" });

    const result = await reconcileProviderSubscription(
      snapshot({ plan: "pro" }),
      RUN,
    );

    expect(result).toEqual({
      outcome: "applied",
      kinds: ["subscription.plan_changed"],
    });

    const pro = getPlanDefinition("pro");
    const raised = counterUpdateMany.mock.calls.map((call) => call[0]);

    expect(
      raised.find((c) => c.where.kind === "aiProcessing").data,
    ).toEqual({ limit: pro.aiProcessingLimit });
    for (const call of raised) {
      expect(call.data).not.toHaveProperty("used");
    }
  });

  /**
   * **A lower plan turns the whole reconciliation back.** Accepting the period
   * or the state while refusing the plan would knowingly leave the provider
   * billing for one thing and Koqentra granting another.
   */
  it("refuses everything when it is lower", async () => {
    const result = await reconcileProviderSubscription(
      snapshot({
        plan: "lite",
        periodStart: P2.start,
        periodEnd: P2.end,
        cancelAtPeriodEnd: true,
      }),
      RUN,
    );

    expect(result).toEqual({
      outcome: "provider-domain-mismatch",
      reason: "downgrade",
    });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });

  /** No worker is touched, and none could be: there is no table for one. */
  it("pauses nothing when it refuses a lower plan", async () => {
    await reconcileProviderSubscription(snapshot({ plan: "lite" }), RUN);

    expect(clientStub).not.toHaveProperty("routine");
  });
});

describe("the state the provider reports", () => {
  it.each([
    ["active", "grace", { entitlement: "grace" }, "subscription.payment_grace"],
    [
      "active",
      "canceled_active",
      { cancelAtPeriodEnd: true },
      "subscription.canceled",
    ],
    ["active", "inactive", { entitlement: "ended" }, "subscription.ended"],
    ["grace", "active", {}, "subscription.reactivated"],
    ["canceled_active", "active", {}, "subscription.reactivated"],
    ["grace", "inactive", { entitlement: "ended" }, "subscription.ended"],
    [
      "canceled_active",
      "inactive",
      { entitlement: "ended" },
      "subscription.ended",
    ],
    [
      "grace",
      "canceled_active",
      { cancelAtPeriodEnd: true },
      "subscription.canceled",
    ],
    [
      "canceled_active",
      "grace",
      { entitlement: "grace" },
      "subscription.payment_grace",
    ],
    ["inactive", "active", {}, "subscription.reactivated"],
  ])("moves %s to %s as %s", async (from, to, overrides, kind) => {
    subscriptionFindUnique.mockResolvedValue(stored({ state: from }));

    const result = await reconcileProviderSubscription(
      snapshot(overrides as Record<string, unknown>),
      RUN,
    );

    expect(result).toEqual({ outcome: "applied", kinds: [kind] });
    expect(updateWith("state")?.state).toBe(to);
  });

  /**
   * **Named by where it lands, not by the pair it crossed.** Grace to a
   * scheduled cancellation changed two things at the provider, but only one
   * state exists to hold the result — and an intermediate recovery row would
   * record a moment that never happened.
   */
  it("writes one row for a state change, never two", async () => {
    subscriptionFindUnique.mockResolvedValue(stored({ state: "grace" }));

    await reconcileProviderSubscription(
      snapshot({ cancelAtPeriodEnd: true }),
      RUN,
    );

    expect(writtenKinds()).toEqual(["subscription.canceled"]);
  });

  it("changes nothing but the state", async () => {
    subscriptionFindUnique.mockResolvedValue(stored({ state: "grace" }));

    await reconcileProviderSubscription(snapshot(), RUN);

    expect(updateWith("state")).toEqual({ state: "active" });
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });
});

describe("a snapshot about a subscription that is not the one in force", () => {
  const other = () => snapshot({ providerSubscriptionId: "provider-sub-2" });

  it("is refused while the bound one is live", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());

    expect(await reconcileProviderSubscription(other(), RUN)).toEqual({
      outcome: "provider-domain-mismatch",
      reason: "conflicting-subscription",
    });
  });

  /** An old subscription reporting its end must not disturb the new one. */
  it("is recognised as superseded when it reports no entitlement", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());

    expect(
      await reconcileProviderSubscription(
        snapshot({
          providerSubscriptionId: "provider-sub-0",
          entitlement: "ended",
        }),
        RUN,
      ),
    ).toEqual({ outcome: "superseded-subscription" });
  });

  it("writes nothing either way", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());
    await reconcileProviderSubscription(other(), RUN);

    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });

  /** A new purchase may take over once the last entitlement is over. */
  it("may take over once the bound one has ended", async () => {
    subscriptionFindUnique.mockResolvedValue(
      stored({
        state: "inactive",
        providerSubscriptionId: "provider-sub-0",
        trialForfeitedAt: OBSERVED,
      }),
    );

    expect(await reconcileProviderSubscription(other(), RUN)).toEqual({
      outcome: "applied",
      kinds: ["subscription.activated"],
    });
    expect(updateWith("providerSubscriptionId")?.providerSubscriptionId).toBe(
      "provider-sub-2",
    );
  });

  it("starts the taken-over subscription's period at zero", async () => {
    subscriptionFindUnique.mockResolvedValue(
      stored({
        state: "inactive",
        providerSubscriptionId: "provider-sub-0",
        currentPeriodStart: null,
        trialForfeitedAt: OBSERVED,
      }),
    );

    await reconcileProviderSubscription(other(), RUN);

    for (const counter of periodCreate.mock.calls[0][0].data.counters.create) {
      expect(counter.used).toBe(0);
    }
  });

  it("does not re-forfeit a trial already forfeited", async () => {
    subscriptionFindUnique.mockResolvedValue(
      stored({
        state: "inactive",
        providerSubscriptionId: "provider-sub-0",
        trialForfeitedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );

    await reconcileProviderSubscription(other(), RUN);

    expect(updateWith("plan")).not.toHaveProperty("trialForfeitedAt");
  });
});

/**
 * More than one thing changed at once.
 *
 * **The order is the design.** Each step is decided against what the step
 * before it left, not against the original reading — which is why a renewal
 * that restores an account to active writes no separate recovery row, while one
 * that lands on a subscription due to cancel still writes the cancellation.
 */
describe("several differences in one look", () => {
  it("renews into the new plan's own period, then records the upgrade", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());

    const result = await reconcileProviderSubscription(
      snapshot({ plan: "pro", periodStart: P2.start, periodEnd: P2.end }),
      RUN,
    );

    expect(result).toEqual({
      outcome: "applied",
      kinds: ["subscription.renewed", "subscription.plan_changed"],
    });
  });

  /**
   * **The new window really does run under the new plan.** Opening it under the
   * old one would make a question about a charge unanswerable.
   */
  it("opens the new period under the plan the provider now names", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());

    await reconcileProviderSubscription(
      snapshot({ plan: "pro", periodStart: P2.start, periodEnd: P2.end }),
      RUN,
    );

    expect(periodCreate.mock.calls[0][0].data).toMatchObject({
      periodStart: P2.start,
      planAtStart: "pro",
    });
  });

  /**
   * **The period that is over stays as it was.** Raising the ceiling of a
   * closed month would rewrite a record rather than describe one.
   */
  it("raises the limits of the new period, never the closed one", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());
    // The period the renewal is about to open does not exist yet, so the
    // first look finds nothing; the limit raise that follows must find the
    // period the renewal just opened, and never the one that closed.
    periodFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "new-period" });

    await reconcileProviderSubscription(
      snapshot({ plan: "pro", periodStart: P2.start, periodEnd: P2.end }),
      RUN,
    );

    for (const call of counterUpdateMany.mock.calls) {
      expect(call[0].where.periodId).toBe("new-period");
    }
  });


  /**
   * **The period that is over must keep its ceiling.** This is the invariant
   * the argument-passing exists for: a limit raise that read the subscription
   * as it was before the renewal would name the month that just closed.
   */
  it("never raises the closed period's limits", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());
    periodFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "new-period" });

    await reconcileProviderSubscription(
      snapshot({ plan: "pro", periodStart: P2.start, periodEnd: P2.end }),
      RUN,
    );

    const looked = periodFindUnique.mock.calls.map(
      (call) => call[0].where.userId_periodStart.periodStart,
    );

    expect(looked).not.toContainEqual(P1.start);
  });

  /** Renewal already restores active, so no separate recovery is written. */
  it("writes no recovery row when the renewal itself restores active", async () => {
    subscriptionFindUnique.mockResolvedValue(stored({ state: "grace" }));

    const result = await reconcileProviderSubscription(
      snapshot({ periodStart: P2.start, periodEnd: P2.end }),
      RUN,
    );

    expect(result).toEqual({
      outcome: "applied",
      kinds: ["subscription.renewed"],
    });
  });

  /** But a cancellation the renewal cannot express still gets its own row. */
  it("records a cancellation the renewal left undone", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());

    expect(
      await reconcileProviderSubscription(
        snapshot({
          periodStart: P2.start,
          periodEnd: P2.end,
          cancelAtPeriodEnd: true,
        }),
        RUN,
      ),
    ).toEqual({
      outcome: "applied",
      kinds: ["subscription.renewed", "subscription.canceled"],
    });
  });

  it("records an upgrade and a cancellation together", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());

    expect(
      await reconcileProviderSubscription(
        snapshot({ plan: "pro", cancelAtPeriodEnd: true }),
        RUN,
      ),
    ).toEqual({
      outcome: "applied",
      kinds: ["subscription.plan_changed", "subscription.canceled"],
    });
  });

  it("records all three when all three changed", async () => {
    subscriptionFindUnique.mockResolvedValue(stored({ state: "grace" }));

    expect(
      await reconcileProviderSubscription(
        snapshot({
          plan: "pro",
          periodStart: P2.start,
          periodEnd: P2.end,
          cancelAtPeriodEnd: true,
        }),
        RUN,
      ),
    ).toEqual({
      outcome: "applied",
      kinds: [
        "subscription.renewed",
        "subscription.plan_changed",
        "subscription.canceled",
      ],
    });
  });
});

describe("a look that finds nothing to do", () => {
  beforeEach(() => subscriptionFindUnique.mockResolvedValue(stored()));

  it("says so", async () => {
    expect(await reconcileProviderSubscription(snapshot(), RUN)).toEqual({
      outcome: "already-converged",
    });
  });

  it("writes no billing event", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(billingCreate).not.toHaveBeenCalled();
  });

  /**
   * **Still a successful reconciliation.** "When did this account last agree
   * with the provider" is exactly what this answers, and a quiet agreement is
   * the most common way of agreeing.
   */
  it("still records when the provider was last agreed with", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(updateWith("providerSyncedAt")?.providerSyncedAt).toEqual(OBSERVED);
  });

  it("changes nothing else", async () => {
    await reconcileProviderSubscription(snapshot(), RUN);

    expect(subscriptionUpdate).toHaveBeenCalledTimes(1);
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });
});

describe("what a reconciliation records", () => {
  beforeEach(() => subscriptionFindUnique.mockResolvedValue(stored()));

  /**
   * **Both legacy columns stay empty, and that is the truthful shape.** There
   * is no single delivery behind what a look at provider state found — a run
   * can answer several notifications or none — and no provider instant to
   * record, only the instant Koqentra looked.
   */
  it("leaves the delivery columns empty", async () => {
    await reconcileProviderSubscription(snapshot({ plan: "pro" }), RUN);

    expect(billingCreate.mock.calls[0][0].data).toMatchObject({
      providerEventId: null,
      occurredAt: null,
    });
  });

  it("records when it looked and which run looked", async () => {
    await reconcileProviderSubscription(snapshot({ plan: "pro" }), RUN);

    expect(billingCreate.mock.calls[0][0].data).toMatchObject({
      provider: "test-provider",
      userId: USER,
      kind: "subscription.plan_changed",
      observedAt: OBSERVED,
      reconciliationRunId: RUN,
    });
  });

  it("writes one row per difference it applied", async () => {
    await reconcileProviderSubscription(
      snapshot({ plan: "pro", cancelAtPeriodEnd: true }),
      RUN,
    );

    expect(writtenKinds()).toEqual([
      "subscription.plan_changed",
      "subscription.canceled",
    ]);
    expect(new Set(writtenKinds()).size).toBe(writtenKinds().length);
  });

  it("records the sync time on every successful reconciliation", async () => {
    await reconcileProviderSubscription(snapshot({ plan: "pro" }), RUN);

    expect(updateWith("providerSyncedAt")?.providerSyncedAt).toEqual(OBSERVED);
  });

  it.each([
    ["a regression", { periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: P1.end }],
    ["a downgrade", { plan: "lite" }],
  ])("records no sync time after %s", async (_label, overrides) => {
    await reconcileProviderSubscription(
      snapshot(overrides as Record<string, unknown>),
      RUN,
    );

    expect(updateWith("providerSyncedAt")).toBeUndefined();
  });
});

describe("a snapshot that cannot be used", () => {
  it.each([
    ["no provider", { provider: "" }, "provider-missing"],
    ["no customer", { providerCustomerId: " " }, "customer-missing"],
    ["no subscription", { providerSubscriptionId: "" }, "subscription-missing"],
    ["no account", { userId: "" }, "user-missing"],
    ["an unusable observation time", { observedAt: new Date("x") }, "observed-at-invalid"],
    ["only a period start", { periodEnd: null }, "period-half-present"],
    ["only a period end", { periodStart: null }, "period-half-present"],
    ["a period that does not move forwards", { periodEnd: P1.start }, "period-not-forwards"],
    ["an entitled subscription with no plan", { plan: null }, "entitled-without-plan"],
    ["an entitled subscription on a plan nobody sells", { plan: "beta" }, "entitled-without-plan"],
  ])("refuses %s", async (_label, overrides, reason) => {
    expect(
      await reconcileProviderSubscription(
        snapshot(overrides as Record<string, unknown>),
        RUN,
      ),
    ).toEqual({ outcome: "malformed", reason });
  });

  it("refuses a run with no identity", async () => {
    expect(await reconcileProviderSubscription(snapshot(), "  ")).toEqual({
      outcome: "malformed",
      reason: "run-missing",
    });
  });

  /** Refused before a transaction is opened, so nothing is read either. */
  it("reads and writes nothing", async () => {
    await reconcileProviderSubscription(snapshot({ userId: "" }), RUN);

    expect(transaction).not.toHaveBeenCalled();
    expect(subscriptionFindUnique).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });
});

describe("how the work is carried out", () => {
  it("does all of it in one transaction", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());
    await reconcileProviderSubscription(snapshot({ plan: "pro" }), RUN);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  /** A failure part-way leaves the caller's transaction to undo the rest. */
  it("lets a failure escape rather than half-applying", async () => {
    subscriptionFindUnique.mockResolvedValue(stored());
    billingCreate.mockRejectedValue(new Error("counter write failed"));

    await expect(
      reconcileProviderSubscription(snapshot({ plan: "pro" }), RUN),
    ).rejects.toThrow("counter write failed");
  });

  /** It must be usable inside a lease holder's own transaction. */
  it("uses the transaction it is given rather than opening one", async () => {
    const tx = { ...clientStub } as unknown as Record<string, unknown>;
    delete tx.$transaction;
    subscriptionFindUnique.mockResolvedValue(stored());

    const result = await reconcileProviderSubscription(
      snapshot(),
      RUN,
      tx as never,
    );

    expect(result).toEqual({ outcome: "already-converged" });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("provider neutrality", () => {
  it.each(["stripe", "app-store", "play", "some-future-provider"])(
    "behaves identically whoever %s is",
    async (provider) => {
      const result = await reconcileProviderSubscription(
        snapshot({ provider }),
        RUN,
      );

      expect(result).toMatchObject({ outcome: "applied" });
      expect(subscriptionCreate.mock.calls[0][0].data.source).toBe(provider);
    },
  );

  /**
   * **Read with the comments taken out.** The files name providers in prose, to
   * say why their vocabulary is kept at the edge; what must not exist is a
   * provider's word in the code.
   */
  it("uses no provider's vocabulary and no event ordering in its code", async () => {
    const { readFileSync } = await import("node:fs");

    const code = (path: string) =>
      readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

    for (const path of [
      "lib/billing/reconcile.ts",
      "lib/billing/snapshot.ts",
      "lib/billing/subscription-writes.ts",
    ]) {
      const source = code(path);

      for (const forbidden of [
        "stripe",
        "Stripe",
        "invoice.paid",
        "customer.subscription",
        "checkout.session",
        "past_due",
        "compareWithApplied",
      ]) {
        expect(source, `${path} mentions ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  /**
   * **The deprecated ordering column is the legacy caller's, not this one's.**
   * The shared writes still accept it, because the event layer has to keep
   * stamping it until it is gone; reconciliation never names it, and never
   * passes a stamp that could carry it.
   */
  it("never writes the column the old ordering model judged by", async () => {
    const { readFileSync } = await import("node:fs");

    const code = (path: string) =>
      readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

    for (const path of ["lib/billing/reconcile.ts", "lib/billing/snapshot.ts"]) {
      expect(code(path)).not.toContain("providerUpdatedAt");
    }

    expect(code("lib/billing/reconcile.ts")).not.toContain("stamp");
  });

  /**
   * **The one legacy column the core may name, and only to leave it empty.**
   * Writing `occurredAt: null` is the truthful shape for a row no single
   * delivery caused; what must never happen is reading it, which is what
   * ordering by a provider's clock would look like.
   */
  it("names the provider's clock only to write nothing to it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/reconcile.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    const mentions = [...source.matchAll(/occurredAt[^,\n]*/g)].map((m) =>
      m[0].trim(),
    );

    expect(mentions).toEqual(["occurredAt: null"]);
  });

  /** Proof the reader above can still see code, having stripped the prose. */
  it("still reads the code it is scanning", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/reconcile.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).toContain("reconcileProviderSubscription");
    expect(source).toContain("provider-domain-regression");
  });
});
