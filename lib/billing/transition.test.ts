import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a provider's event does to an account's entitlement.
 *
 * **These hold a fake transaction client and nothing else.** No provider is
 * reachable, no SDK is installed, and no webhook exists — which is the point of
 * the layer under test: the whole of the billing domain can be exercised
 * without anybody's API.
 *
 * **What cannot be tested here, said plainly.** That two deliveries racing
 * produce one effect is a property of `@@unique([provider, providerEventId])`
 * and of PostgreSQL's transactions, and a mock that answers immediately proves
 * nothing about either. What is fixed below is everything that would still have
 * to hold: that the event row is written before anything is read, that a unique
 * violation is turned into `duplicate` rather than an error, and that no branch
 * resets a counter.
 */

const billingCreate = vi.fn();
const subscriptionFindUnique = vi.fn();
const subscriptionCreate = vi.fn();
const subscriptionUpdate = vi.fn();
const periodFindUnique = vi.fn();
const periodCreate = vi.fn();
const counterUpdateMany = vi.fn();
const transaction = vi.fn();

/**
 * **Five tables and no sixth.** `providerUsageEvent` and `routine` are
 * deliberately absent: a branch that touched cost telemetry or paused a worker
 * would fail here rather than pass.
 */
const clientStub = {
  billingEvent: { create: billingCreate },
  subscription: {
    findUnique: subscriptionFindUnique,
    create: subscriptionCreate,
    update: subscriptionUpdate,
  },
  usagePeriod: { findUnique: periodFindUnique, create: periodCreate },
  usageCounter: { updateMany: counterUpdateMany },
  $transaction: transaction,
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));

const { applyBillingEvent } = await import("@/lib/billing/transition");
const { getPlanDefinition } = await import("@/lib/plans");

const USER = "google-sub-1";
const OCCURRED = new Date("2026-10-01T00:00:00.000Z");
const PERIOD_START = new Date("2026-10-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-11-01T00:00:00.000Z");

/** A normalised provider event. No provider's own vocabulary appears. */
function event(overrides: Record<string, unknown> = {}) {
  return {
    provider: "example-provider",
    providerEventId: "evt-1",
    kind: "subscription.activated" as const,
    userId: USER,
    plan: "standard" as const,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    occurredAt: OCCURRED,
    providerCustomerId: "cus-1",
    providerSubscriptionId: "sub-1",
    ...overrides,
  } as Parameters<typeof applyBillingEvent>[0];
}

/** A stored entitlement, as the transition reads it. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    plan: "standard",
    state: "active",
    source: "example-provider",
    expiresAt: null,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    trialForfeitedAt: null,
    providerUpdatedAt: null,
    ...overrides,
  };
}

/** The five carried-over accounts, exactly as Production holds them. */
const ADMIN_BETA = stored({
  plan: "beta",
  state: "active",
  source: "admin",
  expiresAt: new Date("2026-12-31T23:59:59.000Z"),
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialForfeitedAt: new Date("2026-09-22T10:05:58.508Z"),
});

/** An account part-way through its trial. */
const TRIALING = stored({
  plan: "trial",
  state: "trialing",
  source: "trial",
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialForfeitedAt: null,
});

/** The data one write was given. */
const written = {
  subscriptionCreate: () => subscriptionCreate.mock.calls[0][0].data,
  subscriptionUpdate: () => subscriptionUpdate.mock.calls[0][0].data,
  period: () => periodCreate.mock.calls[0][0].data,
};

/** One counter from the period that was opened, by kind. */
function openedCounter(kind: string) {
  return written
    .period()
    .counters.create.find((counter: { kind: string }) => counter.kind === kind);
}

beforeEach(() => {
  billingCreate.mockReset().mockResolvedValue({ id: "billing-event-1" });
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
  subscriptionCreate.mockReset().mockResolvedValue({ id: "subscription-1" });
  subscriptionUpdate.mockReset().mockResolvedValue({ id: "subscription-1" });
  periodFindUnique.mockReset().mockResolvedValue(null);
  periodCreate.mockReset().mockResolvedValue({ id: "usage-period-1" });
  counterUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  // The fake transaction runs the callback with the same client, so every
  // assertion below is about writes that would have committed together.
  transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) =>
      run(clientStub),
    );
});

