import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Giving a one-worker plan its chosen worker when only one could be meant.
 *
 * **Against an in-memory account**, so what is fixed is the state the repair
 * leaves behind: the chosen worker, and which emails would go out.
 */

const prismaMock = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const { repairNotificationWorkerSelection } = await import("@/lib/notification-worker");
const { computeEntitlement } = await import("@/lib/entitlements/index");
const { entitlementAllowsEmail, shouldSendRunEmail } = await import(
  "@/lib/notify/email-entitlement"
);

const USER = "user-1";
const OTHER = "user-2";
const NOW = new Date("2026-10-26T12:00:00.000Z");

type Worker = { id: string; userId: string; emailNotificationsEnabled: boolean };

function subscription(plan: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    plan,
    state: plan === "trial" ? "trialing" : "active",
    source: plan === "trial" ? "trial" : "stripe",
    trialStartedAt: plan === "trial" ? new Date("2026-10-20T00:00:00Z") : null,
    trialEndsAt: plan === "trial" ? new Date("2026-11-03T00:00:00Z") : null,
    trialConsumedAt: plan === "trial" ? new Date("2026-10-20T00:00:00Z") : null,
    trialForfeitedAt: null,
    currentPeriodStart: plan === "trial" ? null : new Date("2026-10-25T00:00:00Z"),
    currentPeriodEnd: plan === "trial" ? null : new Date("2026-11-25T00:00:00Z"),
    notificationWorkerId: null as string | null,
    expiresAt: null,
    ...overrides,
  };
}

const worker = (id: string, emailNotificationsEnabled: boolean, userId = USER): Worker => ({
  id,
  userId,
  emailNotificationsEnabled,
});

function account(sub: ReturnType<typeof subscription> | null, workers: Worker[]) {
  const calls: string[] = [];
  const state = { sub: sub === null ? null : { ...sub }, workers: workers.map((w) => ({ ...w })) };

  const client = {
    user: {
      update: vi.fn(async () => {
        calls.push("lock");
        return {};
      }),
    },
    subscription: {
      findUnique: vi.fn(async () => {
        calls.push("read-subscription");
        return state.sub === null ? null : { ...state.sub };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId: string; notificationWorkerId: string | null };
          data: { notificationWorkerId: string };
        }) => {
          calls.push("write-subscription");
          if (
            state.sub !== null &&
            state.sub.userId === where.userId &&
            state.sub.notificationWorkerId === where.notificationWorkerId
          ) {
            Object.assign(state.sub, data);
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    routine: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { userId: string; emailNotificationsEnabled: boolean };
          take: number;
        }) => {
          calls.push("read-workers");
          return state.workers
            .filter(
              (w) =>
                w.userId === where.userId &&
                w.emailNotificationsEnabled === where.emailNotificationsEnabled,
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, take)
            .map((w) => ({ id: w.id }));
        },
      ),
    },
  };

  const repair = () => repairNotificationWorkerSelection(client as never, USER, NOW);

  /** Whether a finished run of this worker would email its owner now. */
  const wouldEmail = (id: string) => {
    const owned = state.workers.find((w) => w.id === id);
    return shouldSendRunEmail({
      notification: "website-changed",
      emailNotificationsEnabled: owned?.emailNotificationsEnabled ?? false,
      entitlementAllows:
        state.sub !== null &&
        entitlementAllowsEmail(computeEntitlement(state.sub, NOW), id),
    });
  };

  return { client, state, calls, repair, wouldEmail };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("on Lite with nobody chosen", () => {
  it("does nothing when no worker has email on", async () => {
    const a = account(subscription("lite"), [worker("w1", false), worker("w2", false)]);

    expect(await a.repair()).toBe("none-enabled");
    expect(a.state.sub?.notificationWorkerId).toBeNull();
    expect(a.client.subscription.updateMany).not.toHaveBeenCalled();
  });

  it("chooses the only worker with email on", async () => {
    const a = account(subscription("lite"), [worker("w1", false), worker("w2", true)]);

    expect(await a.repair()).toBe("selected");
    expect(a.state.sub?.notificationWorkerId).toBe("w2");
  });

  it("chooses nobody when two or more have email on", async () => {
    const a = account(subscription("lite"), [
      worker("w1", true),
      worker("w2", true),
      worker("w3", true),
    ]);

    expect(await a.repair()).toBe("ambiguous");
    expect(a.state.sub?.notificationWorkerId).toBeNull();
    expect(a.client.subscription.updateMany).not.toHaveBeenCalled();
  });

  /** Another account's worker is never a candidate. */
  it("counts only this account's workers", async () => {
    const a = account(subscription("lite"), [worker("w1", true), worker("w9", true, OTHER)]);

    expect(await a.repair()).toBe("selected");
    expect(a.state.sub?.notificationWorkerId).toBe("w1");
    expect(a.client.routine.findMany.mock.calls[0][0].where).toEqual({
      userId: USER,
      emailNotificationsEnabled: true,
    });
  });

  it("writes only where nobody is chosen", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);

    await a.repair();

    expect(a.client.subscription.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, notificationWorkerId: null },
      data: { notificationWorkerId: "w1" },
    });
  });

  /** The same lock every save of a switch takes, first. */
  it("takes the account's lock before reading anything", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);

    await a.repair();

    expect(a.calls).toEqual(["lock", "read-subscription", "read-workers", "write-subscription"]);
  });
});

