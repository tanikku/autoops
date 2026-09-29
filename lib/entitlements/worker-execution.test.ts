import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may run a worker, one stored row at a time.
 *
 * **The row is the input and `entitled` is the answer.** Every state below is
 * written the way the rest of the codebase writes it, read through the real
 * `computeEntitlement`, and checked at a fixed instant — so a state that ends by
 * the clock is tested on both sides of its ending.
 */

const subscriptionFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { subscription: { findUnique: subscriptionFindUnique } },
}));

const {
  ExecutionEntitlementBlockedError,
  isExecutionEntitlementBlocked,
  requireWorkerExecutionEntitlement,
} = await import("@/lib/entitlements/worker-execution");

const USER = "116614511017733764020";
const NOW = new Date("2026-10-15T09:00:00.000Z");

/** A row with nothing in it; each case says what it is. */
function row(overrides: Record<string, unknown>) {
  return {
    plan: "lite",
    state: "active",
    source: "stripe",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
    notificationWorkerId: null,
    expiresAt: null,
    ...overrides,
  };
}

const trial = (endsAt: Date) =>
  row({
    plan: "trial",
    state: "trialing",
    source: "trial",
    trialStartedAt: new Date(endsAt.getTime() - 14 * 24 * 60 * 60 * 1000),
    trialEndsAt: endsAt,
    trialConsumedAt: new Date(endsAt.getTime() - 14 * 24 * 60 * 60 * 1000),
    trialForfeitedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  });

const beta = (expiresAt: Date) =>
  row({
    plan: "beta",
    state: "active",
    source: "admin",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    expiresAt,
  });

const check = () => requireWorkerExecutionEntitlement(USER, NOW);

beforeEach(() => {
  subscriptionFindUnique.mockReset();
});

describe("who may run a worker", () => {
  it.each([
    ["a trial that is running", trial(new Date("2026-10-20T00:00:00.000Z"))],
    ["a paid plan", row({})],
    ["a paid plan whose payment needs attention", row({ state: "grace" })],
    ["a cancellation still inside its period", row({ state: "canceled_active" })],
    ["the granted Beta allowance", beta(new Date("2026-12-31T23:59:59.000Z"))],
    ["Standard", row({ plan: "standard" })],
    ["Pro", row({ plan: "pro" })],
  ])("allows %s", async (_label, stored) => {
    subscriptionFindUnique.mockResolvedValue(stored);

    await expect(check()).resolves.toBeUndefined();
  });

  it("reads the account it was asked about", async () => {
    subscriptionFindUnique.mockResolvedValue(row({}));

    await check();

    expect(subscriptionFindUnique).toHaveBeenCalledTimes(1);
    expect(subscriptionFindUnique.mock.calls[0][0].where).toEqual({ userId: USER });
  });
});

describe("who may not", () => {
  it.each([
    ["an account with no row, which has not started a trial", null],
    ["a trial that has run out", trial(new Date("2026-10-10T00:00:00.000Z"))],
    ["a trial ending at this very instant", trial(NOW)],
    ["a Beta grant past its expiry", beta(new Date("2026-10-01T00:00:00.000Z"))],
    ["a Beta grant expiring at this very instant", beta(NOW)],
    ["a subscription that has ended", row({ state: "inactive" })],
    [
      "a cancellation whose period has run out",
      row({
        state: "canceled_active",
        currentPeriodEnd: new Date("2026-10-10T00:00:00.000Z"),
      }),
    ],
    [
      "a cancellation whose period ends at this very instant",
      row({ state: "canceled_active", currentPeriodEnd: NOW }),
    ],
  ])("refuses %s", async (_label, stored) => {
    subscriptionFindUnique.mockResolvedValue(stored);

    await expect(check()).rejects.toBeInstanceOf(ExecutionEntitlementBlockedError);
  });

  /** A row written by a version that knew more is not guessed at. */
  it.each([
    ["a state this version does not know", row({ state: "frozen" })],
    ["a plan this version does not know", row({ plan: "enterprise" })],
    ["a trial that cannot say when it ends", row({ plan: "trial", state: "trialing" })],
    ["a cancellation with no period end", row({ state: "canceled_active", currentPeriodEnd: null })],
  ])("refuses %s", async (_label, stored) => {
    subscriptionFindUnique.mockResolvedValue(stored);

    await expect(check()).rejects.toBeInstanceOf(ExecutionEntitlementBlockedError);
  });

  /** A database that cannot be reached says nothing about anybody. */
  it("lets a failed read travel as the failure it is", async () => {
    subscriptionFindUnique.mockRejectedValue(new Error("connection refused"));

    const error = await check().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isExecutionEntitlementBlocked(error)).toBe(false);
  });
});

describe("the refusal itself", () => {
  it("is named and recognisable", () => {
    const error = new ExecutionEntitlementBlockedError();

    expect(error.name).toBe("ExecutionEntitlementBlockedError");
    expect(isExecutionEntitlementBlocked(error)).toBe(true);
    expect(isExecutionEntitlementBlocked(new Error("other"))).toBe(false);
  });

  it("says nothing about the account, the plan or the dates", async () => {
    subscriptionFindUnique.mockResolvedValue(
      row({ plan: "enterprise", expiresAt: new Date("2026-10-01T00:00:00.000Z") }),
    );

    const error = (await check().catch((caught: unknown) => caught)) as Error;

    for (const forbidden of [USER, "enterprise", "lite", "2026", "cus_", "sub_", "@"]) {
      expect(error.message, `says ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** Reading is all it does. */
  it("writes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/entitlements/worker-execution.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [".create(", ".update(", ".updateMany(", ".upsert(", ".delete(", "consumeUsage"]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});
