import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidSubscriptionError,
  isSubscriptionState,
  subscriptionStates,
} from "@/lib/entitlements/states";
import type { SubscriptionRecord } from "@/lib/entitlements/types";
import { UnknownPlanError } from "@/lib/plans";

/**
 * What an account may do, and when the clock changes the answer.
 *
 * **Every one of these holds a row and an instant, and nothing else.** Three of
 * the eight states are the clock's opinion about a stored row, so a boundary
 * checked against `new Date()` would be checked properly once a day by
 * accident. `now` is an argument for exactly that reason.
 *
 * **None of this is enforced.** Nothing that runs a worker imports this module,
 * and an account reading `entitled: false` here is an account whose workers ran
 * this morning and will run again tonight. Saying so in the tests is the point:
 * what is fixed is the answer, not a consequence.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { subscription: { findUnique } },
}));

const { computeEntitlement, getEffectiveEntitlement, NO_ENTITLEMENT } =
  await import("@/lib/entitlements/index");

const NOW = new Date("2026-09-20T12:00:00.000Z");
const EARLIER = new Date("2026-09-20T11:59:59.999Z");
const LATER = new Date("2026-09-20T12:00:00.001Z");
const USER = "google-sub-1";

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    plan: "standard",
    state: "active",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    notificationWorkerId: null,
    source: "stripe",
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  findUnique.mockReset();
});

describe("an account with no entitlement", () => {
  /**
   * **Not a missing row.** Rows appear when a trial starts or a plan is bought;
   * an account that has done neither is complete. Provisioning one to make this
   * tidier would turn signing in into a billing event.
   */
  it("is an ordinary state rather than an error", () => {
    expect(computeEntitlement(null, NOW)).toEqual(NO_ENTITLEMENT);
  });

  it("has no plan and no allowances", () => {
    const entitlement = computeEntitlement(null, NOW);

    expect(entitlement.state).toBe("none");
    expect(entitlement.entitled).toBe(false);
    expect(entitlement.plan).toBeNull();
    // Null rather than zeroes: an account with no entitlement has no
    // allowances, which is not the same as allowances of nothing.
    expect(entitlement.limits).toBeNull();
  });
});

describe("a trial", () => {
  const trialing = (endsAt: Date) =>
    record({
      plan: "trial",
      state: "trialing",
      source: "trial",
      trialStartedAt: new Date("2026-09-06T12:00:00.000Z"),
      trialEndsAt: endsAt,
      trialConsumedAt: new Date("2026-09-06T12:00:00.000Z"),
    });

  it("entitles while it is running", () => {
    const entitlement = computeEntitlement(trialing(LATER), NOW);

    expect(entitlement.state).toBe("trialing");
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.limits?.aiProcessingLimit).toBe(50);
  });

  /**
   * **The boundary is inclusive of the end**, the same rule the hourly
   * allowances use. An instant that is exactly the end is outside, not the last
   * moment inside.
   */
  it("is over at the instant it ends", () => {
    const entitlement = computeEntitlement(trialing(NOW), NOW);

    expect(entitlement.state).toBe("trial_expired");
    expect(entitlement.entitled).toBe(false);
  });

  it("is still running a millisecond before", () => {
    expect(computeEntitlement(trialing(NOW), EARLIER).entitled).toBe(true);
  });

  /**
   * **What a trial allowed is still reported after it ends.** A screen saying
   * why somebody stopped being able to do something has to be able to say what
   * they had.
   */
  it("still says what it allowed once it is over", () => {
    const entitlement = computeEntitlement(trialing(NOW), LATER);

    expect(entitlement.entitled).toBe(false);
    expect(entitlement.limits?.activeWorkerLimit).toBe(3);
    expect(entitlement.trial?.consumed).toBe(true);
  });

  /** A trial that cannot say when it ends cannot be read at all. */
  it("is unreadable without an end", () => {
    expect(() =>
      computeEntitlement(record({ plan: "trial", state: "trialing" }), NOW),
    ).toThrow(InvalidSubscriptionError);
  });
});

