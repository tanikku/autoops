import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which attempt an account gets, against a fake client.
 *
 * **The contended case is not here.** Whether two racing inserts leave one row
 * is a property of a unique index against a real server, and that index was
 * exercised against PostgreSQL 17 when the migration was verified — a duplicate
 * `userId` was refused and a cascade delete removed the attempt with its
 * account. What is fixed here is the shape that makes the index matter: that
 * the account is locked before the row is read, that a lost race is answered
 * rather than raised, and that every reuse decision says what it is deciding.
 *
 * **Nothing here touches a provider.** There is no Stripe mock because there is
 * nothing to mock: the module under test imports none.
 */

const userUpdate = vi.fn();
const attemptFindUnique = vi.fn();
const attemptCreate = vi.fn();
const attemptDelete = vi.fn();
const attemptUpdateMany = vi.fn();
const transaction = vi.fn();

const clientStub = {
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
  CHECKOUT_ATTEMPT_TTL_MS,
  CheckoutSessionConflict,
  UnreadableCheckoutAttempt,
  beginCheckoutAttempt,
  checkoutAttemptPlans,
  checkoutAttemptStates,
  closeCheckoutAttempt,
  isCheckoutAttemptPlan,
  isCheckoutAttemptState,
  markCheckoutAttemptOpen,
} = await import("@/lib/billing/checkout-attempt");

const USER = "user-1";
const NOW = new Date("2026-09-27T00:00:00.000Z");

/** A stored row, defaulting to one that is live and for `lite`. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-old",
    plan: "lite",
    state: "starting",
    providerCheckoutSessionId: null,
    expiresAt: new Date(NOW.getTime() + CHECKOUT_ATTEMPT_TTL_MS),
    ...overrides,
  };
}

function begin(overrides: Record<string, unknown> = {}) {
  return beginCheckoutAttempt({
    userId: USER,
    plan: "lite",
    now: NOW,
    ...overrides,
  } as Parameters<typeof beginCheckoutAttempt>[0]);
}

beforeEach(() => {
  userUpdate.mockReset().mockResolvedValue({ id: USER });
  attemptFindUnique.mockReset().mockResolvedValue(null);
  attemptDelete.mockReset().mockResolvedValue({});
  attemptUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  attemptCreate
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "attempt-new",
      plan: data.plan,
      state: data.state,
      providerCheckoutSessionId: null,
      expiresAt: data.expiresAt,
    }));
  // The stub is handed its own `run`, so every test exercises the same path a
  // real transaction would.
  transaction.mockReset().mockImplementation(async (run: (tx: unknown) => unknown) =>
    run(clientStub),
  );
});

describe("what a plan and a state may be", () => {
  /** `trial` and `beta` cannot be bought: one is begun, the other is granted. */
  it("sells three plans and not the other two", () => {
    expect([...checkoutAttemptPlans]).toEqual(["lite", "standard", "pro"]);
    expect(isCheckoutAttemptPlan("lite")).toBe(true);
    expect(isCheckoutAttemptPlan("trial")).toBe(false);
    expect(isCheckoutAttemptPlan("beta")).toBe(false);
    expect(isCheckoutAttemptPlan("")).toBe(false);
    expect(isCheckoutAttemptPlan(undefined)).toBe(false);
  });

  it("has three coordination states", () => {
    expect([...checkoutAttemptStates]).toEqual(["starting", "open", "closed"]);
    expect(isCheckoutAttemptState("open")).toBe(true);
    expect(isCheckoutAttemptState("complete")).toBe(false);
  });

  /** Longer than the session it guards, shorter than the provider's replay. */
  it("holds the slot for eighteen hours", () => {
    expect(CHECKOUT_ATTEMPT_TTL_MS).toBe(18 * 60 * 60 * 1000);
    expect(CHECKOUT_ATTEMPT_TTL_MS).toBeGreaterThan(12 * 60 * 60 * 1000);
    expect(CHECKOUT_ATTEMPT_TTL_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });
});

