import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Granting the Closed Beta's allowance, and everything it refuses to do.
 *
 * **It is not reachable from anywhere**, and these tests do not make it so:
 * there is no route, no server action, no page and no startup hook, and nothing
 * in a migration calls it. It has also not been run against Production. The
 * five accounts it exists for still have no entitlement row.
 *
 * **Most of what is fixed here is a refusal.** The way to harm those five
 * people is not to fail to grant something — it is to overwrite something they
 * already have. So a paid plan, a running trial, and a grant ending on another
 * date are all left exactly where they are.
 */

const { findUser, findSubscription, create } = vi.hoisted(() => ({
  findUser: vi.fn(),
  findSubscription: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: findUser },
    subscription: { findUnique: findSubscription, create },
  },
}));

const { grantBetaSubscription } = await import("@/lib/billing/admin");

const USER = "google-sub-1";
const EXPIRES = new Date("2026-12-31T23:59:59.000Z");

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

const EXISTING_GRANT = {
  plan: "beta",
  state: "active",
  source: "admin",
  expiresAt: EXPIRES,
};

beforeEach(() => {
  findUser.mockReset();
  findSubscription.mockReset();
  create.mockReset();
  findUser.mockResolvedValue({ id: USER });
  findSubscription.mockResolvedValue(null);
  create.mockResolvedValue({});
});

describe("granting the beta allowance", () => {
  it("writes the grant when the account has no entitlement", async () => {
    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: true,
      created: true,
    });

    expect(create.mock.calls[0][0].data).toEqual({
      userId: USER,
      plan: "beta",
      state: "active",
      source: "admin",
      expiresAt: EXPIRES,
    });
  });

  /**
   * **Nothing points at a customer, because there is none.** This entitlement
   * was not bought, and filling a provider column in to look complete would be
   * a claim about somebody who does not exist.
   */
  it("writes no provider identifiers", async () => {
    await grantBetaSubscription(USER, EXPIRES);

    const written = Object.keys(create.mock.calls[0][0].data);

    expect(written).not.toContain("providerCustomerId");
    expect(written).not.toContain("providerSubscriptionId");
    expect(written).not.toContain("providerUpdatedAt");
  });

  /** A grant is not a trial, and must not consume one. */
  it("leaves the trial untouched, so one is still available later", async () => {
    await grantBetaSubscription(USER, EXPIRES);

    const written = Object.keys(create.mock.calls[0][0].data);

    expect(written).not.toContain("trialStartedAt");
    expect(written).not.toContain("trialEndsAt");
    expect(written).not.toContain("trialConsumedAt");
  });
});

describe("an account that is not there", () => {
  /**
   * **Checked rather than left to the foreign key.** A missing account is an
   * operator typing the wrong id, and that should come back as an answer rather
   * than as a constraint violation to be interpreted.
   */
  it("is answered, not written", async () => {
    findUser.mockResolvedValue(null);

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: false,
      reason: "unknown-user",
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("an account that already has something", () => {
  it.each([
    ["a paid plan", { plan: "pro", state: "active", source: "stripe", expiresAt: null }],
    [
      "a running trial",
      {
        plan: "trial",
        state: "trialing",
        source: "trial",
        expiresAt: null,
      },
    ],
    [
      "a cancelled plan still in its period",
      {
        plan: "standard",
        state: "canceled_active",
        source: "stripe",
        expiresAt: null,
      },
    ],
    [
      "an entitlement that has lapsed",
      { plan: "lite", state: "inactive", source: "stripe", expiresAt: null },
    ],
  ])("refuses to overwrite %s", async (_label, existing) => {
    findSubscription.mockResolvedValue(existing);

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: false,
      reason: "already-entitled",
    });
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * **Even a beta grant ending on another day is a different grant.** Treating
   * it as the same one would let a second call quietly move an expiry somebody
   * chose, which is the overwriting this whole function exists to refuse.
   */
  it.each([
    [
      "a different expiry",
      { ...EXISTING_GRANT, expiresAt: new Date("2027-06-30T00:00:00.000Z") },
    ],
    ["no expiry at all", { ...EXISTING_GRANT, expiresAt: null }],
    ["a different source", { ...EXISTING_GRANT, source: "stripe" }],
    ["a different state", { ...EXISTING_GRANT, state: "inactive" }],
  ])("refuses a beta row with %s", async (_label, existing) => {
    findSubscription.mockResolvedValue(existing);

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: false,
      reason: "already-entitled",
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("granting the same thing twice", () => {
  /**
   * **Safe to repeat, and only when it is genuinely the same grant.** An
   * operator re-running the same command over five accounts should not have to
   * remember which of them already went through.
   */
  it("changes nothing and reports success", async () => {
    findSubscription.mockResolvedValue(EXISTING_GRANT);

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: true,
      created: false,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("matches the expiry by instant rather than by identity", async () => {
    findSubscription.mockResolvedValue({
      ...EXISTING_GRANT,
      expiresAt: new Date(EXPIRES.getTime()),
    });

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: true,
      created: false,
    });
  });
});

describe("two grants arriving at once", () => {
  /**
   * Whatever was written in between is now what the account has, so it is
   * judged exactly as it would have been before — and left alone unless it is
   * already this grant.
   */
  it("accepts the other one when it is the same grant", async () => {
    findSubscription.mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING_GRANT);
    create.mockRejectedValue(uniqueViolation());

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: true,
      created: false,
    });
  });

  it("leaves the other one alone when it is not", async () => {
    findSubscription
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ plan: "pro", state: "active", source: "stripe", expiresAt: null });
    create.mockRejectedValue(uniqueViolation());

    expect(await grantBetaSubscription(USER, EXPIRES)).toEqual({
      granted: false,
      reason: "already-entitled",
    });
  });

  it("does not absorb a failure that is not a collision", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await expect(grantBetaSubscription(USER, EXPIRES)).rejects.toThrow(
      "connection lost",
    );
  });
});

describe("an expiry that is not one", () => {
  /**
   * **There is no overload without a date.** A grant with no end is one nobody
   * ever has to decide about again, and the decision not made would be "when
   * does the Closed Beta stop being free".
   */
  it("refuses before reading anything", async () => {
    await expect(
      grantBetaSubscription(USER, new Date("not a date")),
    ).rejects.toThrow();

    expect(findUser).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
