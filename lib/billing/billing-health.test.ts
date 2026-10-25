import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When billing trouble is somebody's to act on.
 *
 * **Three findings, read after the sweep, from rows alone**: a provider that
 * cannot be used as configured, work owing for an hour, a checkout open for a
 * day. Everything a retry can fix stays out of it, and nothing is remembered
 * from one tick to the next.
 */

const pendingCount = vi.fn();
const pendingFindFirst = vi.fn();
const openCount = vi.fn();
const openFindFirst = vi.fn();

const clientStub = {
  billingReconciliation: { count: pendingCount, findFirst: pendingFindFirst },
  checkoutAttempt: { count: openCount, findFirst: openFindFirst },
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));

const {
  BILLING_CRITICAL_OPEN_CHECKOUT_AGE_MS,
  BILLING_CRITICAL_PENDING_AGE_MS,
  PROVIDER_CONFIG_OUTCOMES,
  evaluateBillingHealth,
} = await import("@/lib/billing/billing-health");

const NOW = new Date("2026-10-26T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function evaluate(
  outcomes: Record<string, number> = {},
  checkoutRecovery: Record<string, number> = {},
) {
  return evaluateBillingHealth({
    sweep: { outcomes, checkoutRecovery },
    now: NOW,
    client: clientStub as never,
  });
}

/**
 * A stub that answers the stale queries the way PostgreSQL would: a row counts
 * when its instant is at or before the cut-off the query asks for.
 */
