import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the quota asks the database, and which number it asks against.
 *
 * **The lock is the part that cannot be tested here**, and saying so plainly
 * matters more than the assertions below: that a second transaction waits at
 * the `UPDATE` is a property of PostgreSQL, and a mock that returns
 * immediately proves nothing about it. It was measured against local
 * PostgreSQL instead, the same way `claimRoutineSlot`'s exclusivity is.
 *
 * What these do fix is everything that would quietly disable that lock: that
 * the account row is written rather than read, that the write is the
 * self-assignment Prisma actually turns into an `UPDATE`, and that both the
 * limit and the count are read after it, inside the same transaction.
 *
 * **The active limit is now the account's plan's.** It used to be ten for
 * everybody; it is read per account from the entitlement, so a trial allows
 * three and the granted beta allowance ten — from the catalogue that says so
 * and from nowhere else. The entitlement is computed for real here rather than
 * stubbed, so a plan whose number changed would fail these.
 */

const { update, count, findSubscription } = vi.hoisted(() => ({
  update: vi.fn(),
  count: vi.fn(),
  findSubscription: vi.fn(),
}));

// `computeEntitlement` lives in a module that reaches for the client; nothing
// below uses it, because the quota reads through the caller's own client.
vi.mock("@/lib/prisma", () => ({ prisma: { subscription: { findUnique: vi.fn() } } }));

const clientStub = {
  user: { update },
  routine: { count },
  subscription: { findUnique: findSubscription },
};

const { claimWorkerActivation, claimWorkerCreation, TOTAL_WORKER_LIMIT } =
  await import("@/lib/worker-quota");

/** Stands in for a transaction client: the three tables the quota touches. */
const client = clientStub as unknown as Parameters<
  typeof claimWorkerCreation
>[0];

const USER = "google-sub-1";
const NOW = new Date("2026-09-23T10:00:00.000Z");

/** A stored entitlement, in the shape the domain reads. */
function record(overrides: Record<string, unknown> = {}) {
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

/**
 * The entitlements an account can be on, and what each allows at once.
 *
 * **The numbers are not written here.** Each case names a plan; the limit the
 * quota uses comes from `lib/plans.ts` through `computeEntitlement`, and the
 * expectations below state what that catalogue says so that changing it fails
 * a test rather than changing behaviour silently.
 */
const PLANS = {
  /** No row at all: an account that has not activated anything yet. */
  preTrial: { row: null, limit: 3 },
  trial: {
    row: record({
      plan: "trial",
      state: "trialing",
      source: "trial",
      trialStartedAt: new Date("2026-09-20T00:00:00.000Z"),
      trialEndsAt: new Date("2026-10-04T00:00:00.000Z"),
      trialConsumedAt: new Date("2026-09-20T00:00:00.000Z"),
    }),
    limit: 3,
  },
  beta: {
    row: record({
      plan: "beta",
      state: "active",
      source: "admin",
      expiresAt: new Date("2026-12-31T23:59:59.000Z"),
    }),
    limit: 10,
  },
  lite: { row: record({ plan: "lite" }), limit: 2 },
  standard: { row: record({ plan: "standard" }), limit: 8 },
  pro: { row: record({ plan: "pro" }), limit: 15 },
} as const;

/** Puts the account on a plan, for the entitlement the quota will compute. */
function on(plan: keyof typeof PLANS) {
  findSubscription.mockResolvedValue(PLANS[plan].row);

  return PLANS[plan].limit;
}

beforeEach(() => {
  update.mockReset().mockResolvedValue({ id: USER });
  count.mockReset();
  findSubscription.mockReset().mockResolvedValue(null);
});

describe("the limits themselves", () => {
  /**
   * **Twenty rows per account, whatever the plan.** The total is about how
   * much of the platform one account occupies and is deliberately untouched by
   * this phase — only the active limit became the plan's.
   */
  it("is twenty workers in total, and that has not moved", () => {
    expect(TOTAL_WORKER_LIMIT).toBe(20);
  });

  it("no longer exports a single active limit for everybody", async () => {
    const quota = await import("@/lib/worker-quota");

    expect(quota).not.toHaveProperty("ACTIVE_WORKER_LIMIT");
  });
});

describe("the account lock", () => {
  it("writes the account row rather than reading it", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "draft", NOW);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { id: USER },
    });
  });

  /**
   * **`data: {}` would take no lock.** Prisma issues no `UPDATE` for an empty
   * `data` — it answers with a `SELECT` — so the self-assignment is what makes
   * the count that follows safe. This is the line that would fail if somebody
   * "tidied" it away.
   */
  it("never asks for an empty update", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "active", NOW);
    await claimWorkerActivation(client, USER, NOW);

    for (const [argument] of update.mock.calls) {
      expect(argument.data).toEqual({ id: USER });
      expect(Object.keys(argument.data)).toHaveLength(1);
    }
  });

  it("takes the lock before counting anything", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "active", NOW);

    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      count.mock.invocationCallOrder[0],
    );
  });

  /**
   * **The limit is read inside the lock too.** Which plan an account is on and
   * how many workers it has must be one moment; a limit read before the lock
   * would be a limit from before whatever the lock was waiting for.
   */
  it("reads the plan's limit after taking the lock", async () => {
    on("trial");
    count.mockResolvedValue(0);

    await claimWorkerActivation(client, USER, NOW);

    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      findSubscription.mock.invocationCallOrder[0],
    );
  });

  it("reads the entitlement with the caller's own client", async () => {
    on("trial");
    count.mockResolvedValue(0);

    await claimWorkerActivation(client, USER, NOW);

    expect(findSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });
});

