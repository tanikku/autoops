import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What somebody coming back from a payment page is told.
 *
 * **The thing being fixed is a claim, not a query.** Arriving at the return
 * address means the provider redirected, and the entitlement is written seconds
 * to minutes later by a reconciliation run. So the tests below are mostly about
 * what this refuses to call a success: a granted allowance, a trial, a plan
 * nobody sells, and a subscription that landed somewhere other than active.
 */

const subscriptionFindUnique = vi.fn();
const checkoutAttemptFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscription: { findUnique: subscriptionFindUnique },
    checkoutAttempt: { findUnique: checkoutAttemptFindUnique },
  },
}));

const { readCheckoutReturnStatus } = await import(
  "@/lib/billing/checkout-return"
);

const USER = "116614511017733764020";
const NOW = new Date("2026-09-27T06:35:00.000Z");

/** A bought subscription, as the row reads after a purchase has landed. */
function paid(overrides: Record<string, unknown> = {}) {
  return {
    plan: "lite",
    state: "active",
    source: "stripe",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: new Date("2026-09-25T15:51:15.150Z"),
    currentPeriodStart: new Date("2026-09-27T06:34:36.000Z"),
    currentPeriodEnd: new Date("2026-10-27T06:34:36.000Z"),
    notificationWorkerId: null,
    expiresAt: null,
    ...overrides,
  };
}

/** The Closed Beta's allowance: active, on a plan, and nobody paid for it. */
function granted(overrides: Record<string, unknown> = {}) {
  return paid({
    plan: "beta",
    source: "admin",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    expiresAt: new Date("2026-12-31T23:59:59.000Z"),
    ...overrides,
  });
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    expiresAt: new Date("2026-09-28T00:32:59.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
  checkoutAttemptFindUnique.mockReset().mockResolvedValue(null);
});

const read = () => readCheckoutReturnStatus(USER, { now: NOW });

