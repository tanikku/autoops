import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may start a checkout, and what a retry of one asks for.
 *
 * **No provider is involved, and that is the design.** The orchestration is
 * handed a `CheckoutProvider`; every branch below is therefore a decision about
 * Koqentra's own rows, testable without a network. What Stripe does with the
 * request it is given is `providers/stripe-checkout.ts`, and the one property
 * that spans both — that an identical key must carry identical parameters — was
 * proven against a sandbox before either was written.
 *
 * **The order the steps run in is part of the contract.** A paid account must
 * not reach a provider, and an unacknowledged over-limit must not take a
 * coordination slot, so several tests assert that nothing happened rather than
 * what happened.
 */

const subscriptionFindUnique = vi.fn();
const routineCount = vi.fn();
const userUpdate = vi.fn();
const attemptFindUnique = vi.fn();
const attemptCreate = vi.fn();
const attemptDelete = vi.fn();
const attemptUpdateMany = vi.fn();
const transaction = vi.fn();

const clientStub = {
  subscription: { findUnique: subscriptionFindUnique },
  routine: { count: routineCount },
  user: { update: userUpdate },
  checkoutAttempt: {
    findUnique: attemptFindUnique,
    create: attemptCreate,
    delete: attemptDelete,
    updateMany: attemptUpdateMany,
  },
  $transaction: transaction,
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));

const {
  CHECKOUT_SESSION_LIFETIME_MS,
  sessionExpiresAt,
  startCheckout,
} = await import("@/lib/billing/checkout");

const USER = "116614511017733764020";
const NOW = new Date("2026-09-27T09:00:00.000Z");
const ATTEMPT_CREATED = new Date("2026-09-27T08:00:00.000Z");
const TTL_MS = 18 * 60 * 60 * 1000;

const createSession = vi.fn();
const readSession = vi.fn();
const findLiveSubscription = vi.fn();

const provider = { createSession, readSession, findLiveSubscription };

/** A subscription row, defaulting to the granted beta allowance. */
function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    plan: "beta",
    state: "active",
    source: "admin",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: new Date("2026-09-25T15:51:15.150Z"),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    notificationWorkerId: null,
    expiresAt: new Date("2026-12-31T23:59:59.000Z"),
    providerCustomerId: null,
    providerSubscriptionId: null,
    ...overrides,
  };
}

/** A paid row, as reconciliation writes one. */
function paidRow(overrides: Record<string, unknown> = {}) {
  return subscriptionRow({
    plan: "lite",
    state: "active",
    source: "stripe",
    currentPeriodStart: new Date("2026-09-25T16:31:48.000Z"),
    currentPeriodEnd: new Date("2026-10-25T16:31:48.000Z"),
    expiresAt: null,
    providerCustomerId: "cus_existing",
    providerSubscriptionId: "sub_existing",
    ...overrides,
  });
}

function storedAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    plan: "lite",
    state: "starting",
    providerCheckoutSessionId: null,
    expiresAt: new Date(ATTEMPT_CREATED.getTime() + TTL_MS),
    createdAt: ATTEMPT_CREATED,
    ...overrides,
  };
}

function start(overrides: Record<string, unknown> = {}) {
  return startCheckout({
    userId: USER,
    plan: "lite",
    provider,
    now: NOW,
    ...overrides,
  } as Parameters<typeof startCheckout>[0]);
}

beforeEach(() => {
  process.env.AUTH_URL = "https://app.example.invalid";

  subscriptionFindUnique.mockReset().mockResolvedValue(subscriptionRow());
  routineCount.mockReset().mockResolvedValue(0);
  userUpdate.mockReset().mockResolvedValue({ id: USER });
  attemptFindUnique.mockReset().mockResolvedValue(null);
  attemptDelete.mockReset().mockResolvedValue({});
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  attemptCreate
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "attempt-1",
      plan: data.plan,
      state: data.state,
      providerCheckoutSessionId: null,
      expiresAt: data.expiresAt,
      createdAt: NOW,
    }));
  transaction
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => unknown) => run(clientStub));

  createSession
    .mockReset()
    .mockResolvedValue({ sessionId: "cs_test_1", url: "https://pay.example.invalid/1" });
  readSession.mockReset().mockResolvedValue({ kind: "payable", url: "https://pay.example.invalid/1" });
  findLiveSubscription.mockReset().mockResolvedValue({ kind: "none" });
});