/** A unique violation, as Prisma reports one. */
function uniqueViolation() {
  return Object.assign(new Error("unique constraint"), { code: "P2002" });
}

describe("an account buying a plan without ever having a trial", () => {
  it("creates a paid entitlement", async () => {
    expect(await applyBillingEvent(event())).toEqual({
      outcome: "applied",
      kind: "subscription.activated",
    });

    expect(written.subscriptionCreate()).toMatchObject({
      userId: USER,
      plan: "standard",
      state: "active",
      source: "example-provider",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      expiresAt: null,
      providerCustomerId: "cus-1",
      providerSubscriptionId: "sub-1",
      providerUpdatedAt: OCCURRED,
    });
  });

  /**
   * **The hole this closes.** Somebody who skips the trial, buys a plan and
   * cancels must not come back round to being offered a trial they never had.
   */
  it("takes the trial offer away for good", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionCreate().trialForfeitedAt).toEqual(OCCURRED);
  });

  /** They never consumed one, and the row must not say they did. */
  it("does not claim a trial was consumed", async () => {
    await applyBillingEvent(event());

    const data = written.subscriptionCreate();

    expect(data).not.toHaveProperty("trialConsumedAt");
    expect(data).not.toHaveProperty("trialStartedAt");
    expect(data).not.toHaveProperty("trialEndsAt");
  });
});

describe("an account on a trial that buys a plan", () => {
  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue(TRIALING);
  });

  it("becomes a paid entitlement", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionUpdate()).toMatchObject({
      plan: "standard",
      state: "active",
      source: "example-provider",
    });
  });

  /** What they did with their trial is a fact about the past. */
  it("rewrites none of the trial's own columns", async () => {
    await applyBillingEvent(event());

    const data = written.subscriptionUpdate();

    expect(data).not.toHaveProperty("trialStartedAt");
    expect(data).not.toHaveProperty("trialEndsAt");
    expect(data).not.toHaveProperty("trialConsumedAt");
  });

  it("records that the offer has now gone", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionUpdate().trialForfeitedAt).toEqual(OCCURRED);
  });

  /**
   * **The trial's period is not read and not touched.** Its counters are the
   * record of the fortnight; the paid period is a different window with its own
   * start, so it is a different row.
   */
  it("leaves the trial's own period alone", async () => {
    await applyBillingEvent(event());

    expect(periodCreate).toHaveBeenCalledTimes(1);
    expect(written.period().periodStart).toEqual(PERIOD_START);
    expect(written.period().planAtStart).toBe("standard");
  });

  /** §F-53: what a trial used belongs to the trial. */
  it("starts the paid period empty", async () => {
    await applyBillingEvent(event());

    for (const kind of ["aiProcessing", "manualRun", "discovery"]) {
      expect(openedCounter(kind).used).toBe(0);
    }
  });

  it("opens it at the paid plan's own numbers", async () => {
    await applyBillingEvent(event());

    const standard = getPlanDefinition("standard");

    expect(openedCounter("aiProcessing").limit).toBe(standard.aiProcessingLimit);
    expect(openedCounter("manualRun").limit).toBe(standard.manualRunLimit);
    expect(openedCounter("discovery").limit).toBe(standard.discoveryLimit);
  });

  it("opens exactly three counters, and none for active workers", async () => {
    await applyBillingEvent(event());

    const kinds = written
      .period()
      .counters.create.map((counter: { kind: string }) => counter.kind);

    expect(kinds.sort()).toEqual(["aiProcessing", "discovery", "manualRun"]);
  });
});