describe("when the purchase has landed", () => {
  it("says the bought plan is active", async () => {
    subscriptionFindUnique.mockResolvedValue(paid());

    await expect(read()).resolves.toEqual({ status: "active", plan: "lite" });
  });

  it.each(["lite", "standard", "pro"] as const)("names %s", async (plan) => {
    subscriptionFindUnique.mockResolvedValue(paid({ plan }));

    await expect(read()).resolves.toEqual({ status: "active", plan });
  });

  /** An attempt still open does not turn a landed purchase back into a wait. */
  it("says active even while an attempt is still open", async () => {
    subscriptionFindUnique.mockResolvedValue(paid());
    checkoutAttemptFindUnique.mockResolvedValue(attempt());

    await expect(read()).resolves.toEqual({ status: "active", plan: "lite" });
  });

  it("asks about this account and no other", async () => {
    await read();

    expect(subscriptionFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
    expect(checkoutAttemptFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });
});

/**
 * **Three facts make a success and every one is needed.** A state alone would
 * call a granted allowance and a trial purchases, and a plan alone would call a
 * lapsed subscription one.
 */
describe("what is not a purchase landing", () => {
  it("does not call the granted Closed Beta allowance one", async () => {
    subscriptionFindUnique.mockResolvedValue(granted());

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });

  it("does not call a trial one", async () => {
    subscriptionFindUnique.mockResolvedValue(
      paid({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-09-26T00:00:00.000Z"),
        trialEndsAt: new Date("2026-10-03T00:00:00.000Z"),
        trialForfeitedAt: null,
      }),
    );

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });

  /** Active, bought, and on a plan this build does not sell: still not. */
  it("does not accept a plan that cannot be bought", async () => {
    subscriptionFindUnique.mockResolvedValue(
      paid({ plan: "beta", source: "stripe", expiresAt: null }),
    );

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });

  it("does not call a lapsed subscription one", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });
});

/**
 * Behind on payment, and cancelled inside the period.
 *
 * **Neither is called a success and neither is called a failure.** The plans page
 * has precise wording for both; this screen sends people there rather than
 * inventing a second voice for the same facts. While the attempt is still open it
 * reads as a wait, because that is what is true from here.
 */
describe("a subscription that landed somewhere other than active", () => {
  it.each(["grace", "canceled_active"])(
    "does not report %s as active",
    async (state) => {
      subscriptionFindUnique.mockResolvedValue(paid({ state }));

      const status = await read();

      expect(status.status).not.toBe("active");
    },
  );

  it.each(["grace", "canceled_active"])(
    "sends %s to the plans page once nothing is in flight",
    async (state) => {
      subscriptionFindUnique.mockResolvedValue(paid({ state }));
      checkoutAttemptFindUnique.mockResolvedValue(attempt({ state: "closed" }));

      await expect(read()).resolves.toEqual({ status: "not-entitled" });
    },
  );

  it.each(["grace", "canceled_active"])(
    "keeps waiting on %s while a checkout is still open",
    async (state) => {
      subscriptionFindUnique.mockResolvedValue(paid({ state }));
      checkoutAttemptFindUnique.mockResolvedValue(attempt());

      await expect(read()).resolves.toEqual({ status: "pending" });
    },
  );
});

/**
 * The window this module exists for.
 *
 * **An inactive row is not a failed payment.** It is what the row said before the
 * purchase landed, and saying so would be reporting the past as an outcome.
 */
describe("while the purchase has not landed", () => {
  it("waits when a checkout is still open", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));
    checkoutAttemptFindUnique.mockResolvedValue(attempt());

    await expect(read()).resolves.toEqual({ status: "pending" });
  });

  it("waits when the attempt has not got its session yet", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));
    checkoutAttemptFindUnique.mockResolvedValue(attempt({ state: "starting" }));

    await expect(read()).resolves.toEqual({ status: "pending" });
  });

  it("waits for an account with no subscription row at all", async () => {
    checkoutAttemptFindUnique.mockResolvedValue(attempt());

    await expect(read()).resolves.toEqual({ status: "pending" });
  });

  /**
   * **An open attempt is not enough on its own to claim anything**, but without
   * one there is nothing to wait for either: somebody who typed this address gets
   * an answer rather than a page that waits out its whole budget.
   */
  it("does not wait when nothing is in flight", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });

  it("does not wait on a closed attempt", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));
    checkoutAttemptFindUnique.mockResolvedValue(attempt({ state: "closed" }));

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });

  it("does not wait on an attempt that has lapsed", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));
    checkoutAttemptFindUnique.mockResolvedValue(
      attempt({ expiresAt: new Date("2026-09-27T06:00:00.000Z") }),
    );

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });

  it("treats an attempt expiring exactly now as lapsed", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));
    checkoutAttemptFindUnique.mockResolvedValue(attempt({ expiresAt: NOW }));

    await expect(read()).resolves.toEqual({ status: "not-entitled" });
  });
});

describe("a row this version cannot read", () => {
  it("says so rather than guessing", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "renegotiating" }));

    await expect(read()).resolves.toEqual({ status: "unavailable" });
  });

  /** Unreadable wins over waiting: a wait would imply the row is understood. */
  it("says so even while an attempt is open", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "renegotiating" }));
    checkoutAttemptFindUnique.mockResolvedValue(attempt());

    await expect(read()).resolves.toEqual({ status: "unavailable" });
  });
});

describe("what leaves this module", () => {
  it("carries nothing but a status and a plan", async () => {
    subscriptionFindUnique.mockResolvedValue(paid());

    expect(Object.keys(await read()).sort()).toEqual(["plan", "status"]);
  });

  it.each([
    ["pending", () => checkoutAttemptFindUnique.mockResolvedValue(attempt())],
    ["not-entitled", () => undefined],
  ])("carries only a status for %s", async (_label, arrange) => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));
    arrange();

    expect(Object.keys(await read())).toEqual(["status"]);
  });
});

describe("what this module is not", () => {
  it("writes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-return.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const model of [
      "subscription",
      "checkoutAttempt",
      "usagePeriod",
      "usageCounter",
      "billingEvent",
      "routine",
      "user",
    ]) {
      for (const write of ["create", "update", "updateMany", "upsert", "delete"]) {
        expect(source, `writes ${model}.${write}`).not.toContain(
          `${model}.${write}`,
        );
      }
    }
  });

  /** No provider on any poll: what Stripe says arrives through the webhook. */
  it("reaches no provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-return.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "Stripe",
      "fetch(",
      "providers/",
      "startCheckout",
      "reconcile",
      "closeCheckoutAttempt",
      "sweep",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");

    expect(
      readFileSync("lib/billing/checkout-return.ts", "utf8"),
    ).toContain('import "server-only"');
  });
});
