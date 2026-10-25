import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding a paid checkout that no delivery ever announced.
 *
 * **The case nothing else reaches.** A first purchase whose every subscription
 * event was lost leaves no reconciliation row, so neither a delivery nor the
 * periodic resync will ever read it — and the account, refused a second
 * checkout because its session is paid, waits indefinitely. What it does leave
 * is the attempt and the session it was paid through, which is enough to find
 * the subscription and hand it to the reconciliation everything else uses.
 */

const reconciliationFindMany = vi.fn();
const reconciliationUpdateMany = vi.fn();
const reconciliationCreate = vi.fn();
const attemptFindMany = vi.fn();
const attemptCount = vi.fn();
const attemptFindUnique = vi.fn();
const attemptUpdateMany = vi.fn();
const subscriptionFindUnique = vi.fn();
const runReconciliation = vi.fn();

const clientStub = {
  billingReconciliation: {
    findMany: reconciliationFindMany,
    updateMany: reconciliationUpdateMany,
    create: reconciliationCreate,
  },
  checkoutAttempt: {
    findMany: attemptFindMany,
    count: attemptCount,
    findUnique: attemptFindUnique,
    updateMany: attemptUpdateMany,
  },
  subscription: { findUnique: subscriptionFindUnique },
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));
vi.mock("@/lib/billing/orchestrate", () => ({ runReconciliation }));

const { sweepBillingReconciliations } = await import("@/lib/billing/sweeper");

const NOW = new Date("2026-10-25T12:00:00.000Z");
const MINUTE = 60 * 1000;

const readSession = vi.fn();
const sessions = { provider: "stripe", readSession };

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    userId: "user-1",
    plan: "lite",
    state: "open",
    providerCheckoutSessionId: "cs_test_paid",
    createdAt: new Date(NOW.getTime() - 20 * MINUTE),
    ...overrides,
  };
}

function sweep(options: Record<string, unknown> = {}) {
  return sweepBillingReconciliations({
    resolveReader: () => async () => ({ kind: "observed" }),
    client: clientStub as never,
    clock: () => NOW,
    newRunId: () => "run-1",
    checkoutSessions: () => sessions,
    random: () => 0,
    ...options,
  } as unknown as Parameters<typeof sweepBillingReconciliations>[0]);
}

beforeEach(() => {
  reconciliationFindMany.mockReset().mockResolvedValue([]);
  reconciliationUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  reconciliationCreate.mockReset().mockResolvedValue({});
  attemptFindMany.mockReset().mockResolvedValue([]);
  attemptCount.mockReset().mockResolvedValue(0);
  attemptFindUnique.mockReset().mockResolvedValue(null);
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
  runReconciliation
    .mockReset()
    .mockResolvedValue({ outcome: "reconciled", result: { outcome: "applied" }, receipts: 0 });
  readSession.mockReset().mockResolvedValue({
    kind: "paid",
    url: null,
    providerSubscriptionId: "sub_paid",
  });
});

describe("a first purchase whose every delivery was lost", () => {
  beforeEach(() => {
    attemptFindMany.mockResolvedValue([attempt()]);
    attemptCount.mockResolvedValue(1);
  });

  it("is found from its paid session and put in line, with nobody doing anything", async () => {
    await sweep();

    expect(readSession).toHaveBeenCalledWith("cs_test_paid");
    expect(reconciliationCreate).toHaveBeenCalledWith({
      data: { provider: "stripe", providerSubscriptionId: "sub_paid", pendingSince: NOW },
    });
  });

  it("then reaches the existing reconciliation on the next sweep", async () => {
    await sweep();

    // The row it created is owing, so the next sweep's first query returns it.
    reconciliationFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      (where.pendingSince as { not?: unknown } | null)?.not === null
        ? [{ provider: "stripe", providerSubscriptionId: "sub_paid" }]
        : [],
    );
    reconciliationCreate.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    await sweep();

    expect(runReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "stripe", providerSubscriptionId: "sub_paid" }),
    );
  });

  it("closes nothing and makes no session on the way", async () => {
    await sweep();

    expect(attemptUpdateMany).not.toHaveBeenCalled();
    expect(Object.keys(sessions)).toEqual(["provider", "readSession"]);
  });
});