function rowsAt(pending: Date[], open: { state: string; createdAt: Date }[]) {
  const cut = (where: { lte: Date }) => where.lte.getTime();

  pendingCount.mockImplementation(async ({ where }) =>
    pending.filter((at) => at.getTime() <= cut(where.pendingSince)).length,
  );
  pendingFindFirst.mockImplementation(async ({ where }) => {
    const stale = pending
      .filter((at) => at.getTime() <= cut(where.pendingSince))
      .sort((a, b) => a.getTime() - b.getTime());
    return stale.length === 0 ? null : { pendingSince: stale[0] };
  });
  openCount.mockImplementation(async ({ where }) =>
    open.filter((row) => row.state === where.state && row.createdAt.getTime() <= cut(where.createdAt))
      .length,
  );
  openFindFirst.mockImplementation(async ({ where }) => {
    const stale = open
      .filter((row) => row.state === where.state && row.createdAt.getTime() <= cut(where.createdAt))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return stale.length === 0 ? null : { createdAt: stale[0].createdAt };
  });
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeEach(() => {
  rowsAt([], []);
});

describe("the contract", () => {
  it("is an hour for owing work and a day for an open checkout", () => {
    expect(BILLING_CRITICAL_PENDING_AGE_MS).toBe(60 * MINUTE);
    expect(BILLING_CRITICAL_OPEN_CHECKOUT_AGE_MS).toBe(24 * HOUR);
  });

  it("names exactly the configuration outcomes the readers give", () => {
    expect([...PROVIDER_CONFIG_OUTCOMES]).toEqual([
      "no-secret-key",
      "no-price-catalogue",
      "no-livemode-flag",
      "bad-livemode-flag",
      "key-mode-mismatch",
      "unsupported-provider",
    ]);
  });

  it("asks for owing rows at or before an hour ago", async () => {
    await evaluate();

    expect(pendingCount.mock.calls[0][0].where).toEqual({
      pendingSince: { not: null, lte: ago(60 * MINUTE) },
    });
  });

  /** Open only: a starting attempt never sent anybody to pay; closed is done. */
  it("asks for open attempts at or before a day ago", async () => {
    await evaluate();

    expect(openCount.mock.calls[0][0].where).toEqual({
      state: "open",
      createdAt: { lte: ago(24 * HOUR) },
    });
  });
});

describe("a provider that cannot be used as configured", () => {
  it.each(PROVIDER_CONFIG_OUTCOMES)("is critical on %s in reconciliation", async (outcome) => {
    const health = await evaluate({ [outcome]: 1, applied: 3 });

    expect(health.critical).toBe(true);
    expect(health.findings["provider-config"]).toBe(1);
  });

  it("is critical on a configuration outcome in checkout recovery", async () => {
    const health = await evaluate({}, { "no-livemode-flag": 2 });

    expect(health.critical).toBe(true);
    expect(health.findings["provider-config"]).toBe(2);
  });

  it("adds both together", async () => {
    expect(
      (await evaluate({ "key-mode-mismatch": 1 }, { "key-mode-mismatch": 3 })).findings[
        "provider-config"
      ],
    ).toBe(4);
  });
});

/** Everything a retry can fix — or that is simply normal — stays healthy. */
describe("what is not critical on its own", () => {
  it.each([
    ["one unavailable read", { unavailable: 1 }, {}],
    ["every read unavailable this tick", { unavailable: 10 }, {}],
    ["one failure", { failed: 1 }, {}],
    ["a refusal", { refused: 1 }, {}],
    ["a mismatch", { "provider-domain-mismatch": 1 }, {}],
    ["normal contention", { "not-claimed": 1, "fenced-out": 1 }, {}],
    ["converged and superseded", { "already-converged": 2, "superseded-subscription": 1 }, {}],
    ["a payable checkout", {}, { payable: 1 }],
    ["an unreadable checkout", {}, { unreadable: 1 }],
    ["a failed checkout read", {}, { failed: 1 }],
    ["known, retried and lapsed checkouts", {}, { "already-known": 1, "close-retried": 1, "lapsed-closed": 1 }],
  ])("is healthy with %s", async (_label, outcomes, checkout) => {
    const health = await evaluate(outcomes, checkout);

    expect(health.critical).toBe(false);
    expect(health.findings).toEqual({
      "provider-config": 0,
      "stale-pending": 0,
      "stale-open-checkout": 0,
    });
  });
});

describe("work owing for an hour", () => {
  it.each([
    ["59m59s", 60 * MINUTE - 1000, false],
    ["exactly 60m", 60 * MINUTE, true],
    ["61m", 61 * MINUTE, true],
  ])("at %s is critical: %s", async (_label, age, critical) => {
    rowsAt([ago(age)], []);

    const health = await evaluate();

    expect(health.critical).toBe(critical);
    expect(health.findings["stale-pending"]).toBe(critical ? 1 : 0);
  });

  it("is critical when only one of several is old, and reports the oldest", async () => {
    rowsAt([ago(5 * MINUTE), ago(90 * MINUTE), ago(70 * MINUTE)], []);

    const health = await evaluate();

    expect(health.findings["stale-pending"]).toBe(2);
    expect(health.oldestStalePendingMs).toBe(90 * MINUTE);
  });

  it("is healthy with nothing owing", async () => {
    const health = await evaluate();

    expect(health.critical).toBe(false);
    expect(health.oldestStalePendingMs).toBeNull();
  });

  /** A tick where every read failed is not yet an hour of failing. */
  it("stays healthy when every read failed this tick but nothing is an hour old", async () => {
    rowsAt([ago(10 * MINUTE)], []);

    expect((await evaluate({ unavailable: 5 })).critical).toBe(false);
  });
});

describe("a checkout open for a day", () => {
  it.each([
    ["23h59m59s", 24 * HOUR - 1000, false],
    ["exactly 24h", 24 * HOUR, true],
    ["25h", 25 * HOUR, true],
  ])("at %s is critical: %s", async (_label, age, critical) => {
    rowsAt([], [{ state: "open", createdAt: ago(age) }]);

    expect((await evaluate()).critical).toBe(critical);
  });

  it.each(["closed", "starting"])("ignores a %s attempt however old", async (state) => {
    rowsAt([], [{ state, createdAt: ago(30 * 24 * HOUR) }]);

    expect((await evaluate()).critical).toBe(false);
  });

  it("reports how old the oldest is", async () => {
    rowsAt([], [{ state: "open", createdAt: ago(30 * HOUR) }]);

    const health = await evaluate();

    expect(health.findings["stale-open-checkout"]).toBe(1);
    expect(health.oldestStaleOpenCheckoutMs).toBe(30 * HOUR);
  });
});

/** Nothing is remembered: once the cause is gone, the next tick is healthy. */
describe("recovering", () => {
  it("is healthy again once the old work is answered", async () => {
    rowsAt([ago(2 * HOUR)], []);
    expect((await evaluate()).critical).toBe(true);

    rowsAt([], []);
    expect((await evaluate()).critical).toBe(false);
  });

  it("is healthy again once the old checkout is closed", async () => {
    rowsAt([], [{ state: "open", createdAt: ago(2 * 24 * HOUR) }]);
    expect((await evaluate()).critical).toBe(true);

    rowsAt([], [{ state: "closed", createdAt: ago(2 * 24 * HOUR) }]);
    expect((await evaluate()).critical).toBe(false);
  });

  it("is healthy again once the configuration is fixed", async () => {
    expect((await evaluate({ "no-livemode-flag": 1 })).critical).toBe(true);
    expect((await evaluate({ applied: 1 })).critical).toBe(false);
  });
});

/** Not knowing is not "fine": a failed query is left to throw. */
describe("when the check itself cannot run", () => {
  it.each([
    ["the owing count", () => pendingCount.mockRejectedValue(new Error("db down"))],
    ["the open checkout count", () => openCount.mockRejectedValue(new Error("db down"))],
  ])("throws when %s fails", async (_label, fail) => {
    fail();

    await expect(evaluate()).rejects.toThrow("db down");
  });
});