describe("starting one where there is none", () => {
  it("creates an attempt", async () => {
    const result = await begin();

    expect(result).toMatchObject({
      outcome: "attempt",
      disposition: "created",
      attempt: { id: "attempt-new", plan: "lite", state: "starting" },
    });
  });

  it("opens the slot for eighteen hours from now", async () => {
    await begin();

    expect(attemptCreate.mock.calls[0][0].data.expiresAt).toEqual(
      new Date(NOW.getTime() + CHECKOUT_ATTEMPT_TTL_MS),
    );
  });

  it("starts with no session of its own", async () => {
    const result = await begin();

    expect(
      (result as { attempt: { providerCheckoutSessionId: string | null } })
        .attempt.providerCheckoutSessionId,
    ).toBeNull();
  });

  /**
   * **The lock comes first, before anything is read.** Reading and then
   * replacing is a check-then-act, and two requests would otherwise both read
   * "expired" and both insert.
   */
  it("takes the account's row before reading the attempt", async () => {
    await begin();

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: USER },
      data: { id: USER },
    });
    expect(userUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      attemptFindUnique.mock.invocationCallOrder[0],
    );
  });

  /** `data: {}` takes no lock — Prisma turns it into a `SELECT`. */
  it("locks with a real update rather than an empty one", async () => {
    await begin();

    expect(userUpdate.mock.calls[0][0].data).toEqual({ id: USER });
  });
});

describe("joining one that is already in progress", () => {
  it("reuses a starting attempt for the same plan, with its id", async () => {
    attemptFindUnique.mockResolvedValue(stored());

    const result = await begin();

    expect(result).toEqual({
      outcome: "attempt",
      disposition: "resumed-starting",
      attempt: expect.objectContaining({ id: "attempt-old", state: "starting" }),
    });
    expect(attemptCreate).not.toHaveBeenCalled();
    expect(attemptDelete).not.toHaveBeenCalled();
  });

  /**
   * **The same id is the whole point.** The provider's idempotency key is built
   * from it, so a retry that keeps the id resolves to the session the first
   * call created rather than a second one.
   */
  it("reuses an open attempt and reports its session", async () => {
    attemptFindUnique.mockResolvedValue(
      stored({ state: "open", providerCheckoutSessionId: "cs_test_1" }),
    );

    const result = await begin();

    expect(result).toEqual({
      outcome: "attempt",
      disposition: "resumed-open",
      attempt: expect.objectContaining({
        id: "attempt-old",
        state: "open",
        providerCheckoutSessionId: "cs_test_1",
      }),
    });
    expect(attemptCreate).not.toHaveBeenCalled();
  });
});