/**
 * Every plan, at the slot before its last and at its last.
 *
 * **Stated as a table because the rule is one sentence**: below the limit it
 * goes ahead, at the limit it does not. What differs between the rows is only
 * which number the account's plan supplies.
 */
describe("how many workers each plan may run at once", () => {
  it.each([
    ["an account with no entitlement yet", "preTrial" as const],
    ["a trial", "trial" as const],
    ["the granted beta allowance", "beta" as const],
    ["Lite", "lite" as const],
    ["Standard", "standard" as const],
    ["Pro", "pro" as const],
  ])("lets %s activate one more below its limit", async (_label, plan) => {
    const limit = on(plan);
    count.mockResolvedValue(limit - 1);

    expect(await claimWorkerActivation(client, USER, NOW)).toBeNull();
  });

  it.each([
    ["an account with no entitlement yet", "preTrial" as const],
    ["a trial", "trial" as const],
    ["the granted beta allowance", "beta" as const],
    ["Lite", "lite" as const],
    ["Standard", "standard" as const],
    ["Pro", "pro" as const],
  ])("refuses %s at its limit, and says what it was", async (_label, plan) => {
    const limit = on(plan);
    count.mockResolvedValue(limit);

    expect(await claimWorkerActivation(client, USER, NOW)).toEqual({
      reason: "active",
      limit,
    });
  });

  /** The exact boundaries the contract names, one plan at a time. */
  it.each([
    ["trial" as const, 0, null],
    ["trial" as const, 1, null],
    ["trial" as const, 2, null],
    ["trial" as const, 3, "refused"],
    ["beta" as const, 9, null],
    ["beta" as const, 10, "refused"],
    ["lite" as const, 1, null],
    ["lite" as const, 2, "refused"],
    ["standard" as const, 7, null],
    ["standard" as const, 8, "refused"],
    ["pro" as const, 14, null],
    ["pro" as const, 15, "refused"],
  ])("on %s with %i already active", async (plan, active, expected) => {
    const limit = on(plan);
    count.mockResolvedValue(active);

    const answer = await claimWorkerActivation(client, USER, NOW);

    expect(answer === null ? null : "refused").toBe(expected);
    if (answer !== null) {
      expect(answer.limit).toBe(limit);
    }
  });

  /**
   * **An account already over its plan's limit is refused one more, and
   * nothing else happens.** No worker is paused, none is chosen, and none is
   * rewritten — the quota answers a question and writes nothing but the lock.
   */
  it("refuses an account already past its limit without touching a worker", async () => {
    on("trial");
    count.mockResolvedValue(5);

    expect(await claimWorkerActivation(client, USER, NOW)).toEqual({
      reason: "active",
      limit: 3,
    });
    // The only write is the lock's self-assignment.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { id: USER },
    });
  });

  /**
   * **A trial that has ended keeps its plan's capacity.** The limits a plan
   * allows are reported for every state, including the ones that entitle
   * nothing — so capacity does not move the day a fortnight runs out. Whether
   * an ended trial may do anything at all is an expiry question, and nothing
   * here answers it.
   */
  it("keeps a trial's capacity after the fortnight has ended", async () => {
    findSubscription.mockResolvedValue(PLANS.trial.row);
    count.mockResolvedValue(2);

    const afterExpiry = new Date("2026-11-01T00:00:00.000Z");

    expect(await claimWorkerActivation(client, USER, afterExpiry)).toBeNull();
  });

  it("refuses an ended trial that is at its capacity, for capacity's reason", async () => {
    findSubscription.mockResolvedValue(PLANS.trial.row);
    count.mockResolvedValue(3);

    const afterExpiry = new Date("2026-11-01T00:00:00.000Z");

    expect(await claimWorkerActivation(client, USER, afterExpiry)).toEqual({
      reason: "active",
      limit: 3,
    });
  });
});