describe("a paid entitlement", () => {
  it("entitles while active", () => {
    const entitlement = computeEntitlement(record(), NOW);

    expect(entitlement.state).toBe("active");
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.plan).toBe("standard");
  });

  /**
   * **Grace keeps access, deliberately.** It means a payment is in question,
   * and stopping somebody's workers while their card is re-authorised punishes
   * the wrong thing. What ends access is the state that follows if it is never
   * sorted out.
   */
  it("keeps access during grace", () => {
    const entitlement = computeEntitlement(record({ state: "grace" }), NOW);

    expect(entitlement.state).toBe("grace");
    expect(entitlement.entitled).toBe(true);
  });

  it("keeps access after cancelling, until the period paid for ends", () => {
    const cancelled = record({
      state: "canceled_active",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: LATER,
    });

    expect(computeEntitlement(cancelled, NOW).entitled).toBe(true);
    expect(computeEntitlement(cancelled, LATER).entitled).toBe(false);
    expect(computeEntitlement(cancelled, LATER).state).toBe("inactive");
  });

  /** A cancellation that never takes effect is not a cancellation. */
  it("is unreadable when a cancellation names no end", () => {
    expect(() =>
      computeEntitlement(record({ state: "canceled_active" }), NOW),
    ).toThrow(InvalidSubscriptionError);
  });

  it("entitles nothing once inactive", () => {
    const entitlement = computeEntitlement(record({ state: "inactive" }), NOW);

    expect(entitlement.state).toBe("inactive");
    expect(entitlement.entitled).toBe(false);
    // The plan is still reported: what somebody had is what a support question
    // is about.
    expect(entitlement.plan).toBe("standard");
  });
});

describe("a granted beta entitlement", () => {
  const beta = (expiresAt: Date) =>
    record({ plan: "beta", state: "active", source: "admin", expiresAt });

  it("entitles until the day it was granted until", () => {
    const entitlement = computeEntitlement(beta(LATER), NOW);

    expect(entitlement.state).toBe("active");
    expect(entitlement.entitled).toBe(true);
    expect(entitlement.limits?.activeWorkerLimit).toBe(10);
    expect(entitlement.expiresAt).toEqual(LATER);
  });

  /**
   * **An expiry that has passed ends it whatever the state says**, and nothing
   * has to run for that to be true. A job that rewrote the column would leave a
   * window in which the row said active and meant nothing of the kind.
   */
  it("stops at the instant it expires, with the column untouched", () => {
    const entitlement = computeEntitlement(beta(NOW), NOW);

    expect(entitlement.state).toBe("expired");
    expect(entitlement.entitled).toBe(false);
  });

  it("is still granted a millisecond before", () => {
    expect(computeEntitlement(beta(NOW), EARLIER).entitled).toBe(true);
  });
});

describe("a row this version cannot read", () => {
  /**
   * **Refused rather than treated as nothing.** An unreadable row is not an
   * account without an entitlement: reading it as one would take away what
   * somebody paid for, and no screen would say so.
   */
  it.each(["past_due", "ACTIVE", "trial_expired", "none", ""])(
    "throws for the state %o",
    (state) => {
      expect(() => computeEntitlement(record({ state }), NOW)).toThrow(
        InvalidSubscriptionError,
      );
    },
  );

  it("throws for a plan it does not know", () => {
    expect(() => computeEntitlement(record({ plan: "enterprise" }), NOW)).toThrow(
      UnknownPlanError,
    );
  });
});

/**
 * **The three derived states are not storable, and the five stored ones are.**
 * A column holding "the trial has run out" would be a fact that goes stale on
 * its own.
 */
describe("which states are written down", () => {
  it("stores five", () => {
    expect([...subscriptionStates]).toEqual([
      "trialing",
      "active",
      "grace",
      "canceled_active",
      "inactive",
    ]);
  });

  it.each(["none", "trial_expired", "expired"])(
    "never stores the derived state %o",
    (derived) => {
      expect(isSubscriptionState(derived)).toBe(false);
    },
  );
});

describe("reading an account's entitlement", () => {
  it("asks for the one row that belongs to the account", async () => {
    findUnique.mockResolvedValue(null);

    await getEffectiveEntitlement(USER, NOW);

    expect(findUnique.mock.calls[0][0].where).toEqual({ userId: USER });
  });

  /**
   * **The provider columns are not selected, so the domain cannot read them
   * even by accident.** A customer id travelling into code that answers a
   * product question is how every module ends up knowing who bills.
   */
  it("does not read the provider's identifiers", async () => {
    findUnique.mockResolvedValue(null);

    await getEffectiveEntitlement(USER, NOW);

    const selected = Object.keys(findUnique.mock.calls[0][0].select);

    expect(selected).not.toContain("providerCustomerId");
    expect(selected).not.toContain("providerSubscriptionId");
    expect(selected).not.toContain("providerUpdatedAt");
  });

  it("answers nothing for an account with no row", async () => {
    findUnique.mockResolvedValue(null);

    expect(await getEffectiveEntitlement(USER, NOW)).toEqual(NO_ENTITLEMENT);
  });

  it("answers from the row when there is one", async () => {
    findUnique.mockResolvedValue(record({ plan: "pro" }));

    const entitlement = await getEffectiveEntitlement(USER, NOW);

    expect(entitlement.plan).toBe("pro");
    expect(entitlement.limits?.discoveryLimit).toBe(150);
  });
});