describe("the guardrail, counted when it matters", () => {
  it("creates a session below the limit", async () => {
    routineCount.mockResolvedValue(1);

    const result = await start();

    expect(result).toMatchObject({
      outcome: "checkout-ready",
      standing: "below-limit",
      resumed: false,
      sessionId: "cs_test_1",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  /** Exactly at the limit is a warning to render, not a refusal. */
  it("creates a session at the limit without asking anything", async () => {
    routineCount.mockResolvedValue(2);

    const result = await start();

    expect(result).toMatchObject({ outcome: "checkout-ready", standing: "at-limit" });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  /**
   * **Nothing is written and nobody is called.** Taking a coordination slot for
   * a purchase somebody has not agreed to would hold it against them.
   */
  it("asks first when over the limit, writing nothing", async () => {
    routineCount.mockResolvedValue(3);

    const result = await start();

    expect(result).toEqual({
      outcome: "over-limit-confirmation-required",
      activeWorkers: 3,
      activeWorkerLimit: 2,
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(attemptCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("proceeds over the limit once it has been acknowledged", async () => {
    routineCount.mockResolvedValue(3);

    const result = await start({ overLimitAcknowledged: true });

    expect(result).toMatchObject({ outcome: "checkout-ready", standing: "over-limit" });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  /** The limit is the plan's, from the one catalogue that says so. */
  it.each([
    ["lite", 2],
    ["standard", 8],
    ["pro", 15],
  ])("judges %s against %i", async (plan, limit) => {
    routineCount.mockResolvedValue(limit + 1);

    const result = await start({ plan });

    expect(result).toMatchObject({
      outcome: "over-limit-confirmation-required",
      activeWorkerLimit: limit,
    });
  });

  /** Counted fresh, so a worker activated in another tab is seen. */
  it("counts the account's active workers rather than trusting its caller", async () => {
    await start();

    expect(routineCount).toHaveBeenCalledWith({
      where: { userId: USER, status: "active" },
    });
  });
});

describe("who may not start one at all", () => {
  it.each([
    ["a live paid subscription", paidRow(), "already-subscribed"],
    [
      "one behind on payment",
      paidRow({ state: "grace" }),
      "payment-behind",
    ],
    [
      "one cancelling inside its period",
      paidRow({
        state: "canceled_active",
        currentPeriodEnd: new Date("2026-10-25T16:31:48.000Z"),
      }),
      "cancelling",
    ],
  ])("sends %s to billing management", async (_label, row, reason) => {
    subscriptionFindUnique.mockResolvedValue(row);

    const result = await start();

    expect(result).toEqual({ outcome: "billing-management-required", reason });
    // A paid account never reaches a provider.
    expect(findLiveSubscription).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(attemptCreate).not.toHaveBeenCalled();
  });

  /** A paid state with nothing to point at is refused rather than repaired. */
  it("refuses a paid row with no provider subscription", async () => {
    subscriptionFindUnique.mockResolvedValue(
      paidRow({ state: "inactive", providerSubscriptionId: null }),
    );

    expect(await start()).toEqual({
      outcome: "malformed-config",
      reason: "inconsistent-subscription",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an entitlement it cannot read", async () => {
    subscriptionFindUnique.mockResolvedValue(subscriptionRow({ state: "renegotiating" }));

    expect(await start()).toEqual({
      outcome: "malformed-config",
      reason: "unreadable-entitlement",
    });
  });
});

describe("who may", () => {
  /** Provisioning writes `User` at a write path; a `Subscription` comes later. */
  it("lets an account with no subscription row buy", async () => {
    subscriptionFindUnique.mockResolvedValue(null);

    const result = await start();

    expect(result).toMatchObject({ outcome: "checkout-ready" });
    // No customer to reuse, so the provider is not asked about one.
    expect(findLiveSubscription).not.toHaveBeenCalled();
  });

  it("lets a trialing account buy, with no provider trial attached", async () => {
    subscriptionFindUnique.mockResolvedValue(
      subscriptionRow({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-09-20T00:00:00.000Z"),
        trialEndsAt: new Date("2026-10-04T00:00:00.000Z"),
        trialConsumedAt: new Date("2026-09-20T00:00:00.000Z"),
        trialForfeitedAt: null,
        expiresAt: null,
      }),
    );

    expect(await start()).toMatchObject({ outcome: "checkout-ready" });
    // Nothing in the request names a trial; Koqentra owns that concept.
    expect(JSON.stringify(createSession.mock.calls[0][0])).not.toContain("trial");
  });

  it("lets the granted beta allowance buy", async () => {
    expect(await start()).toMatchObject({ outcome: "checkout-ready" });
  });

  /** Cancellation must not be permanent. */
  it("lets a former paid account subscribe again", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ state: "inactive" }));

    const result = await start();

    expect(result).toMatchObject({ outcome: "checkout-ready" });
    expect(findLiveSubscription).toHaveBeenCalledWith("cus_existing");
  });
});

/**
 * Asking the provider whether it already has one.
 *
 * **Because Koqentra can be behind.** It may read `inactive` while the provider
 * has a subscription reconciliation has not seen — which is the window a
 * duplicate is born in.
 */
describe("verifying against the provider", () => {
  it("refuses when the provider still has a live subscription", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ state: "inactive" }));
    findLiveSubscription.mockResolvedValue({
      kind: "live",
      providerSubscriptionId: "sub_live",
    });

    const result = await start();

    expect(result).toEqual({
      outcome: "billing-management-required",
      reason: "provider-subscription-live",
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(attemptCreate).not.toHaveBeenCalled();
  });

  /**
   * **Fails closed.** Not knowing whether an account already pays is exactly
   * when a second subscription gets created.
   */
  it("refuses when the provider cannot be asked", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ state: "inactive" }));
    findLiveSubscription.mockRejectedValue(new Error("stripe down"));

    const result = await start();

    expect(result).toEqual({ outcome: "provider-verification-unavailable" });
    expect(createSession).not.toHaveBeenCalled();
    expect(attemptCreate).not.toHaveBeenCalled();
  });

  it("says nothing of why the provider failed", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ state: "inactive" }));
    findLiveSubscription.mockRejectedValue(
      new Error("Invalid API Key provided: sk_test_abc"),
    );

    const body = JSON.stringify(await start());

    expect(body).not.toContain("sk_test");
    expect(body).not.toContain("API Key");
  });

  /** No customer means nothing to look up, and nothing is looked up. */
  it("skips the check when the account has no customer", async () => {
    expect(await start()).toMatchObject({ outcome: "checkout-ready" });
    expect(findLiveSubscription).not.toHaveBeenCalled();
  });
});

describe("holding the account's slot", () => {
  it("reports a plan switch without calling a provider", async () => {
    attemptFindUnique.mockResolvedValue(storedAttempt({ plan: "pro", state: "open" }));

    const result = await start({ plan: "lite" });

    expect(result).toEqual({
      outcome: "plan-switch-required",
      currentPlan: "pro",
      attemptId: "attempt-1",
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
  });

  /** The attempt is taken before the provider is asked to make a session. */
  it("takes the slot before creating anything", async () => {
    await start();

    expect(attemptCreate.mock.invocationCallOrder[0]).toBeLessThan(
      createSession.mock.invocationCallOrder[0],
    );
    expect(createSession.mock.invocationCallOrder[0]).toBeLessThan(
      attemptUpdateMany.mock.invocationCallOrder[0],
    );
  });

  it("records the session against the attempt", async () => {
    await start();

    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", state: "starting", providerCheckoutSessionId: null },
      data: { state: "open", providerCheckoutSessionId: "cs_test_1" },
    });
  });
});

/**
 * An attempt that already named a session.
 *
 * **The session is asked about before anything is created.** The slot outlives
 * the session by six hours, so between those two an attempt is live while its
 * session is not — and the same idempotency key with a different expiry would be
 * refused outright.
 */
describe("resuming an attempt that has a session", () => {
  it("sends them back to a session that is still payable", async () => {
    attemptFindUnique.mockResolvedValue(
      storedAttempt({ state: "open", providerCheckoutSessionId: "cs_test_open" }),
    );

    const result = await start();

    expect(result).toMatchObject({
      outcome: "checkout-ready",
      resumed: true,
      sessionId: "cs_test_open",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  /** Paid already. A second session would be a second charge. */
  it("reports processing for a session that was paid", async () => {
    attemptFindUnique.mockResolvedValue(
      storedAttempt({ state: "open", providerCheckoutSessionId: "cs_test_paid" }),
    );
    readSession.mockResolvedValue({ kind: "paid", url: null });

    expect(await start()).toEqual({
      outcome: "payment-processing",
      attemptId: "attempt-1",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when the session cannot be read", async () => {
    attemptFindUnique.mockResolvedValue(
      storedAttempt({ state: "open", providerCheckoutSessionId: "cs_test_1" }),
    );
    readSession.mockRejectedValue(new Error("stripe down"));

    expect(await start()).toEqual({ outcome: "provider-verification-unavailable" });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a session status it cannot read", async () => {
    attemptFindUnique.mockResolvedValue(
      storedAttempt({ state: "open", providerCheckoutSessionId: "cs_test_1" }),
    );
    readSession.mockResolvedValue({ kind: "unreadable", url: null });

    expect(await start()).toEqual({
      outcome: "malformed-config",
      reason: "unreadable-attempt",
    });
    expect(createSession).not.toHaveBeenCalled();
  });
});

/**
 * A session nobody can pay through any more.
 *
 * **The provider is the one saying it is finished with**, which is what
 * separates this from a plan switch: there, the account may be looking at a
 * payment page and only they can decide to abandon it; here, the page is dead
 * whatever they decide. So the slot is released and taken again in one go rather
 * than held for the hours the attempt has left.
 *
 * **The lapsed session is not expired at the provider.** It already is.
 */
describe("recovering from a session that has lapsed", () => {
  /** Thirteen hours old: past the session's twelve, inside the slot's eighteen. */
  const lapsed = (overrides: Record<string, unknown> = {}) =>
    storedAttempt({
      id: "attempt-old",
      state: "open",
      providerCheckoutSessionId: "cs_test_expired",
      createdAt: new Date(NOW.getTime() - 13 * 60 * 60 * 1000),
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 60 * 1000),
      ...overrides,
    });

  beforeEach(() => {
    readSession.mockResolvedValue({ kind: "lapsed", url: null });
    // First read finds the lapsed attempt; after it is closed and replaced,
    // `beginCheckoutAttempt` reads the closed row and writes a new one.
    attemptFindUnique
      .mockResolvedValueOnce(lapsed())
      .mockResolvedValue({ ...lapsed(), state: "closed" });
  });

  it("creates a new session rather than making them wait", async () => {
    const result = await start();

    expect(result).toMatchObject({
      outcome: "checkout-ready",
      resumed: false,
      sessionId: "cs_test_1",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("closes the attempt whose session lapsed", async () => {
    await start();

    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-old", state: { not: "closed" } },
      data: { state: "closed" },
    });
  });

  /** The same plan, because nothing about what they wanted changed. */
  it("begins again for the plan that was asked for", async () => {
    attemptFindUnique.mockReset();
    attemptFindUnique
      .mockResolvedValueOnce(lapsed({ plan: "standard" }))
      .mockResolvedValue({ ...lapsed({ plan: "standard" }), state: "closed" });

    await start({ plan: "standard" });

    expect(attemptCreate.mock.calls[0][0].data.plan).toBe("standard");
  });

  /** A new attempt is a new id — a replay of the old key would be refused. */
  it("takes a new attempt id", async () => {
    const result = await start();

    expect((result as { attemptId: string }).attemptId).toBe("attempt-1");
    expect((result as { attemptId: string }).attemptId).not.toBe("attempt-old");
    expect(attemptDelete).toHaveBeenCalledWith({ where: { id: "attempt-old" } });
  });

  it("asks for the new session under the new attempt's id", async () => {
    await start();

    expect(createSession.mock.calls[0][0].attemptId).toBe("attempt-1");
  });

  /** The expiry follows the new attempt, not the one that lapsed. */
  it("derives the new expiry from the new attempt", async () => {
    await start();

    expect(createSession.mock.calls[0][0].expiresAt).toEqual(
      new Date(NOW.getTime() + CHECKOUT_SESSION_LIFETIME_MS),
    );
  });

  it("records the new session against the new attempt", async () => {
    await start();

    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", state: "starting", providerCheckoutSessionId: null },
      data: { state: "open", providerCheckoutSessionId: "cs_test_1" },
    });
  });

  /** The session is already expired; asking the provider to expire it is a
   * write with nothing to change. */
  it("does not ask the provider to expire anything", async () => {
    await start();

    expect(Object.keys(provider)).toEqual([
      "createSession",
      "readSession",
      "findLiveSubscription",
    ]);
  });

  /**
   * **Two requests converge.** Both see the lapse, both close, both begin — the
   * account's lock and the unique index give them one row, and the second finds
   * the first's session rather than asking for another.
   */
  it("uses the session a concurrent recovery already made", async () => {
    attemptFindUnique.mockReset();
    attemptFindUnique
      .mockResolvedValueOnce(lapsed())
      // The other request got there first: the replacement already has its own
      // session.
      .mockResolvedValue(
        storedAttempt({
          id: "attempt-winner",
          state: "open",
          providerCheckoutSessionId: "cs_test_winner",
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + TTL_MS),
        }),
      );

    const result = await start();

    expect(result).toMatchObject({
      outcome: "checkout-ready",
      attemptId: "attempt-winner",
      sessionId: "cs_test_winner",
      resumed: true,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  /** Something else took the slot for another plan in between. */
  it("stands down when the replacement is for another plan", async () => {
    attemptFindUnique.mockReset();
    attemptFindUnique
      .mockResolvedValueOnce(lapsed())
      .mockResolvedValue(
        storedAttempt({
          id: "attempt-other",
          plan: "pro",
          state: "starting",
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + TTL_MS),
        }),
      );

    const result = await start({ plan: "lite" });

    expect(result).toEqual({
      outcome: "plan-switch-required",
      currentPlan: "pro",
      attemptId: "attempt-other",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  /** A crash between the close and the new begin leaves a closed row, which
   * the next request replaces. */
  it("replaces a closed attempt on the next request", async () => {
    attemptFindUnique.mockReset();
    attemptFindUnique.mockResolvedValue({ ...lapsed(), state: "closed" });

    const result = await start();

    expect(result).toMatchObject({ outcome: "checkout-ready", resumed: false });
    // A closed attempt is replaced by `beginCheckoutAttempt`, so the lapsed
    // session is never read again.
    expect(readSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  /** The create can still fail, and the new attempt stays `starting`. */
  it("leaves the new attempt startable when the create fails", async () => {
    createSession.mockRejectedValue(new Error("stripe down"));

    expect(await start()).toEqual({ outcome: "provider-verification-unavailable" });
    // Closed the old one, took a new one, and recorded no session against it.
    expect(attemptUpdateMany).toHaveBeenCalledTimes(1);
    expect(attemptUpdateMany.mock.calls[0][0].data).toEqual({ state: "closed" });
  });
});

/**
 * A different plan is not a lapsed session.
 *
 * **Never closed without being asked.** The account may be looking at a payment
 * page for the other plan; only they can decide to abandon it, and expiring
 * their session is a separate flow with its own confirmation.
 */
describe("what a plan switch does not do", () => {
  it.each(["starting", "open"])(
    "leaves a %s attempt for another plan alone",
    async (state) => {
      attemptFindUnique.mockResolvedValue(
        storedAttempt({ plan: "pro", state, providerCheckoutSessionId: "cs_test_pro" }),
      );

      const result = await start({ plan: "lite" });

      expect(result).toMatchObject({ outcome: "plan-switch-required" });
      // Not closed, not replaced, and its session not even looked at.
      expect(attemptUpdateMany).not.toHaveBeenCalled();
      expect(attemptDelete).not.toHaveBeenCalled();
      expect(readSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    },
  );
});

/**
 * What a retry asks for.
 *
 * **Every parameter has to be identical.** Stripe refuses a key reused with
 * different parameters — measured, not assumed — so a retry that recomputed
 * anything from the clock would fail rather than replay.
 */
describe("asking for the same thing twice", () => {
  it("derives the expiry from the attempt, not from now", async () => {
    attemptFindUnique.mockResolvedValue(storedAttempt());

    await start();

    expect(createSession.mock.calls[0][0].expiresAt).toEqual(
      new Date(ATTEMPT_CREATED.getTime() + CHECKOUT_SESSION_LIFETIME_MS),
    );
  });

  it("asks for the same expiry however much later the retry is", async () => {
    attemptFindUnique.mockResolvedValue(storedAttempt());

    await start();
    await start({ now: new Date(NOW.getTime() + 4 * 60 * 60 * 1000) });

    expect(createSession.mock.calls[1][0].expiresAt).toEqual(
      createSession.mock.calls[0][0].expiresAt,
    );
  });

  /** Twelve hours under the slot's eighteen, and under the provider's day. */
  it("keeps the session's life shorter than the slot's", () => {
    expect(CHECKOUT_SESSION_LIFETIME_MS).toBe(12 * 60 * 60 * 1000);
    expect(CHECKOUT_SESSION_LIFETIME_MS).toBeLessThan(TTL_MS);
    expect(sessionExpiresAt(storedAttempt() as never)).toEqual(
      new Date(ATTEMPT_CREATED.getTime() + CHECKOUT_SESSION_LIFETIME_MS),
    );
  });

  it("asks for a byte-identical request on a retry", async () => {
    attemptFindUnique.mockResolvedValue(storedAttempt());

    await start();
    await start({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });

    expect(JSON.stringify(createSession.mock.calls[1][0])).toBe(
      JSON.stringify(createSession.mock.calls[0][0]),
    );
  });

  /**
   * **The customer cannot move underneath a retry.** Reconciliation writes
   * `providerCustomerId` in the same statement that writes `state: "active"` and
   * `source`, so an account whose customer appeared between two tries is a paid
   * account by then — and eligibility refuses it before a session is asked for.
   * A customer that was already there does not change.
   */
  it("asks for the same customer on a retry", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ state: "inactive" }));
    attemptFindUnique.mockResolvedValue(storedAttempt());

    await start();
    await start({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });

    expect(createSession.mock.calls[0][0].providerCustomerId).toBe("cus_existing");
    expect(createSession.mock.calls[1][0].providerCustomerId).toBe("cus_existing");
  });

  /** An account whose customer appears mid-attempt is paid, and refused. */
  it("refuses rather than changing the customer mid-attempt", async () => {
    attemptFindUnique.mockResolvedValue(storedAttempt());
    await start();

    // Reconciliation has since run: customer, state and source all moved
    // together, because one statement writes them.
    subscriptionFindUnique.mockResolvedValue(paidRow());

    expect(await start()).toEqual({
      outcome: "billing-management-required",
      reason: "already-subscribed",
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  /** Nothing derived from the account's own settings, which they can change. */
  it("names no locale, so a language change cannot alter the request", async () => {
    await start();

    expect(Object.keys(createSession.mock.calls[0][0]).sort()).toEqual([
      "attemptId",
      "cancelUrl",
      "expiresAt",
      "plan",
      "providerCustomerId",
      "successUrl",
      "userId",
    ]);
  });
});

describe("what the request carries", () => {
  it("binds the subscription to the authenticated account", async () => {
    await start();

    expect(createSession.mock.calls[0][0].userId).toBe(USER);
  });

  it("names the plan it was asked for and nothing about money", async () => {
    await start({ plan: "standard" });

    const request = createSession.mock.calls[0][0];

    expect(request.plan).toBe("standard");
    expect(request).not.toHaveProperty("amount");
    expect(request).not.toHaveProperty("currency");
    expect(request).not.toHaveProperty("price");
    expect(request).not.toHaveProperty("quantity");
  });

  /** Built from the deployment's origin, never from anything a caller sent. */
  /**
   * **Success has a page of its own.** Both of these used to be `/dashboard`, so
   * somebody who had just paid landed on a product that knew nothing about it —
   * the entitlement is written by a reconciliation run seconds to minutes later.
   * Cancelling still goes back to the plans page, where pressing the button again
   * resumes the same session.
   */
  it("returns to this deployment's own pages", async () => {
    await start();

    const request = createSession.mock.calls[0][0];

    expect(request.successUrl).toBe(
      "https://app.example.invalid/dashboard/billing/return",
    );
    expect(request.cancelUrl).toBe(
      "https://app.example.invalid/dashboard/billing",
    );
  });

  /**
   * **Nothing about the account is in either address.** An id or an address in a
   * query string is something a caller can change and a browser history keeps.
   */
  it("puts nothing identifying in either address", async () => {
    await start();

    const request = createSession.mock.calls[0][0];

    for (const url of [request.successUrl, request.cancelUrl]) {
      expect(url).not.toContain("?");
      expect(url).not.toContain("@");
      expect(url).not.toContain(USER);
      expect(url).not.toMatch(/price_|cus_|sub_|cs_test|CHECKOUT_SESSION_ID/);
    }
  });

  /** Both are on this deployment's own origin: there is no redirect to hand out. */
  it("builds both from the deployment's origin", async () => {
    await start();

    const request = createSession.mock.calls[0][0];

    for (const url of [request.successUrl, request.cancelUrl]) {
      expect(new URL(url).origin).toBe("https://app.example.invalid");
    }
  });

  it.each(["", "   ", "mailto:someone@example.invalid"])(
    "creates nothing when AUTH_URL is %p",
    async (value) => {
      process.env.AUTH_URL = value;

      expect(await start()).toEqual({
        outcome: "malformed-config",
        reason: "no-return-url",
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(attemptCreate).not.toHaveBeenCalled();
    },
  );
});

describe("when the provider is not configured", () => {
  it.each(["no-secret-key", "no-price-catalogue", "bad-livemode-flag"])(
    "reports %s without writing anything",
    async (reason) => {
      const result = await start({ provider: { unavailable: reason } });

      expect(result).toEqual({ outcome: "unavailable", reason });
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(subscriptionFindUnique).not.toHaveBeenCalled();
    },
  );
});

describe("when creating the session fails", () => {
  /**
   * **The attempt is left `starting`.** Its id is the idempotency key, so the
   * next try asks for the same session — including when this failure was a
   * timeout and the session exists.
   */
  it("keeps the attempt so the next try replays", async () => {
    createSession.mockRejectedValue(new Error("stripe down"));

    expect(await start()).toEqual({ outcome: "provider-verification-unavailable" });
    expect(attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("says nothing of the cause", async () => {
    createSession.mockRejectedValue(new Error("card token cus_secret leaked"));

    expect(JSON.stringify(await start())).not.toContain("cus_secret");
  });

  /** The attempt was replaced while the provider was being called. */
  it("reports processing when the attempt has gone", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue(null);

    expect(await start()).toEqual({
      outcome: "payment-processing",
      attemptId: "attempt-1",
    });
  });
});

describe("what this module is not", () => {
  it("imports no provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout.ts", "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).toEqual([
      "@/lib/billing/checkout-attempt",
      "@/lib/entitlements/index",
      "@/lib/plans",
      "@/lib/prisma",
    ]);
  });

  it("writes to no table but the attempt's", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const model of [
      "subscription",
      "usagePeriod",
      "usageCounter",
      "billingEvent",
      "providerEventReceipt",
      "billingReconciliation",
      "routine",
      "user",
    ]) {
      for (const write of ["create", "update", "updateMany", "upsert", "delete"]) {
        expect(source, `writes ${model}.${write}`).not.toContain(`${model}.${write}`);
      }
    }
  });

  /** The webhook stays the only way a provider's doing reaches the domain. */
  it("does not reconcile, sweep, or invent an event", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "sweepBillingReconciliations",
      "runReconciliation",
      "reconcileProviderSubscription",
      "recordProviderEventReceipt",
      "activatePaidSubscription",
      "Stripe",
      "fetch(",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");

    expect(readFileSync("lib/billing/checkout.ts", "utf8")).toContain(
      'import "server-only"',
    );
  });
});
