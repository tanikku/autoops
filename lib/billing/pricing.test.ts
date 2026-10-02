import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a pricing screen reads, and that reading it changes nothing.
 *
 * **The standing here is a preview and the tests treat it as one.** What decides
 * a purchase is the count `startCheckout` takes under the account's lock; this
 * is the number a page shows so somebody can think about it first. The two are
 * deliberately separate, and the only thing they must agree on is the question
 * they ask — `status = "active"`, for this account.
 */

const subscriptionFindUnique = vi.fn();
const routineCount = vi.fn();
const checkoutAttemptFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscription: { findUnique: subscriptionFindUnique },
    routine: { count: routineCount },
    checkoutAttempt: { findUnique: checkoutAttemptFindUnique },
  },
}));

const { mayOfferPurchase, readPricingView } = await import(
  "@/lib/billing/pricing"
);

const USER = "116614511017733764020";

function row(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function paid(overrides: Record<string, unknown> = {}) {
  return row({
    plan: "lite",
    state: "active",
    source: "stripe",
    currentPeriodStart: new Date("2026-09-25T16:31:48.000Z"),
    currentPeriodEnd: new Date("2026-10-25T16:31:48.000Z"),
    expiresAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  subscriptionFindUnique.mockReset().mockResolvedValue(row());
  routineCount.mockReset().mockResolvedValue(0);
  checkoutAttemptFindUnique.mockReset().mockResolvedValue(null);
});

/** An attempt as the view reads it: only its state and when it lapses. */
function attempt(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

describe("which plans are priced", () => {
  it("lists exactly the three that can be bought", async () => {
    const view = await readPricingView(USER);

    expect(view.plans.map((plan) => plan.id)).toEqual([
      "lite",
      "standard",
      "pro",
    ]);
  });

  /** A price is a fact about selling, and this is the selling side. */
  it("names a monthly price for each", async () => {
    const view = await readPricingView(USER);

    expect(view.plans.map((plan) => plan.monthlyYen)).toEqual([780, 1480, 2480]);
  });

  /**
   * **The catalogue's own object, not a copy of its numbers.** A second table of
   * limits would be a second thing to change when one moves.
   */
  it("carries the catalogue's allowances", async () => {
    const view = await readPricingView(USER);
    const [lite, standard, pro] = view.plans;

    expect(lite.definition.activeWorkerLimit).toBe(2);
    expect(lite.definition.aiProcessingLimit).toBe(30);
    expect(lite.definition.email).toBe("one-worker");
    expect(lite.definition.history).toEqual({ kind: "days", days: 7 });

    expect(standard.definition.activeWorkerLimit).toBe(8);
    expect(pro.definition.activeWorkerLimit).toBe(15);
    expect(pro.definition.email).toBe("all-workers");
  });
});

describe("how the guardrail is previewed", () => {
  /** The same question the quota asks, down to the condition. */
  it("counts the account's active workers", async () => {
    await readPricingView(USER);

    expect(routineCount).toHaveBeenCalledWith({
      where: { userId: USER, status: "active" },
    });
  });

  it.each([
    [0, ["below-limit", "below-limit", "below-limit"]],
    [1, ["below-limit", "below-limit", "below-limit"]],
    [2, ["at-limit", "below-limit", "below-limit"]],
    [3, ["over-limit", "below-limit", "below-limit"]],
    [8, ["over-limit", "at-limit", "below-limit"]],
    [9, ["over-limit", "over-limit", "below-limit"]],
    [15, ["over-limit", "over-limit", "at-limit"]],
    [16, ["over-limit", "over-limit", "over-limit"]],
  ])("classifies %i active workers", async (active, expected) => {
    routineCount.mockResolvedValue(active);

    const view = await readPricingView(USER);

    expect(view.plans.map((plan) => plan.standing)).toEqual(expected);
    expect(view.activeWorkers).toBe(active);
  });
});

describe("what the account is on", () => {
  it("reports the granted allowance as a plan", async () => {
    const view = await readPricingView(USER);

    expect(view.current).toEqual({
      kind: "on-plan",
      plan: "beta",
      state: "active",
      purchased: false,
      entitled: true,
      adminGrantedBeta: true,
    });
  });

  /** Read from the row's own plan and source, never from what a screen shows. */
  it("marks the granted beta allowance, and nothing else, as admin-granted", async () => {
    expect((await readPricingView(USER)).current).toMatchObject({
      adminGrantedBeta: true,
    });

    subscriptionFindUnique.mockResolvedValue(paid());
    expect((await readPricingView(USER)).current).toMatchObject({
      adminGrantedBeta: false,
    });
  });

  /** Bought is read from `source`: a grant and a purchase can name one plan. */
  it("marks a bought plan as purchased", async () => {
    subscriptionFindUnique.mockResolvedValue(paid());

    const view = await readPricingView(USER);

    expect(view.current).toMatchObject({
      kind: "on-plan",
      plan: "lite",
      purchased: true,
    });
  });

  it("reports no plan when there is no row", async () => {
    subscriptionFindUnique.mockResolvedValue(null);

    const view = await readPricingView(USER);

    expect(view.current).toEqual({ kind: "none" });
  });

  /** A state written by a version that knew more is not guessed at. */
  it("reports a row it cannot read as unreadable", async () => {
    subscriptionFindUnique.mockResolvedValue(row({ state: "renegotiating" }));

    const view = await readPricingView(USER);

    expect(view.current).toEqual({ kind: "unreadable" });
  });

  it("reports an entitlement that has lapsed as not entitled", async () => {
    subscriptionFindUnique.mockResolvedValue(paid({ state: "inactive" }));

    const view = await readPricingView(USER);

    expect(view.current).toMatchObject({ state: "inactive", entitled: false });
  });
});

/**
 * Who is shown something to buy.
 *
 * **A paid entitlement is managed, not replaced.** Offering a plan to somebody
 * already paying would be offering them a second subscription — the same three
 * states `startCheckout` refuses.
 */
describe("whether a purchase may be offered", () => {
  it.each([
    ["no plan", { kind: "none" as const }, true],
    [
      "the granted allowance",
      {
        kind: "on-plan" as const,
        plan: "beta",
        state: "active",
        purchased: false,
        entitled: true,
        adminGrantedBeta: true,
      },
      false,
    ],
    [
      "a trial",
      {
        kind: "on-plan" as const,
        plan: "trial",
        state: "trialing",
        purchased: false,
        entitled: true,
        adminGrantedBeta: false,
      },
      true,
    ],
    [
      "a former paid plan",
      {
        kind: "on-plan" as const,
        plan: "lite",
        state: "inactive",
        purchased: true,
        entitled: false,
        adminGrantedBeta: false,
      },
      true,
    ],
    [
      "a live paid plan",
      {
        kind: "on-plan" as const,
        plan: "lite",
        state: "active",
        purchased: true,
        entitled: true,
        adminGrantedBeta: false,
      },
      false,
    ],
    [
      "one behind on payment",
      {
        kind: "on-plan" as const,
        plan: "lite",
        state: "grace",
        purchased: true,
        entitled: true,
        adminGrantedBeta: false,
      },
      false,
    ],
    [
      "one cancelling inside its period",
      {
        kind: "on-plan" as const,
        plan: "lite",
        state: "canceled_active",
        purchased: true,
        entitled: true,
        adminGrantedBeta: false,
      },
      false,
    ],
    ["a row it cannot read", { kind: "unreadable" as const }, false],
  ])("answers %s with %s", (_label, current, expected) => {
    expect(mayOfferPurchase(current)).toBe(expected);
  });

  /**
   * **The Closed Beta allowance is not offered a plan** while the beta runs,
   * live or expired — the same refusal `startCheckout` makes.
   */
  it.each(["active", "expired"])(
    "offers no plan to the granted beta allowance in %s",
    (state) => {
      expect(
        mayOfferPurchase({
          kind: "on-plan",
          plan: "beta",
          state,
          purchased: false,
          entitled: state === "active",
          adminGrantedBeta: true,
        }),
      ).toBe(false);
    },
  );
});

/**
 * Whether there is an unfinished checkout to mention.
 *
 * **Mentioning is all it is for.** Whether the slot may be taken again is the
 * orchestration's question, asked under the account's lock with the provider's
 * answer in hand — a page that decided it here would lock somebody who abandoned
 * a payment page out of trying again until the attempt's TTL.
 */
describe("whether a checkout is unfinished", () => {
  it("says no when there is no attempt", async () => {
    const view = await readPricingView(USER);

    expect(view.checkoutInProgress).toBe(false);
  });

  it("asks about this account's attempt", async () => {
    await readPricingView(USER);

    expect(checkoutAttemptFindUnique).toHaveBeenCalledWith({
      where: { userId: USER },
      select: { state: true, expiresAt: true },
    });
  });

  it.each(["starting", "open"])("says yes for an attempt in %s", async (state) => {
    checkoutAttemptFindUnique.mockResolvedValue(attempt({ state }));

    expect((await readPricingView(USER)).checkoutInProgress).toBe(true);
  });

  it("says no for one that was closed", async () => {
    checkoutAttemptFindUnique.mockResolvedValue(attempt({ state: "closed" }));

    expect((await readPricingView(USER)).checkoutInProgress).toBe(false);
  });

  /** A lapsed attempt holds nothing and explains nothing. */
  it("says no for one that has lapsed", async () => {
    checkoutAttemptFindUnique.mockResolvedValue(
      attempt({ expiresAt: new Date(Date.now() - 1000) }),
    );

    expect((await readPricingView(USER)).checkoutInProgress).toBe(false);
  });

  it("says no for a closed attempt that has also lapsed", async () => {
    checkoutAttemptFindUnique.mockResolvedValue(
      attempt({ state: "closed", expiresAt: new Date(Date.now() - 1000) }),
    );

    expect((await readPricingView(USER)).checkoutInProgress).toBe(false);
  });

  /** It says nothing about what may be bought: that answer is unchanged. */
  it("does not change whether a purchase may be offered", async () => {
    const without = mayOfferPurchase((await readPricingView(USER)).current);

    checkoutAttemptFindUnique.mockResolvedValue(attempt());

    const view = await readPricingView(USER);

    expect(mayOfferPurchase(view.current)).toBe(without);
  });

  /** Whatever plan the attempt was for, this is one boolean. */
  it("carries no plan and no identifier", async () => {
    checkoutAttemptFindUnique.mockResolvedValue(attempt());

    const view = await readPricingView(USER);

    expect(view.checkoutInProgress).toBe(true);
    expect(JSON.stringify(view)).not.toContain("attempt");
  });
});

describe("what this module is not", () => {
  it("writes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/pricing.ts", "utf8")
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

  it("reaches no provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/pricing.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "Stripe",
      "fetch(",
      "startCheckout",
      "beginCheckoutAttempt",
      "providers/",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");

    expect(readFileSync("lib/billing/pricing.ts", "utf8")).toContain(
      'import "server-only"',
    );
  });

  /** One copy of the prices, and this is it. */
  it("keeps each price written once", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/pricing.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const amount of ["780", "1480", "2480"]) {
      expect(source.match(new RegExp(amount, "g"))).toHaveLength(1);
    }
  });
});