describe("replacing one that no longer counts", () => {
  it.each([
    ["closed", stored({ state: "closed" })],
    [
      "lapsed",
      stored({ expiresAt: new Date(NOW.getTime() - 1) }),
    ],
    [
      "lapsed exactly now",
      stored({ expiresAt: new Date(NOW.getTime()) }),
    ],
    [
      "closed and lapsed",
      stored({ state: "closed", expiresAt: new Date(NOW.getTime() - 1) }),
    ],
  ])("replaces a %s attempt", async (_label, row) => {
    attemptFindUnique.mockResolvedValue(row);

    const result = await begin();

    expect(result).toMatchObject({ outcome: "attempt", disposition: "replaced" });
    expect(attemptDelete).toHaveBeenCalledWith({ where: { id: "attempt-old" } });
  });

  /**
   * **A new attempt is a new id, always.** Rewriting the primary key would
   * carry the old attempt's idempotency key into a request with different
   * parameters, which the provider refuses outright.
   */
  it("gives the replacement a different id", async () => {
    attemptFindUnique.mockResolvedValue(stored({ state: "closed" }));

    const result = await begin();
    const id = (result as { attempt: { id: string } }).attempt.id;

    expect(id).toBe("attempt-new");
    expect(id).not.toBe("attempt-old");
    // The old row is removed and a new one written, rather than the old one
    // being updated in place.
    expect(attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("deletes the old row before writing the new one", async () => {
    attemptFindUnique.mockResolvedValue(stored({ state: "closed" }));

    await begin();

    expect(attemptDelete.mock.invocationCallOrder[0]).toBeLessThan(
      attemptCreate.mock.invocationCallOrder[0],
    );
  });

  /** An expired attempt raises no question about which plan was meant. */
  it("replaces a lapsed attempt for another plan without asking", async () => {
    attemptFindUnique.mockResolvedValue(
      stored({ plan: "pro", expiresAt: new Date(NOW.getTime() - 1) }),
    );

    const result = await begin({ plan: "standard" });

    expect(result).toMatchObject({ outcome: "attempt", disposition: "replaced" });
    expect(attemptCreate.mock.calls[0][0].data.plan).toBe("standard");
  });
});

/**
 * Wanting a different plan partway through.
 *
 * **Never replaced silently.** The account may be looking at a payment page for
 * the other plan right now; discarding it would be deciding which purchase they
 * meant. What follows is a separate flow — confirm, expire the provider's
 * session, close the attempt, begin a new one.
 */
describe("when a live attempt is for another plan", () => {
  it.each(["starting", "open"])(
    "asks rather than replacing a %s attempt",
    async (state) => {
      attemptFindUnique.mockResolvedValue(stored({ plan: "lite", state }));

      const result = await begin({ plan: "pro" });

      expect(result).toEqual({
        outcome: "plan-switch-required",
        attempt: expect.objectContaining({ plan: "lite" }),
      });
      expect(attemptCreate).not.toHaveBeenCalled();
      expect(attemptDelete).not.toHaveBeenCalled();
    },
  );

  it("reports the attempt that is in the way", async () => {
    attemptFindUnique.mockResolvedValue(
      stored({ plan: "standard", state: "open", providerCheckoutSessionId: "cs_test_2" }),
    );

    const result = await begin({ plan: "lite" });

    expect(result).toEqual({
      outcome: "plan-switch-required",
      attempt: expect.objectContaining({
        plan: "standard",
        providerCheckoutSessionId: "cs_test_2",
      }),
    });
  });
});

/**
 * Two requests arriving together.
 *
 * The lock serialises them, so the second reads the first's row. If a caller
 * passed a client with no transaction, the unique index catches it instead —
 * and a lost race is an answer rather than a failure.
 */
describe("when two begins race", () => {
  it("answers with the attempt the winner created", async () => {
    const violation = Object.assign(new Error("unique"), { code: "P2002" });
    attemptCreate.mockRejectedValue(violation);
    attemptFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(stored({ id: "attempt-winner" }));

    const result = await begin();

    expect(result).toEqual({
      outcome: "attempt",
      disposition: "resumed-starting",
      attempt: expect.objectContaining({ id: "attempt-winner" }),
    });
  });

  it("reports a plan switch when the winner wanted another plan", async () => {
    const violation = Object.assign(new Error("unique"), { code: "P2002" });
    attemptCreate.mockRejectedValue(violation);
    attemptFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(stored({ id: "attempt-winner", plan: "pro" }));

    const result = await begin({ plan: "lite" });

    expect(result).toMatchObject({ outcome: "plan-switch-required" });
  });

  /** Any other failure is the caller's to see. */
  it("does not swallow a failure that is not a lost race", async () => {
    attemptCreate.mockRejectedValue(new Error("connection lost"));

    await expect(begin()).rejects.toThrow("connection lost");
  });
});

/**
 * A row this version cannot read.
 *
 * **Refused rather than guessed at.** Treating an unknown state as closed would
 * discard a checkout somebody may be partway through; treating it as open would
 * send them to a session that may not exist.
 */
describe("when a stored attempt makes no sense", () => {
  it.each([
    ["an unknown state", stored({ state: "paid" })],
    ["an unknown plan", stored({ plan: "enterprise" })],
  ])("refuses %s", async (_label, row) => {
    attemptFindUnique.mockResolvedValue(row);

    await expect(begin()).rejects.toThrow(UnreadableCheckoutAttempt);
  });
});

describe("recording the session an attempt is paid through", () => {
  it("names the session and turns the attempt open", async () => {
    const result = await markCheckoutAttemptOpen({
      attemptId: "attempt-1",
      providerCheckoutSessionId: "cs_test_1",
    });

    expect(result).toEqual({ outcome: "opened" });
    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "attempt-1",
        state: "starting",
        providerCheckoutSessionId: null,
      },
      data: { state: "open", providerCheckoutSessionId: "cs_test_1" },
    });
  });

  /**
   * **The condition is on the row, not on a read beforehand.** A stale caller
   * cannot overwrite an attempt that has moved on, because the `UPDATE` it
   * issues matches nothing.
   */
  it("asks for a starting attempt with no session yet", async () => {
    await markCheckoutAttemptOpen({
      attemptId: "attempt-1",
      providerCheckoutSessionId: "cs_test_1",
    });

    expect(attemptUpdateMany.mock.calls[0][0].where).toMatchObject({
      state: "starting",
      providerCheckoutSessionId: null,
    });
  });

  /** A retry after a crash arrives with the session already recorded. */
  it("is a success when the same session is recorded twice", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue(
      stored({ id: "attempt-1", state: "open", providerCheckoutSessionId: "cs_test_1" }),
    );

    const result = await markCheckoutAttemptOpen({
      attemptId: "attempt-1",
      providerCheckoutSessionId: "cs_test_1",
    });

    expect(result).toEqual({ outcome: "already-open" });
  });

  /** Two sessions for one attempt is two ways to pay for the same thing. */
  it("refuses a different session on the same attempt", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue(
      stored({ id: "attempt-1", state: "open", providerCheckoutSessionId: "cs_test_1" }),
    );

    await expect(
      markCheckoutAttemptOpen({
        attemptId: "attempt-1",
        providerCheckoutSessionId: "cs_test_other",
      }),
    ).rejects.toThrow(CheckoutSessionConflict);
  });

  it("says so when the attempt has gone", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue(null);

    expect(
      await markCheckoutAttemptOpen({
        attemptId: "attempt-1",
        providerCheckoutSessionId: "cs_test_1",
      }),
    ).toEqual({ outcome: "not-found" });
  });

  /** A closed attempt is not one to open: the update matches nothing. */
  it("refuses to reopen a closed attempt", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue(
      stored({ id: "attempt-1", state: "closed", providerCheckoutSessionId: null }),
    );

    await expect(
      markCheckoutAttemptOpen({
        attemptId: "attempt-1",
        providerCheckoutSessionId: "cs_test_1",
      }),
    ).rejects.toThrow(CheckoutSessionConflict);
  });
});

