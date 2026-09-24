import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How many workers an account may run at once, and where that number comes
 * from.
 *
 * **One catalogue, read through the entitlement.** No number in this file is
 * written into the module under test: every expectation below states what
 * `lib/plans.ts` says, so a plan whose allowance changed would fail here rather
 * than change behaviour quietly.
 *
 * **Nothing here refuses anything.** It answers "how many", and the refusing is
 * `claimWorkerActivation`'s — which is also where the account's row is locked,
 * because a capacity read on its own is a capacity read at a moment that has
 * already passed.
 */

const { findSubscription } = vi.hoisted(() => ({ findSubscription: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { subscription: { findUnique: vi.fn() } } }));

const { resolveActiveWorkerLimit } = await import(
  "@/lib/entitlements/active-worker-limit"
);
const { getPlanDefinition } = await import("@/lib/plans");

const client = { subscription: { findUnique: findSubscription } } as unknown as Parameters<
  typeof resolveActiveWorkerLimit
>[0];

const USER = "google-sub-1";
const NOW = new Date("2026-09-23T10:00:00.000Z");

function record(overrides: Record<string, unknown> = {}) {
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
  findSubscription.mockReset().mockResolvedValue(null);
});

describe("what the catalogue says", () => {
  /** The numbers every expectation below is stated against. */
  it.each([
    ["trial", 3],
    ["beta", 10],
    ["lite", 2],
    ["standard", 8],
    ["pro", 15],
  ])("%s allows %i at once", (plan, expected) => {
    expect(getPlanDefinition(plan).activeWorkerLimit).toBe(expected);
  });
});

describe("an account with no entitlement", () => {
  /**
   * **Judged by the trial's own allowance, and not by a hardcoded three.** An
   * account with no row is one that has not activated anything yet — and the
   * moment it does, the trial it starts is the entitlement it will have. This
   * is the same number, read from the same place.
   */
  it("is allowed what a trial allows", async () => {
    findSubscription.mockResolvedValue(null);

    expect(await resolveActiveWorkerLimit(client, USER, NOW)).toBe(
      getPlanDefinition("trial").activeWorkerLimit,
    );
  });

  it("can therefore activate its first worker", async () => {
    findSubscription.mockResolvedValue(null);

    expect(await resolveActiveWorkerLimit(client, USER, NOW)).toBeGreaterThan(0);
  });
});

describe("an account on a plan", () => {
  it.each([
    ["a running trial", { plan: "trial", state: "trialing", source: "trial",
      trialStartedAt: new Date("2026-09-20T00:00:00.000Z"),
      trialEndsAt: new Date("2026-10-04T00:00:00.000Z") }, 3],
    ["the granted beta allowance", { plan: "beta", state: "active", source: "admin",
      expiresAt: new Date("2026-12-31T23:59:59.000Z") }, 10],
    ["Lite", { plan: "lite" }, 2],
    ["Standard", { plan: "standard" }, 8],
    ["Pro", { plan: "pro" }, 15],
  ])("on %s is allowed %i", async (_label, overrides, expected) => {
    findSubscription.mockResolvedValue(record(overrides));

    expect(await resolveActiveWorkerLimit(client, USER, NOW)).toBe(expected);
  });

  it("reads only this account's entitlement", async () => {
    await resolveActiveWorkerLimit(client, USER, NOW);

    expect(findSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });
});

/**
 * **Capacity does not move because something ended.** A plan says what it
 * allows whether or not it currently entitles anything, so a lapsed
 * entitlement keeps the number it had. What an ended entitlement may *do* is a
 * separate question, and nothing in this module answers it.
 */
describe("an entitlement that no longer entitles anything", () => {
  it("keeps a trial's capacity after the fortnight has ended", async () => {
    findSubscription.mockResolvedValue(
      record({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
        trialEndsAt: new Date("2026-08-15T00:00:00.000Z"),
      }),
    );

    expect(await resolveActiveWorkerLimit(client, USER, NOW)).toBe(3);
  });

  it("keeps a grant's capacity after it has expired", async () => {
    findSubscription.mockResolvedValue(
      record({
        plan: "beta",
        state: "active",
        source: "admin",
        expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );

    expect(await resolveActiveWorkerLimit(client, USER, NOW)).toBe(10);
  });

  it("keeps a plan's capacity after it has lapsed", async () => {
    findSubscription.mockResolvedValue(
      record({ plan: "lite", state: "inactive" }),
    );

    expect(await resolveActiveWorkerLimit(client, USER, NOW)).toBe(2);
  });
});

describe("an entitlement that cannot be read", () => {
  /**
   * **Thrown rather than guessed.** A state this version does not know was
   * written by one that knew more; a fallback would either hand out slots
   * nobody granted or take away ones somebody has.
   */
  it("refuses to answer for a state it does not know", async () => {
    findSubscription.mockResolvedValue(
      record({ state: "something-later-versions-know" }),
    );

    await expect(
      resolveActiveWorkerLimit(client, USER, NOW),
    ).rejects.toThrow(/Unreadable subscription/);
  });

  it("refuses to answer for a plan it does not know", async () => {
    findSubscription.mockResolvedValue(record({ plan: "enterprise" }));

    await expect(resolveActiveWorkerLimit(client, USER, NOW)).rejects.toThrow(
      /Unknown plan/,
    );
  });
});

describe("what the module deliberately does not offer", () => {
  it("answers how many, and nothing about whether", async () => {
    const exported = await import("@/lib/entitlements/active-worker-limit");

    expect(Object.keys(exported)).toEqual(["resolveActiveWorkerLimit"]);
  });
});
