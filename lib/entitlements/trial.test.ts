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

const { computeTrialEnd, isAdminGrantedBeta, isTrialEligible } = await import(
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
   * **An account already entitled is not owed a free fortnight on top.**
   *
   * The beta grant below is refused twice over: by this clause while it is in
   * force, and by the exclusion in the next block for good. Only the second one
   * survives the grant expiring.
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
   *
   * **Written with a granted *plan* rather than a granted *beta*.** An expired
   * beta grant used to answer this way too, and that was the defect: the beta
   * cohort was offered a second free run the moment their allowance lapsed. It
   * is now refused on its own grounds — see the next block — which is why this
   * demonstration needs a plan the exclusion does not cover.
   */
  it("allows an account whose grant expired without a trial ever starting", () => {
    const expired = record({
      plan: "pro",
      state: "active",
      source: "admin",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(isTrialEligible(expired, NOW)).toBe(true);
  });
});

/**
 * The carried-over accounts, and the offer they are not owed.
 *
 * **They were given the beta allowance free, for months, without a card.** The
 * trial exists for people who have not tried Koqentra; these people have. When
 * the grant ends they are being asked to decide, not offered another free run
 * at it.
 *
 * **What makes that stick is the grant itself, not a trial column.** Every
 * other signal moves — the grant expires, `entitled` turns false — and marking
 * them as having consumed a trial would have been a lie about people who never
 * had one, written into five rows that are already correct.
 */
describe("an account that was given the beta allowance", () => {
  const adminBeta = (overrides: Partial<SubscriptionRecord> = {}) =>
    record({
      plan: "beta",
      state: "active",
      source: "admin",
      expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      ...overrides,
    });

  it("is recognised by the two columns that do not move", () => {
    expect(isAdminGrantedBeta(adminBeta())).toBe(true);
  });

  it("is never offered a trial while the grant is in force", () => {
    expect(isTrialEligible(adminBeta(), NOW)).toBe(false);
  });

  /**
   * **The case this rule exists for.** Before it, an expired grant made
   * `entitled` false while `trialConsumedAt` was still null, and both of the
   * older conditions became true at once.
   */
  it("is never offered a trial after the grant has expired", () => {
    const afterExpiry = new Date("2027-01-01T00:00:00.000Z");

    expect(isTrialEligible(adminBeta(), afterExpiry)).toBe(false);
  });

  it("is never offered a trial at the very instant the grant ends", () => {
    expect(
      isTrialEligible(adminBeta(), new Date("2026-12-31T23:59:59.000Z")),
    ).toBe(false);
  });

  it("is never offered a trial when the grant already lapsed long ago", () => {
    expect(
      isTrialEligible(
        adminBeta({ expiresAt: new Date("2026-01-01T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe(false);
  });

  /** The state of the five Production rows today: no trial was ever consumed. */
  it("is refused even though it has never consumed a trial", () => {
    const untouched = adminBeta({ trialConsumedAt: null });

    expect(untouched.trialConsumedAt).toBeNull();
    expect(isTrialEligible(untouched, NOW)).toBe(false);
  });

  it("is refused when it has consumed one as well", () => {
    expect(
      isTrialEligible(
        adminBeta({ trialConsumedAt: new Date("2026-05-01T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe(false);
  });

  /**
   * **Whatever the row says about right now.** The answer comes from the grant
   * having been made, so a state this version could not otherwise read still
   * produces a refusal rather than a throw.
   */
  it.each(["active", "grace", "inactive", "something-later-versions-know"])(
    "is refused whatever state the row carries (%o)",
    (state) => {
      expect(isTrialEligible(adminBeta({ state }), NOW)).toBe(false);
    },
  );

  it("is refused with no expiry at all", () => {
    expect(isTrialEligible(adminBeta({ expiresAt: null }), NOW)).toBe(false);
  });

  /** A future grant is covered by the same two columns, with nothing added. */
  it("covers an account granted the allowance later, on another date", () => {
    expect(
      isTrialEligible(
        adminBeta({ expiresAt: new Date("2028-06-30T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe(false);
  });
});

/**
 * **Only the granted cohort is excluded.** The rule is about having been given
 * the beta allowance, not about the word "beta" or the word "admin" appearing
 * anywhere.
 */
describe("what the exclusion deliberately does not cover", () => {
  it.each([
    ["a beta plan that was not granted by an operator", "beta", "stripe"],
    ["an operator grant of some other plan", "pro", "admin"],
    ["an ordinary paid plan", "pro", "stripe"],
  ])("does not treat %s as a granted beta", (_label, plan, source) => {
    expect(isAdminGrantedBeta(record({ plan, source }))).toBe(false);
  });

  /**
   * A beta row from a billing provider is judged the old way: it entitles the
   * account today, so no trial — but for the ordinary reason, not this one.
   */
  it("judges a non-granted beta by the existing rules", () => {
    const boughtBeta = record({
      plan: "beta",
      state: "active",
      source: "stripe",
      expiresAt: null,
    });

    expect(isAdminGrantedBeta(boughtBeta)).toBe(false);
    expect(isTrialEligible(boughtBeta, NOW)).toBe(false);

    // And once it stops entitling, the old answer comes back — which is what
    // shows the new rule did not quietly swallow this case.
    expect(isTrialEligible({ ...boughtBeta, state: "inactive" }, NOW)).toBe(true);
  });

  it("judges an operator grant of another plan by the existing rules", () => {
    const grantedPro = record({ plan: "pro", state: "inactive", source: "admin" });

    expect(isAdminGrantedBeta(grantedPro)).toBe(false);
    expect(isTrialEligible(grantedPro, NOW)).toBe(true);
  });

  /** Everything that was true before this rule is still true. */
  it.each([
    ["a live paid plan", record(), false],
    ["a plan in grace", record({ state: "grace" }), false],
    ["a lapsed paid plan", record({ state: "inactive" }), true],
    [
      "a lapsed plan whose trial was already used",
      record({
        state: "inactive",
        trialConsumedAt: new Date("2026-05-01T00:00:00.000Z"),
      }),
      false,
    ],
  ])("still answers %s the way it always did", (_label, held, expected) => {
    expect(isTrialEligible(held, NOW)).toBe(expected);
  });
});