describe("giving up an attempt", () => {
  it.each(["starting", "open"])("closes a %s attempt", async () => {
    const result = await closeCheckoutAttempt({ attemptId: "attempt-1" });

    expect(result).toEqual({ outcome: "closed" });
    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", state: { not: "closed" } },
      data: { state: "closed" },
    });
  });

  it("writes nothing when it is already closed", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue({ state: "closed" });

    expect(await closeCheckoutAttempt({ attemptId: "attempt-1" })).toEqual({
      outcome: "already-closed",
    });
  });

  it("says so when the attempt has gone", async () => {
    attemptUpdateMany.mockResolvedValue({ count: 0 });
    attemptFindUnique.mockResolvedValue(null);

    expect(await closeCheckoutAttempt({ attemptId: "attempt-1" })).toEqual({
      outcome: "not-found",
    });
  });

  /**
   * **Closed, not deleted.** Replacing is `beginCheckoutAttempt`'s to do, so
   * one place decides what replacing looks like — and a close that raced a
   * begin cannot leave the account with no row at all.
   */
  it("leaves the row in place", async () => {
    await closeCheckoutAttempt({ attemptId: "attempt-1" });

    expect(attemptDelete).not.toHaveBeenCalled();
  });

  /** Coordination has no use for the session id; reading a log afterwards does. */
  it("keeps the session it was paid through", async () => {
    await closeCheckoutAttempt({ attemptId: "attempt-1" });

    expect(attemptUpdateMany.mock.calls[0][0].data).toEqual({ state: "closed" });
  });
});

describe("what this module is not", () => {
  it("writes to no table but its own", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-attempt.ts", "utf8")
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
    ]) {
      for (const write of ["create", "update", "updateMany", "upsert", "delete"]) {
        expect(source, `writes ${model}.${write}`).not.toContain(
          `${model}.${write}`,
        );
      }
    }
  });

  /**
   * **`User` is locked and never changed.** The self-assignment produces an
   * `UPDATE` that holds the row and alters nothing — the one write to another
   * table this module makes, and the same one `lib/worker-quota.ts` makes.
   */
  it("touches the account only to lock it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-attempt.ts", "utf8");

    expect(source).toContain(
      "client.user.update({ where: { id: userId }, data: { id: userId } })",
    );
    expect(source).not.toContain("user.create");
    expect(source).not.toContain("user.delete");
  });

  /** Nothing is asked of a provider here, and nothing can be. */
  it("knows nothing about any provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-attempt.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "stripe",
      "Stripe",
      "fetch(",
      "providers/",
      "sweeper",
      "reconcile",
      "webhook",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-attempt.ts", "utf8");

    expect(source).toContain('import "server-only"');
  });

  /** The eighteen hours is written once, so there is nowhere to drift. */
  it("keeps its one duration in one place", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-attempt.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source.match(/18 \* 60 \* 60 \* 1000/g)).toHaveLength(1);
  });
});