describe("a granted beta account that buys a plan", () => {
  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue(ADMIN_BETA);
  });

  /**
   * **The line that would otherwise expire a paid subscription.**
   * `resolveState` reads `expiresAt` before anything else, so a beta account
   * that kept its grant's expiry would have its paid plan resolve as `expired`
   * on the last day of the year.
   */
  it("clears the grant's expiry", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionUpdate().expiresAt).toBeNull();
  });

  /** The moment the offer went away is the grant's, not today's. */
  it("keeps the forfeit date it already had", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionUpdate()).not.toHaveProperty("trialForfeitedAt");
  });

  it("moves the source from the operator to the provider", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionUpdate().source).toBe("example-provider");
  });

  it("becomes the paid plan it bought", async () => {
    await applyBillingEvent(event());

    expect(written.subscriptionUpdate().plan).toBe("standard");
  });
});

describe("activations that cannot be used", () => {
  it.each([
    ["a trial plan", { plan: "trial" }],
    ["the beta allowance", { plan: "beta" }],
    ["no plan at all", { plan: null }],
  ])("refuses %s", async (_label, overrides) => {
    expect(await applyBillingEvent(event(overrides))).toEqual({
      outcome: "rejected",
      reason: "not-a-paid-plan",
    });
  });

  it.each([
    ["no start", { periodStart: null }],
    ["no end", { periodEnd: null }],
    ["an end before the start", { periodEnd: new Date("2026-09-01T00:00:00.000Z") }],
    ["a zero-length period", { periodEnd: PERIOD_START }],
  ])("refuses a period with %s", async (_label, overrides) => {
    expect(await applyBillingEvent(event(overrides))).toEqual({
      outcome: "rejected",
      reason: "invalid-period",
    });
  });

  it.each([
    ["an unknown kind", { kind: "subscription.exploded" }],
    ["no provider", { provider: "" }],
    ["no event id", { providerEventId: "  " }],
    ["no account", { userId: "" }],
    ["an unusable timestamp", { occurredAt: new Date("nonsense") }],
  ])("refuses an event with %s", async (_label, overrides) => {
    expect(await applyBillingEvent(event(overrides))).toEqual({
      outcome: "rejected",
      reason: "malformed-event",
    });
  });

  /**
   * **Nothing persists, though not always by declining to start.**
   *
   * A malformed event is refused before a transaction is opened. One whose
   * plan is unusable is refused inside it, after the event row was written —
   * and the transaction aborts, so that row never commits either. Both leave
   * the entitlement untouched, which is the promise; which of the two paths a
   * given refusal takes is not.
   */
  it.each([
    ["a malformed event", { kind: "subscription.exploded" }],
    ["a plan nobody buys", { plan: "trial" }],
  ])("changes no entitlement when it refuses %s", async (_label, overrides) => {
    await applyBillingEvent(event(overrides));

    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });

  /** A shape this module can reject on sight costs no transaction. */
  it("does not open a transaction for a malformed event", async () => {
    await applyBillingEvent(event({ kind: "subscription.exploded" }));

    expect(transaction).not.toHaveBeenCalled();
    expect(billingCreate).not.toHaveBeenCalled();
  });

  /** Only an activation may create an entitlement. */
  it.each([
    "subscription.renewed",
    "subscription.plan_changed",
    "subscription.payment_grace",
    "subscription.canceled",
    "subscription.ended",
    "subscription.reactivated",
  ])("refuses %s for an account with no entitlement", async (kind) => {
    subscriptionFindUnique.mockResolvedValue(null);

    expect(await applyBillingEvent(event({ kind }))).toEqual({
      outcome: "rejected",
      reason: "no-subscription",
    });
  });
});

describe("the same delivery arriving twice", () => {
  beforeEach(() => {
    billingCreate.mockRejectedValue(uniqueViolation());
  });

  it("is answered by the database, not by memory", async () => {
    expect(await applyBillingEvent(event())).toEqual({ outcome: "duplicate" });
  });

  /** The row that refused it is the proof the work was already done. */
  it("reads nothing and writes nothing else", async () => {
    await applyBillingEvent(event());

    expect(subscriptionFindUnique).not.toHaveBeenCalled();
    expect(subscriptionCreate).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    "subscription.activated",
    "subscription.renewed",
    "subscription.canceled",
  ])("resets no counter for a repeated %s", async (kind) => {
    await applyBillingEvent(event({ kind }));

    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });
});