describe("a choice already made", () => {
  it.each([
    ["one worker with email on", [worker("w1", true)]],
    ["two with email on", [worker("w1", true), worker("w2", true)]],
    ["none with email on", [worker("w1", false)]],
  ])("is never replaced, with %s", async (_label, workers) => {
    const a = account(subscription("lite", { notificationWorkerId: "w-chosen" }), workers);

    expect(await a.repair()).toBe("already-selected");
    expect(a.state.sub?.notificationWorkerId).toBe("w-chosen");
    expect(a.client.subscription.updateMany).not.toHaveBeenCalled();
  });
});

describe("plans that let every worker email", () => {
  it.each(["standard", "pro", "trial", "beta"])("leaves %s alone", async (plan) => {
    const overrides = plan === "beta" ? { source: "admin" } : {};
    const a = account(subscription(plan, overrides), [worker("w1", true)]);

    expect(await a.repair()).toBe("not-one-worker");
    expect(a.state.sub?.notificationWorkerId).toBeNull();
    expect(a.client.routine.findMany).not.toHaveBeenCalled();
  });

  it("does not clear a choice left over from Lite", async () => {
    const a = account(subscription("standard", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2", true),
    ]);

    expect(await a.repair()).toBe("not-one-worker");
    expect(a.state.sub?.notificationWorkerId).toBe("w1");
  });

  it("leaves an account with no subscription alone", async () => {
    expect(await account(null, [worker("w1", true)]).repair()).toBe("not-one-worker");
  });

  /** Lite that has ended sends nothing, so there is nothing to choose for. */
  it("leaves an ended Lite alone", async () => {
    const a = account(subscription("lite", { state: "inactive" }), [worker("w1", true)]);

    expect(await a.repair()).toBe("not-one-worker");
  });
});

/**
 * Entering Lite from a plan where every switch counted. The subscription row is
 * what a reconciliation leaves; the workers are what the owner left on.
 */
describe("moving into Lite", () => {
  it.each(["trial", "standard", "pro"])(
    "from %s with one worker on, chooses it",
    async () => {
      const a = account(subscription("lite"), [worker("w1", true), worker("w2", false)]);

      expect(await a.repair()).toBe("selected");
      expect(a.state.sub?.notificationWorkerId).toBe("w1");
    },
  );

  it("from trial with two workers on, chooses nobody", async () => {
    const a = account(subscription("lite"), [worker("w1", true), worker("w2", true)]);

    expect(await a.repair()).toBe("ambiguous");
  });

  /** Cancelled, the chosen worker deleted, bought again. */
  it("after cancelling and buying again, chooses the one left on", async () => {
    const a = account(subscription("lite"), [worker("w3", true)]);

    expect(await a.repair()).toBe("selected");
    expect(a.state.sub?.notificationWorkerId).toBe("w3");
  });
});

describe("running it again", () => {
  it("converges on one choice and then leaves it", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);

    expect(await a.repair()).toBe("selected");
    expect(await a.repair()).toBe("already-selected");
    expect(await a.repair()).toBe("already-selected");
    expect(a.state.sub?.notificationWorkerId).toBe("w1");
    expect(a.client.subscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it("stays ambiguous however often it runs", async () => {
    const a = account(subscription("lite"), [worker("w1", true), worker("w2", true)]);

    for (let i = 0; i < 3; i += 1) {
      expect(await a.repair()).toBe("ambiguous");
    }
    expect(a.state.sub?.notificationWorkerId).toBeNull();
  });

  /** The owner chose between the read and the write: the condition holds. */
  it("does not overwrite a choice made between its read and its write", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);
    a.client.routine.findMany.mockImplementationOnce(async () => {
      if (a.state.sub !== null) a.state.sub.notificationWorkerId = "w-owner";
      return [{ id: "w1" }];
    });

    expect(await a.repair()).toBe("already-selected");
    expect(a.state.sub?.notificationWorkerId).toBe("w-owner");
  });

  /** A worker deleted by a save that finished first is not there to choose. */
  it("does not choose a worker deleted before it ran", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);
    a.state.workers = [];

    expect(await a.repair()).toBe("none-enabled");
    expect(a.state.sub?.notificationWorkerId).toBeNull();
  });
});

describe("what gets emailed afterwards", () => {
  it("lets the chosen worker email and no other", async () => {
    const a = account(subscription("lite"), [worker("w1", true), worker("w2", false)]);

    expect(a.wouldEmail("w1")).toBe(false);
    await a.repair();
    expect(a.wouldEmail("w1")).toBe(true);
    expect(a.wouldEmail("w2")).toBe(false);
  });

  it("emails from nobody while the choice is the owner's to make", async () => {
    const a = account(subscription("lite"), [worker("w1", true), worker("w2", true)]);

    await a.repair();

    expect(a.wouldEmail("w1")).toBe(false);
    expect(a.wouldEmail("w2")).toBe(false);
  });
});

describe("when it cannot run", () => {
  it("lets a failed write through, for the caller to log", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);
    a.client.subscription.updateMany.mockRejectedValueOnce(new Error("db down"));

    await expect(a.repair()).rejects.toThrow("db down");
  });

  it("opens its own transaction when given a client that can", async () => {
    const a = account(subscription("lite"), [worker("w1", true)]);
    const withTransaction = {
      $transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(a.client)),
    };

    expect(await repairNotificationWorkerSelection(withTransaction as never, USER, NOW)).toBe(
      "selected",
    );
    expect(withTransaction.$transaction).toHaveBeenCalledTimes(1);
  });
});