describe("claimWorkerCreation", () => {
  it("allows a create below the total limit", async () => {
    count.mockResolvedValue(TOTAL_WORKER_LIMIT - 1);

    expect(await claimWorkerCreation(client, USER, "draft", NOW)).toBeNull();
  });

  it("refuses a create at the total limit, and says what it was", async () => {
    count.mockResolvedValue(TOTAL_WORKER_LIMIT);

    expect(await claimWorkerCreation(client, USER, "draft", NOW)).toEqual({
      reason: "total",
      limit: TOTAL_WORKER_LIMIT,
    });
  });

  it("counts every worker the account has, whatever its state", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "draft", NOW);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  /**
   * **A draft costs nothing against the active limit**, so nothing is read for
   * it — not the count, and not the entitlement either.
   */
  it.each([
    ["a draft", "draft"],
    ["a paused worker", "paused"],
  ])("asks nothing about the active limit for %s", async (_label, status) => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, status, NOW);

    expect(count).toHaveBeenCalledTimes(1);
    expect(findSubscription).not.toHaveBeenCalled();
  });

  it("counts the account's active workers when one more would be", async () => {
    on("trial");
    count.mockResolvedValueOnce(TOTAL_WORKER_LIMIT - 1).mockResolvedValueOnce(0);

    await claimWorkerCreation(client, USER, "active", NOW);

    expect(count).toHaveBeenNthCalledWith(2, {
      where: { userId: USER, status: "active" },
    });
  });

  it.each([
    ["a trial", "trial" as const],
    ["the granted beta allowance", "beta" as const],
    ["Lite", "lite" as const],
    ["Pro", "pro" as const],
  ])("creates an active worker below %s's limit", async (_label, plan) => {
    const limit = on(plan);
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(limit - 1);

    expect(await claimWorkerCreation(client, USER, "active", NOW)).toBeNull();
  });

  it.each([
    ["a trial", "trial" as const],
    ["the granted beta allowance", "beta" as const],
    ["Lite", "lite" as const],
    ["Pro", "pro" as const],
  ])("refuses an active create at %s's limit", async (_label, plan) => {
    const limit = on(plan);
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(limit);

    expect(await claimWorkerCreation(client, USER, "active", NOW)).toEqual({
      reason: "active",
      limit,
    });
  });

  /** An account with no entitlement can still create its first active worker. */
  it("lets an account with no entitlement create its first active worker", async () => {
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    expect(await claimWorkerCreation(client, USER, "active", NOW)).toBeNull();
  });

  it("answers with the total limit first when both are reached", async () => {
    count.mockResolvedValue(TOTAL_WORKER_LIMIT);

    expect(await claimWorkerCreation(client, USER, "active", NOW)).toEqual({
      reason: "total",
      limit: TOTAL_WORKER_LIMIT,
    });
    // Neither the active count nor the entitlement is asked for: there is no
    // room for the row at all.
    expect(count).toHaveBeenCalledTimes(1);
    expect(findSubscription).not.toHaveBeenCalled();
  });

  it("lets a database failure through rather than calling it a rejection", async () => {
    count.mockRejectedValue(new Error("connection terminated"));

    await expect(
      claimWorkerCreation(client, USER, "draft", NOW),
    ).rejects.toThrow("connection terminated");
  });
});