const {
  CHECKOUT_RECOVERY_DELAY_MS,
  CHECKOUT_RECOVERY_LIMIT,
  recoverCheckouts,
  selectCheckoutRecoveryCandidates,
} = await import("@/lib/billing/checkout-recovery");
const { enqueueReconciliation } = await import("@/lib/billing/reconciliation-queue");

const uniqueViolation = () => Object.assign(new Error("unique"), { code: "P2002" });

/** Attempts in newest-first order, the way the selector asks for them. */
function rows(count: number) {
  return Array.from({ length: count }, (_, i) =>
    attempt({
      id: `attempt-${i}`,
      userId: `user-${i}`,
      providerCheckoutSessionId: `cs_test_${i}`,
      createdAt: new Date(NOW.getTime() - (20 + i) * MINUTE),
    }),
  );
}

/** A client whose findMany honours take/skip over the given newest-first rows. */
function serving(all: ReturnType<typeof rows>) {
  attemptFindMany.mockImplementation(async ({ skip = 0, take }: { skip?: number; take: number }) =>
    all.slice(skip, skip + take),
  );
  attemptCount.mockResolvedValue(all.length);
}

const select = (random: () => number = () => 0) =>
  selectCheckoutRecoveryCandidates(clientStub as never, NOW, random);

describe("the contract", () => {
  it("waits fifteen minutes and reads at most three", () => {
    expect(CHECKOUT_RECOVERY_DELAY_MS).toBe(15 * 60 * 1000);
    expect(CHECKOUT_RECOVERY_LIMIT).toBe(3);
  });

  it("asks only for open attempts with a session, fifteen minutes old or more", async () => {
    await select();

    expect(attemptFindMany.mock.calls[0][0].where).toEqual({
      state: "open",
      providerCheckoutSessionId: { not: null },
      createdAt: { lte: new Date(NOW.getTime() - 15 * MINUTE) },
    });
  });

  /**
   * The boundary is the query's: 14m59s is newer than the cut-off and so is
   * never returned, exactly 15m is at it and is, anything older is.
   */
  it.each([
    ["14m59s", 14 * MINUTE + 59_000, false],
    ["exactly 15m", 15 * MINUTE, true],
    ["16m", 16 * MINUTE, true],
  ])("treats an attempt %s old as eligible: %s", async (_label, age, eligible) => {
    await select();

    const cutoff = (attemptFindMany.mock.calls[0][0].where.createdAt as { lte: Date }).lte;
    const createdAt = new Date(NOW.getTime() - age);

    expect(createdAt.getTime() <= cutoff.getTime()).toBe(eligible);
  });

  /** Closed, starting and session-less attempts are excluded by the where. */
  it("never asks for closed, starting or session-less attempts", async () => {
    await select();

    const where = attemptFindMany.mock.calls[0][0].where;

    expect(where.state).toBe("open");
    expect(where.providerCheckoutSessionId).toEqual({ not: null });
  });

  it("orders newest first, with a stable tie-break", async () => {
    await select();

    expect(attemptFindMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });
});

describe("choosing which attempts to read (R3)", () => {
  it.each([
    [0, []],
    [1, ["attempt-0"]],
    [2, ["attempt-0", "attempt-1"]],
    [3, ["attempt-0", "attempt-1", "attempt-2"]],
  ])("takes all %i when there are three or fewer", async (count, ids) => {
    serving(rows(count));

    expect((await select()).map((c) => c.id)).toEqual(ids);
  });

  it("takes the newest two and one more when there are more", async () => {
    serving(rows(6));

    const chosen = (await select(() => 0.5)).map((c) => c.id);

    expect(chosen).toHaveLength(3);
    expect(chosen.slice(0, 2)).toEqual(["attempt-0", "attempt-1"]);
  });

  /** The random source decides which older attempt; every one is reachable. */
  it.each([
    [0, "attempt-2"],
    [0.25, "attempt-3"],
    [0.5, "attempt-4"],
    [0.75, "attempt-5"],
    [0.999, "attempt-5"],
  ])("lets the roaming slot reach any older attempt (random=%s)", async (r, id) => {
    serving(rows(6));

    expect((await select(() => r)).map((c) => c.id)[2]).toBe(id);
  });

  it("never gives the roaming slot to one of the newest two", async () => {
    serving(rows(6));

    for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
      const chosen = (await select(() => r)).map((c) => c.id);

      expect(new Set(chosen).size).toBe(chosen.length);
      expect(chosen.slice(2)).not.toContain("attempt-0");
      expect(chosen.slice(2)).not.toContain("attempt-1");
    }
  });

  /** An insert between the queries can shift the order; a repeat is dropped. */
  it("drops a roaming pick that repeats a newest one", async () => {
    const all = rows(4);
    attemptFindMany.mockResolvedValueOnce(all.slice(0, 2)).mockResolvedValueOnce([all[1]]);
    attemptCount.mockResolvedValue(4);

    expect((await select()).map((c) => c.id)).toEqual(["attempt-0", "attempt-1"]);
  });

  /**
   * **The N2O-F1 regression.** Three old attempts that will never settle no
   * longer hold every slot: a purchase that has just become eligible is newest,
   * and the newest are always read.
   */
  it("reads a newly eligible paid attempt despite three permanent old ones", async () => {
    const fresh = attempt({
      id: "attempt-fresh",
      userId: "user-fresh",
      providerCheckoutSessionId: "cs_test_fresh",
      createdAt: new Date(NOW.getTime() - 15 * MINUTE),
    });
    const blockers = rows(3).map((row, i) => ({
      ...row,
      id: `attempt-blocker-${i}`,
      createdAt: new Date(NOW.getTime() - (30 + i) * 24 * 60 * MINUTE),
    }));
    serving([fresh, ...blockers]);

    for (const r of [0, 0.5, 0.999]) {
      expect((await select(() => r)).map((c) => c.id)).toContain("attempt-fresh");
    }
  });
});