describe("a renewal", () => {
  const NEXT_START = new Date("2026-11-01T00:00:00.000Z");
  const NEXT_END = new Date("2026-12-01T00:00:00.000Z");

  const renewal = () =>
    event({
      kind: "subscription.renewed",
      providerEventId: "evt-renew",
      plan: null,
      periodStart: NEXT_START,
      periodEnd: NEXT_END,
      occurredAt: NEXT_START,
    });

  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ providerUpdatedAt: OCCURRED }),
    );
  });

  it("moves the subscription into the new period", async () => {
    expect(await applyBillingEvent(renewal())).toMatchObject({
      outcome: "applied",
    });

    expect(written.subscriptionUpdate()).toMatchObject({
      state: "active",
      currentPeriodStart: NEXT_START,
      currentPeriodEnd: NEXT_END,
      providerUpdatedAt: NEXT_START,
    });
  });

  it("does not change the plan", async () => {
    await applyBillingEvent(renewal());

    expect(written.subscriptionUpdate()).not.toHaveProperty("plan");
  });

  it("opens exactly one new period, empty, at the current plan", async () => {
    await applyBillingEvent(renewal());

    expect(periodCreate).toHaveBeenCalledTimes(1);
    expect(written.period()).toMatchObject({
      periodStart: NEXT_START,
      periodEnd: NEXT_END,
      planAtStart: "standard",
    });
    expect(openedCounter("aiProcessing").used).toBe(0);
  });

  /**
   * **The previous period is not read and not written.** It is the record of a
   * month that is over.
   */
  it("leaves the period before it alone", async () => {
    await applyBillingEvent(renewal());

    expect(periodFindUnique).toHaveBeenCalledTimes(1);
    expect(periodFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_periodStart: { userId: USER, periodStart: NEXT_START } },
      }),
    );
  });

  /** A redelivered renewal must not zero a period already being spent. */
  it("uses a period that already exists rather than resetting it", async () => {
    periodFindUnique.mockResolvedValue({
      periodEnd: NEXT_END,
      planAtStart: "standard",
    });

    expect(await applyBillingEvent(renewal())).toMatchObject({
      outcome: "applied",
    });
    expect(periodCreate).not.toHaveBeenCalled();
  });

  /**
   * **A row that disagrees is an error, not a correction.** Something wrote a
   * period this event did not describe, and rewriting it would destroy the
   * record rather than repair it.
   */
  it("refuses a period that describes something else", async () => {
    periodFindUnique.mockResolvedValue({
      periodEnd: new Date("2027-01-01T00:00:00.000Z"),
      planAtStart: "standard",
    });

    await expect(applyBillingEvent(renewal())).rejects.toThrow(
      /already exists for that start/,
    );
  });

  it("refuses one opened on a different plan", async () => {
    periodFindUnique.mockResolvedValue({
      periodEnd: NEXT_END,
      planAtStart: "lite",
    });

    await expect(applyBillingEvent(renewal())).rejects.toThrow(
      /already exists for that start/,
    );
  });

  /** Two deliveries reaching the create together resolve to one period. */
  it("survives losing the race to create the period", async () => {
    periodCreate.mockRejectedValue(uniqueViolation());

    expect(await applyBillingEvent(renewal())).toMatchObject({
      outcome: "applied",
    });
  });
});