describe("claimWorkerActivation", () => {
  it("counts only this account's active workers, and nothing else", async () => {
    on("trial");
    count.mockResolvedValue(0);

    await claimWorkerActivation(client, USER, NOW);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({
      where: { userId: USER, status: "active" },
    });
  });

  /**
   * **The total is not re-checked.** Activating changes no row count, and an
   * account over the total by some other route should not have its existing
   * workers frozen as a side effect.
   */
  it("never asks about the total", async () => {
    on("beta");
    count.mockResolvedValue(0);

    await claimWorkerActivation(client, USER, NOW);

    expect(count).not.toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it("lets a database failure through", async () => {
    update.mockRejectedValue(new Error("connection terminated"));

    await expect(claimWorkerActivation(client, USER, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });

  /**
   * **An unreadable entitlement fails the activation rather than guessing.** A
   * stored state this version does not know was written by one that knew more;
   * inventing a capacity from it would either hand out slots nobody granted or
   * take away ones somebody has.
   */
  it("refuses to guess a capacity from an entitlement it cannot read", async () => {
    findSubscription.mockResolvedValue(
      record({ state: "something-later-versions-know" }),
    );
    count.mockResolvedValue(0);

    await expect(claimWorkerActivation(client, USER, NOW)).rejects.toThrow(
      /Unreadable subscription/,
    );
  });
});

/**
 * Two activations arriving together when one slot is left.
 *
 * **What makes this correct is the lock, and the lock is PostgreSQL's.** These
 * cannot prove it: a mock answers both callers instantly. What they do fix is
 * the thing that would still have to hold if the lock were ever lost — that
 * the decision is made from a count read after the lock, so the second caller
 * sees what the first one committed.
 */
describe("when two activations arrive at once", () => {
  it("refuses the second once the first has taken the last slot", async () => {
    on("trial");

    // Serialized, the first sees two and the second sees three — which is what
    // the lock guarantees and what these two calls stand in for.
    count.mockResolvedValueOnce(2);
    expect(await claimWorkerActivation(client, USER, NOW)).toBeNull();

    count.mockResolvedValueOnce(3);
    expect(await claimWorkerActivation(client, USER, NOW)).toEqual({
      reason: "active",
      limit: 3,
    });
  });

  it("reads the count after the lock on every call, not once", async () => {
    on("trial");
    count.mockResolvedValue(2);

    await claimWorkerActivation(client, USER, NOW);
    await claimWorkerActivation(client, USER, NOW);

    expect(update).toHaveBeenCalledTimes(2);
    expect(count).toHaveBeenCalledTimes(2);
    for (const [index] of update.mock.calls.entries()) {
      expect(update.mock.invocationCallOrder[index]).toBeLessThan(
        count.mock.invocationCallOrder[index],
      );
    }
  });
});