describe("putting a subscription in line", () => {
  it("creates an owing row when there is none", async () => {
    expect(await enqueueReconciliation("stripe", "sub_1", clientStub as never, NOW)).toBe(
      "created",
    );
    expect(reconciliationCreate).toHaveBeenCalledWith({
      data: { provider: "stripe", providerSubscriptionId: "sub_1", pendingSince: NOW },
    });
  });

  /** Owing or answered, an existing row is left exactly as it is. */
  it.each(["owing", "answered"])("leaves an %s row alone", async () => {
    reconciliationCreate.mockRejectedValue(uniqueViolation());

    expect(await enqueueReconciliation("stripe", "sub_1", clientStub as never, NOW)).toBe(
      "already-known",
    );
    expect(reconciliationUpdateMany).not.toHaveBeenCalled();
  });

  it("converges when two callers race to create it", async () => {
    reconciliationCreate.mockResolvedValueOnce({}).mockRejectedValueOnce(uniqueViolation());

    const results = await Promise.all([
      enqueueReconciliation("stripe", "sub_1", clientStub as never, NOW),
      enqueueReconciliation("stripe", "sub_1", clientStub as never, NOW),
    ]);

    expect(results.sort()).toEqual(["already-known", "created"]);
  });

  it("lets any other failure through", async () => {
    reconciliationCreate.mockRejectedValue(new Error("db down"));

    await expect(
      enqueueReconciliation("stripe", "sub_1", clientStub as never, NOW),
    ).rejects.toThrow("db down");
  });
});

const recover = (resolveReader: () => unknown = () => sessions) =>
  recoverCheckouts({
    client: clientStub as never,
    now: NOW,
    random: () => 0,
    resolveReader: resolveReader as never,
  });