describe("the states a subscription moves through", () => {
  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ providerUpdatedAt: OCCURRED }),
    );
  });

  const later = new Date("2026-10-15T00:00:00.000Z");

  it.each([
    ["payment_grace", "subscription.payment_grace", "grace"],
    ["canceled", "subscription.canceled", "canceled_active"],
    ["ended", "subscription.ended", "inactive"],
    ["reactivated", "subscription.reactivated", "active"],
  ])("turns %s into %s", async (_label, kind, state) => {
    expect(
      await applyBillingEvent(event({ kind, occurredAt: later })),
    ).toMatchObject({ outcome: "applied" });

    expect(written.subscriptionUpdate()).toEqual({
      state,
      providerUpdatedAt: later,
    });
  });

  /**
   * **A state change touches nothing else.** Not the plan, not the period, not
   * the provider ids, not the trial columns and not one counter.
   */
  it.each([
    "subscription.payment_grace",
    "subscription.canceled",
    "subscription.ended",
    "subscription.reactivated",
  ])("changes nothing but the state for %s", async (kind) => {
    await applyBillingEvent(event({ kind, occurredAt: later }));

    expect(Object.keys(written.subscriptionUpdate()).sort()).toEqual([
      "providerUpdatedAt",
      "state",
    ]);
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });

  /** Grace keeps access: an unpaid invoice is not a reason to stop a worker. */
  it("keeps grace as a state the entitlement survives", async () => {
    await applyBillingEvent(
      event({ kind: "subscription.payment_grace", occurredAt: later }),
    );

    expect(written.subscriptionUpdate().state).toBe("grace");
  });

  /** Ending restores nothing, least of all a trial. */
  it("does not restore a trial when the subscription ends", async () => {
    await applyBillingEvent(
      event({ kind: "subscription.ended", occurredAt: later }),
    );

    const data = written.subscriptionUpdate();

    expect(data).not.toHaveProperty("trialForfeitedAt");
    expect(data).not.toHaveProperty("trialConsumedAt");
    expect(data).not.toHaveProperty("plan");
  });
});

describe("moving up a plan inside a period already paid for", () => {
  const later = new Date("2026-10-15T00:00:00.000Z");

  const change = (plan: string) =>
    event({
      kind: "subscription.plan_changed",
      providerEventId: "evt-change",
      plan,
      occurredAt: later,
    });

  beforeEach(() => {
    periodFindUnique.mockResolvedValue({ id: "usage-period-1" });
  });

  it.each([
    ["lite", "standard"],
    ["standard", "pro"],
    ["lite", "pro"],
  ])("moves %s up to %s", async (from, to) => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ plan: from, providerUpdatedAt: OCCURRED }),
    );

    expect(await applyBillingEvent(change(to))).toMatchObject({
      outcome: "applied",
    });
    expect(written.subscriptionUpdate()).toEqual({
      plan: to,
      providerUpdatedAt: later,
    });
  });

  /** More room, not un-spent usage. */
  it("raises every limit and writes no used value", async () => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ plan: "lite", providerUpdatedAt: OCCURRED }),
    );

    await applyBillingEvent(change("standard"));

    const standard = getPlanDefinition("standard");
    const byKind = new Map(
      counterUpdateMany.mock.calls.map((call) => [
        call[0].where.kind,
        call[0].data,
      ]),
    );

    expect(byKind.get("aiProcessing")).toEqual({
      limit: standard.aiProcessingLimit,
    });
    expect(byKind.get("manualRun")).toEqual({ limit: standard.manualRunLimit });
    expect(byKind.get("discovery")).toEqual({ limit: standard.discoveryLimit });

    for (const [, data] of byKind) {
      expect(data).not.toHaveProperty("used");
    }
  });

  /** The period did open on the old plan, and that stays true. */
  it("does not rewrite the plan the period opened on", async () => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ plan: "lite", providerUpdatedAt: OCCURRED }),
    );

    await applyBillingEvent(change("standard"));

    expect(periodCreate).not.toHaveBeenCalled();
    for (const call of counterUpdateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty("planAtStart");
    }
  });

  /**
   * **An account in grace that upgrades is still an account in grace.**
   * Rewriting the state to `active` here would settle a payment problem by
   * ignoring it.
   */
  it.each(["grace", "canceled_active"])(
    "leaves a %s subscription in the state it is in",
    async (state) => {
      subscriptionFindUnique.mockResolvedValue(
        stored({ plan: "lite", state, providerUpdatedAt: OCCURRED }),
      );

      await applyBillingEvent(change("standard"));

      expect(written.subscriptionUpdate()).not.toHaveProperty("state");
    },
  );

  /** Neither is a rung on the paid ladder; arriving from one is an activation. */
  it.each(["trial", "beta"])(
    "refuses to treat a move from %s as a change of plan",
    async (from) => {
      subscriptionFindUnique.mockResolvedValue(
        stored({ plan: from, providerUpdatedAt: OCCURRED }),
      );

      expect(await applyBillingEvent(change("standard"))).toEqual({
        outcome: "rejected",
        reason: "not-a-paid-plan",
      });
    },
  );
});

