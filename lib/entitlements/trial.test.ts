import { describe, expect, it, vi } from "vitest";
import type { SubscriptionRecord } from "@/lib/entitlements/types";

/**
 * When a trial would end, and who may start one.
 *
 * **Nothing starts a trial.** `claimWorkerCreation` and `claimWorkerActivation`
 * are untouched, and an account activating its first worker today gets exactly
 * what it got yesterday: a worker, and no entitlement row. What these fix is
 * the arithmetic and the rule, so that the change which does start trials is a
 * call rather than a decision made in a hurry.
 */

vi.mock("@/lib/prisma", () => ({ prisma: { subscription: { findUnique: vi.fn() } } }));

const { computeTrialEnd, isTrialEligible } = await import(
  "@/lib/entitlements/trial"
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-20T12:00:00.000Z");

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
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

describe("how long a trial lasts", () => {
  it("ends fourteen days after it started", () => {
    expect(computeTrialEnd(NOW)).toEqual(new Date(NOW.getTime() + 14 * DAY_MS));
  });

  /**
   * **No timezone is consulted, on purpose.** Fourteen days is fourteen days
   * wherever somebody is, and reading `User.timezone` here would mean a trial
   * could be extended by changing a setting.
   */
  it.each([
    ["midwinter", "2026-01-01T00:00:00.000Z"],
    ["the spring change in Europe", "2026-03-29T00:30:00.000Z"],
    ["the autumn change in America", "2026-11-01T05:30:00.000Z"],
  ])("is the same span across %s", (_label, instant) => {
    const startedAt = new Date(instant);

    expect(computeTrialEnd(startedAt).getTime() - startedAt.getTime()).toBe(
      14 * DAY_MS,
    );
  });

  it("does not change what it was given", () => {
    const startedAt = new Date(NOW);

    computeTrialEnd(startedAt);

    expect(startedAt).toEqual(NOW);
  });
});

describe("who may begin a trial", () => {
  /** The ordinary case: nothing has ever been granted or bought. */
  it("allows an account with no entitlement at all", () => {
    expect(isTrialEligible(null, NOW)).toBe(true);
  });

  /**
   * **`trialConsumedAt` stays set for good.** What was spent was the offer, not
   * the fortnight — so an account whose trial ended, and an account that went
   * on to buy a plan, are both out.
   */
  it.each([
    ["one that ran out", "trial_expired"],
    ["one that was followed by a plan", "paid"],
  ])("refuses an account that has already had a trial: %s", (_label, kind) => {
    const consumed =
      kind === "trial_expired"
        ? record({
            plan: "trial",
            state: "trialing",
            source: "trial",
            trialStartedAt: new Date("2026-09-01T00:00:00.000Z"),
            trialEndsAt: new Date("2026-09-15T00:00:00.000Z"),
            trialConsumedAt: new Date("2026-09-01T00:00:00.000Z"),
          })
        : record({ trialConsumedAt: new Date("2026-09-01T00:00:00.000Z") });

    expect(isTrialEligible(consumed, NOW)).toBe(false);
  });

  /**
   * **An account already entitled is not owed a free fortnight on top.** This
   * is the clause that keeps the five carried-over beta accounts out of a
   * trial — their grant entitles them, so there is nothing to start.
   */
  it.each([
    ["a paid plan", record()],
    ["a grace period", record({ state: "grace" })],
    [
      "a beta grant",
      record({
        plan: "beta",
        state: "active",
        source: "admin",
        expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      }),
    ],
  ])("refuses an account holding %s", (_label, held) => {
    expect(isTrialEligible(held, NOW)).toBe(false);
  });

  /**
   * **Both conditions are needed, and this is the case that shows it.** A grant
   * that has run out entitles nothing, and the account never used a trial — so
   * a trial is still available to it.
   */
  it("allows an account whose grant expired without a trial ever starting", () => {
    const expired = record({
      plan: "beta",
      state: "active",
      source: "admin",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(isTrialEligible(expired, NOW)).toBe(true);
  });
});