describe("what happens to each attempt", () => {
  beforeEach(() => {
    serving([attempt()]);
    // closeSettledCheckoutAttempt reads the account's attempt by user.
    attemptFindUnique.mockResolvedValue({
      id: "attempt-1",
      plan: "lite",
      state: "open",
      createdAt: attempt().createdAt,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("when the session was paid", () => {
    it("puts an unknown subscription in line", async () => {
      expect(await recover()).toEqual(["enqueued"]);
    });

    it("adds nothing for a subscription that already has a row", async () => {
      reconciliationCreate.mockRejectedValue(uniqueViolation());

      expect(await recover()).toEqual(["already-known"]);
      expect(reconciliationUpdateMany).not.toHaveBeenCalled();
    });

    it("does not close the attempt — only the activation does", async () => {
      await recover();

      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });

    /** Nothing about the account is passed along: the provider says whose it is. */
    it("hands the queue the provider and the subscription and nothing else", async () => {
      await recover();

      expect(reconciliationCreate.mock.calls[0][0].data).toEqual({
        provider: "stripe",
        providerSubscriptionId: "sub_paid",
        pendingSince: NOW,
      });
    });

    it("puts nothing in line when the session names no subscription", async () => {
      readSession.mockResolvedValue({ kind: "paid", url: null, providerSubscriptionId: null });

      expect(await recover()).toEqual(["unreadable"]);
      expect(reconciliationCreate).not.toHaveBeenCalled();
    });

    it("leaves the attempt open when the queue cannot be written", async () => {
      reconciliationCreate.mockRejectedValue(new Error("db down"));

      expect(await recover()).toEqual(["failed"]);
      expect(attemptUpdateMany).not.toHaveBeenCalled();
    });
  });

  it("closes an attempt whose session lapsed, conditionally", async () => {
    readSession.mockResolvedValue({ kind: "lapsed", url: null });

    expect(await recover()).toEqual(["lapsed-closed"]);
    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", state: { not: "closed" } },
      data: { state: "closed" },
    });
  });

  /** Two sweeps both see the lapse: the conditional close makes one write. */
  it("converges when the lapsed attempt was already closed by another sweep", async () => {
    readSession.mockResolvedValue({ kind: "lapsed", url: null });
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue({ state: "closed" });

    expect(await recover()).toEqual(["lapsed-closed"]);
  });

  it.each([
    ["payable", { kind: "payable", url: "https://pay.example.invalid/1" }, "payable"],
    ["unreadable", { kind: "unreadable", url: null }, "unreadable"],
  ])("writes nothing when the session is %s", async (_label, state, outcome) => {
    readSession.mockResolvedValue(state);

    expect(await recover()).toEqual([outcome]);
    expect(attemptUpdateMany).not.toHaveBeenCalled();
    expect(reconciliationCreate).not.toHaveBeenCalled();
  });

  it("writes nothing when the provider cannot be asked, and says nothing of why", async () => {
    readSession.mockRejectedValue(
      Object.assign(new Error("No such checkout.session: cs_test_paid"), {
        name: "StripeInvalidRequestError",
      }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await recover()).toEqual(["failed"]);
    expect(attemptUpdateMany).not.toHaveBeenCalled();
    expect(reconciliationCreate).not.toHaveBeenCalled();
    expect(logged.mock.calls.flat().join(" ")).not.toContain("cs_test_paid");
  });

  it("goes on to the next attempt after one fails", async () => {
    serving(rows(2));
    readSession
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ kind: "paid", url: null, providerSubscriptionId: "sub_paid" });

    expect(await recover()).toEqual(["failed", "enqueued"]);
  });

  it("reads at most three sessions, however many attempts are eligible", async () => {
    serving(rows(9));

    await recover();

    expect(readSession).toHaveBeenCalledTimes(3);
  });

  it("builds no reader when nothing is eligible", async () => {
    serving([]);
    const resolve = vi.fn(() => sessions);

    expect(await recover(resolve)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reads nothing when the provider is not configured", async () => {
    expect(await recover(() => ({ unavailable: "no-livemode-flag" }))).toEqual([
      "no-livemode-flag",
    ]);
    expect(readSession).not.toHaveBeenCalled();
  });
});

/**
 * **N2O-F2: the close an activation failed to make.** Re-run only when the
 * activation is on record, and only through `closeSettledCheckoutAttempt` with
 * its own conditions — so nothing is closed that the activation would not have
 * closed.
 */
describe("retrying the close an activation left undone", () => {
  const activated = (overrides: Record<string, unknown> = {}) => ({
    source: "stripe",
    state: "active",
    plan: "lite",
    currentPeriodStart: new Date(NOW.getTime() - 10 * MINUTE),
    providerSubscriptionId: "sub_paid",
    ...overrides,
  });

  const stored = () => ({
    id: "attempt-1",
    plan: "lite",
    state: "open",
    createdAt: attempt().createdAt,
  });

  beforeEach(() => {
    serving([attempt()]);
    attemptFindUnique.mockResolvedValue(stored());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("closes it and reads no session", async () => {
    subscriptionFindUnique.mockResolvedValue(activated());

    expect(await recover()).toEqual(["close-retried"]);
    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", state: { not: "closed" } },
      data: { state: "closed" },
    });
    expect(readSession).not.toHaveBeenCalled();
  });

  it("converges when something else closed it first", async () => {
    subscriptionFindUnique.mockResolvedValue(activated());
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValueOnce(stored()).mockResolvedValue({ state: "closed" });

    expect(await recover()).toEqual(["already-closed"]);
    expect(readSession).not.toHaveBeenCalled();
  });

  it("leaves it open when the close fails, for the next sweep", async () => {
    subscriptionFindUnique.mockResolvedValue(activated());
    attemptUpdateMany.mockRejectedValue(new Error("db down"));

    expect(await recover()).toEqual(["failed"]);
    expect(readSession).not.toHaveBeenCalled();
  });

  /** Not this close's to make: the session is read instead, and nothing closed. */
  it.each([
    ["a different plan", activated({ plan: "pro" })],
    ["no subscription", null],
    ["a subscription not bought", activated({ source: "trial" })],
    ["no activation yet", activated({ state: "inactive" })],
    ["grace rather than active", activated({ state: "grace" })],
    ["no provider subscription", activated({ providerSubscriptionId: null })],
    ["no period start", activated({ currentPeriodStart: null })],
  ])("does not close it with %s", async (_label, subscription) => {
    subscriptionFindUnique.mockResolvedValue(subscription);
    reconciliationCreate.mockRejectedValue(uniqueViolation());

    const outcomes = await recover();

    expect(outcomes).toEqual(["already-known"]);
    expect(attemptUpdateMany).not.toHaveBeenCalled();
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  /** An attempt taken after the period began is a later purchase. */
  it("does not close an attempt newer than the subscription's period", async () => {
    subscriptionFindUnique.mockResolvedValue(
      activated({ currentPeriodStart: new Date(NOW.getTime() - 60 * MINUTE) }),
    );
    reconciliationCreate.mockRejectedValue(uniqueViolation());

    expect(await recover()).toEqual(["already-known"]);
    expect(attemptUpdateMany).not.toHaveBeenCalled();
  });
});

/** The duplicate-checkout guard and the recovery do not get in each other's way. */
describe("alongside the checkout guard", () => {
  it("never makes a session: the reader can only read", async () => {
    serving([attempt()]);

    await recover();

    expect(Object.keys(sessions)).toEqual(["provider", "readSession"]);
    expect(attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("is last in the sweep and reported apart from reconciliation", async () => {
    serving([attempt()]);
    reconciliationFindMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        (where.pendingSince as { not?: unknown } | null)?.not === null
          ? [{ provider: "stripe", providerSubscriptionId: "sub_other" }]
          : [],
    );

    const summary = await sweep();

    expect(runReconciliation.mock.invocationCallOrder[0]).toBeLessThan(
      readSession.mock.invocationCallOrder[0],
    );
    expect(summary.examined).toBe(1);
    expect(summary.sources).toEqual({ pending: 1, "checkout-recovery": 1 });
    expect(summary.checkoutRecovery).toEqual({ enqueued: 1 });
  });

  it("is skipped entirely when the sweep is given no session reader", async () => {
    serving([attempt()]);

    const summary = await sweep({ checkoutSessions: undefined });

    expect(attemptFindMany).not.toHaveBeenCalled();
    expect(summary.checkoutRecovery).toEqual({});
  });
});