/**
 * Moving down a plan.
 *
 * **Deferred whole, rather than half-applied.** Taking an allowance away inside
 * a period already paid for would stop an account mid-month, and doing it
 * properly means asking the owner which workers stay on — a conversation, not a
 * webhook.
 */
describe("a request to move down a plan", () => {
  const later = new Date("2026-10-15T00:00:00.000Z");

  const down = (from: string, to: string) => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ plan: from, providerUpdatedAt: OCCURRED }),
    );

    return event({
      kind: "subscription.plan_changed",
      providerEventId: "evt-down",
      plan: to,
      occurredAt: later,
    });
  };

  it.each([
    ["pro", "lite"],
    ["pro", "standard"],
    ["standard", "lite"],
  ])("is refused from %s to %s", async (from, to) => {
    expect(await applyBillingEvent(down(from, to))).toEqual({
      outcome: "rejected",
      reason: "downgrade-not-supported-yet",
    });
  });

  it("does not move the plan part of the way", async () => {
    await applyBillingEvent(down("pro", "lite"));

    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it("lowers no limit", async () => {
    await applyBillingEvent(down("pro", "lite"));

    expect(counterUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * **No worker is touched, and none could be.** The client this module is
   * given has no `routine` table at all.
   */
  it("pauses nothing", async () => {
    await applyBillingEvent(down("pro", "lite"));

    expect(clientStub).not.toHaveProperty("routine");
  });
});

/**
 * Deliveries that overtook one another.
 *
 * **Judged by the provider's clock.** `providerUpdatedAt` holds when the last
 * applied event happened, so an older event that arrives later is recognised as
 * older rather than as newer.
 */
describe("events arriving out of order", () => {
  const applied = new Date("2026-10-15T00:00:00.000Z");

  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ state: "inactive", providerUpdatedAt: applied }),
    );
  });

  it("does not apply one the provider says is older", async () => {
    expect(
      await applyBillingEvent(
        event({
          kind: "subscription.reactivated",
          providerEventId: "evt-old",
          occurredAt: new Date("2026-10-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual({ outcome: "stale" });
  });

  it("overwrites no newer state with an older event", async () => {
    await applyBillingEvent(
      event({
        kind: "subscription.reactivated",
        providerEventId: "evt-old",
        occurredAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    );

    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(periodCreate).not.toHaveBeenCalled();
    expect(counterUpdateMany).not.toHaveBeenCalled();
  });

  it("applies one the provider says is newer", async () => {
    expect(
      await applyBillingEvent(
        event({
          kind: "subscription.reactivated",
          providerEventId: "evt-new",
          occurredAt: new Date("2026-10-20T00:00:00.000Z"),
        }),
      ),
    ).toMatchObject({ outcome: "applied" });
  });

  /**
   * **An exact tie is reported rather than resolved.** Two different events
   * carrying the same instant could be applied in either order and reach
   * different states; choosing by arrival would be a guess, and choosing by the
   * provider's event id would be inventing an order that identifier does not
   * carry.
   */
  it("refuses to choose between two events claiming the same instant", async () => {
    expect(
      await applyBillingEvent(
        event({
          kind: "subscription.canceled",
          providerEventId: "evt-tie",
          occurredAt: applied,
        }),
      ),
    ).toEqual({ outcome: "ambiguous-order" });
  });

  it("writes nothing when it cannot tell which came first", async () => {
    await applyBillingEvent(
      event({
        kind: "subscription.canceled",
        providerEventId: "evt-tie",
        occurredAt: applied,
      }),
    );

    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  /** A first event has nothing to be older than. */
  it("applies the first event an account ever gets", async () => {
    subscriptionFindUnique.mockResolvedValue(null);

    expect(
      await applyBillingEvent(event({ occurredAt: new Date(0) })),
    ).toMatchObject({ outcome: "applied" });
  });
});

/**
 * **The order of the steps, which is what makes a redelivery safe.** The event
 * row is written before anything is read, so the database answers "seen before"
 * rather than a comparison in this process.
 */
describe("what happens in what order", () => {
  it("writes the event row before reading the entitlement", async () => {
    await applyBillingEvent(event());

    expect(billingCreate.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptionFindUnique.mock.invocationCallOrder[0],
    );
  });

  it("does all of it inside one transaction", async () => {
    await applyBillingEvent(event());

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("records the event with the provider's own identity and instant", async () => {
    await applyBillingEvent(event());

    expect(billingCreate.mock.calls[0][0].data).toEqual({
      provider: "example-provider",
      providerEventId: "evt-1",
      userId: USER,
      kind: "subscription.activated",
      occurredAt: OCCURRED,
    });
  });

  /**
   * **A refusal leaves no row behind.** `BillingEvent` carries no outcome
   * column, so a row can only mean one thing; letting a refused event leave one
   * would make the table say an event took effect when it did not.
   */
  it("rolls the event row back when the transition is refused", async () => {
    subscriptionFindUnique.mockResolvedValue(
      stored({ plan: "pro", providerUpdatedAt: OCCURRED }),
    );

    const result = await applyBillingEvent(
      event({
        kind: "subscription.plan_changed",
        plan: "lite",
        occurredAt: new Date("2026-10-15T00:00:00.000Z"),
      }),
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "downgrade-not-supported-yet",
    });
    // The create was attempted inside the transaction the refusal aborted.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });
});

/**
 * **Who billed is opaque.** No branch reads the provider's name, and the tests
 * above use one no provider has — which is the point: they would all still pass
 * if Koqentra's first provider turned out to be somebody else.
 */
describe("provider neutrality", () => {
  it.each(["stripe", "app-store", "play", "some-future-provider"])(
    "behaves identically whoever %s is",
    async (provider) => {
      const result = await applyBillingEvent(
        event({ provider, providerEventId: `evt-${provider}` }),
      );

      expect(result).toMatchObject({ outcome: "applied" });
      expect(written.subscriptionCreate().source).toBe(provider);
    },
  );

  /**
   * **Read with the comments taken out.** Both files name providers in prose,
   * to say why their vocabulary is kept at the edge — that is the explanation,
   * not a dependency. What must not exist is a provider's word in the code.
   */
  it("uses no provider's vocabulary in its code", async () => {
    const { readFileSync } = await import("node:fs");

    const code = (path: string) =>
      readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

    for (const path of ["lib/billing/transition.ts", "lib/billing/events.ts"]) {
      const source = code(path);

      for (const name of [
        "checkout.session",
        "customer.subscription",
        "invoice.payment",
        "DID_RENEW",
        "stripe",
        "Stripe",
        "appStore",
        "googlePlay",
      ]) {
        expect(source, path).not.toContain(name);
      }
    }
  });

  /** Proof the reader above can still see code, having stripped the prose. */
  it("still reads the code it is scanning", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/transition.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).toContain("applyBillingEvent");
    expect(source).toContain("subscription.activated");
  });

  it("reaches no cost telemetry and no worker", async () => {
    await applyBillingEvent(event());

    expect(clientStub).not.toHaveProperty("providerUsageEvent");
    expect(clientStub).not.toHaveProperty("routine");
  });
});
