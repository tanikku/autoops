import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which worker emails its owner, on a plan that allows one.
 *
 * **Against an in-memory account**, so what is fixed is the state a save leaves
 * behind — the chosen worker, which workers have email on — and the order the
 * lock and the reads come in, rather than which calls happened to be made.
 */

const prismaMock = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

const {
  applyEmailSelection,
  planEmailSelection,
} = await import("@/lib/notification-worker");
const { deleteRoutine } = await import("@/lib/routines");

const USER = "user-1";
const OTHER = "user-2";

type Worker = { id: string; userId: string; name: string; emailNotificationsEnabled: boolean };

function subscription(plan: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    plan,
    state: plan === "trial" ? "trialing" : "active",
    trialStartedAt: plan === "trial" ? new Date("2026-10-01T00:00:00Z") : null,
    trialEndsAt: plan === "trial" ? new Date("2099-01-01T00:00:00Z") : null,
    trialConsumedAt: null,
    trialForfeitedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    notificationWorkerId: null as string | null,
    source: "stripe",
    expiresAt: null,
    ...overrides,
  };
}

function account(
  sub: ReturnType<typeof subscription> | null,
  workers: Worker[],
) {
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
      update: vi.fn(async ({ where, data }: { where: { userId: string }; data: object }) => {
        calls.push("write-subscription");
        if (state.sub === null || state.sub.userId !== where.userId) {
          throw new Error("no such subscription");
        }
        Object.assign(state.sub, data);
        return { ...state.sub };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId: string; notificationWorkerId: string };
          data: object;
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
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id: string; userId: string; emailNotificationsEnabled: boolean };
        }) => {
          calls.push("read-worker");
          const found = state.workers.find(
            (w) =>
              w.id === where.id &&
              w.userId === where.userId &&
              w.emailNotificationsEnabled === where.emailNotificationsEnabled,
          );
          return found === undefined ? null : { id: found.id, name: found.name };
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; userId: string }; data: Partial<Worker> }) => {
          calls.push("write-worker");
          const matched = state.workers.filter((w) => w.id === where.id && w.userId === where.userId);
          matched.forEach((w) => Object.assign(w, data));
          return { count: matched.length };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        calls.push("delete-worker");
        const before = state.workers.length;
        state.workers = state.workers.filter((w) => !(w.id === where.id && w.userId === where.userId));
        return { count: before - state.workers.length };
      }),
    },
  };

  /** A save as the actions make one: decide, write the worker, carry out. */
  async function save(input: {
    routineId: string | null;
    emailEnabled: boolean;
    confirmSwitch?: boolean;
    newWorkerName?: string;
  }) {
    const decision = await planEmailSelection(client as never, {
      userId: USER,
      routineId: input.routineId,
      emailEnabled: input.emailEnabled,
      confirmSwitch: input.confirmSwitch ?? false,
    });

    if (!decision.allowed) {
      return decision;
    }

    let id = input.routineId;
    if (id === null) {
      id = `worker-${state.workers.length + 1}`;
      state.workers.push({
        id,
        userId: USER,
        name: input.newWorkerName ?? id,
        emailNotificationsEnabled: input.emailEnabled,
      });
    } else {
      const worker = state.workers.find((w) => w.id === id);
      if (worker !== undefined) {
        worker.emailNotificationsEnabled = input.emailEnabled;
      }
    }

    await applyEmailSelection(client as never, { userId: USER, routineId: id, plan: decision.plan });
    return decision;
  }

  const emailing = () =>
    state.workers.filter((w) => w.userId === USER && w.emailNotificationsEnabled).map((w) => w.id);

  return { client, state, calls, save, emailing };
}

const worker = (id: string, emailNotificationsEnabled = false, userId = USER): Worker => ({
  id,
  userId,
  name: `Name of ${id}`,
  emailNotificationsEnabled,
});

beforeEach(() => {
  prismaMock.$transaction.mockReset();
});

describe("a Lite account choosing its emailing worker", () => {
  it("makes the first worker switched on the chosen one", async () => {
    const db = account(subscription("lite"), []);

    const decision = await db.save({ routineId: null, emailEnabled: true });

    expect(decision.allowed).toBe(true);
    expect(db.state.sub?.notificationWorkerId).toBe("worker-1");
    expect(db.emailing()).toEqual(["worker-1"]);
  });

  it("keeps the chosen worker chosen when it is saved again", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [worker("w1", true)]);

    await db.save({ routineId: "w1", emailEnabled: true });

    expect(db.state.sub?.notificationWorkerId).toBe("w1");
    expect(db.client.subscription.update).not.toHaveBeenCalled();
  });

  it("refuses a second worker without the owner's say, and writes nothing", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
    ]);

    const decision = await db.save({ routineId: "w2", emailEnabled: true });

    expect(decision).toEqual({ allowed: false, currentWorkerName: "Name of w1" });
    expect(db.state.sub?.notificationWorkerId).toBe("w1");
    expect(db.emailing()).toEqual(["w1"]);
    expect(db.calls).not.toContain("write-subscription");
    expect(db.calls).not.toContain("write-worker");
  });

  it("refuses a new worker the same way, before it exists", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [worker("w1", true)]);

    const decision = await db.save({ routineId: null, emailEnabled: true });

    expect(decision.allowed).toBe(false);
    expect(db.state.workers).toHaveLength(1);
  });

  it("moves email to the new worker when the owner confirms, and switches the old one off", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
    ]);

    await db.save({ routineId: "w2", emailEnabled: true, confirmSwitch: true });

    expect(db.state.sub?.notificationWorkerId).toBe("w2");
    expect(db.emailing()).toEqual(["w2"]);
  });

  it("leaves nobody chosen when the chosen worker's email is switched off", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
    ]);

    await db.save({ routineId: "w1", emailEnabled: false });

    expect(db.state.sub?.notificationWorkerId).toBeNull();
    expect(db.emailing()).toEqual([]);
  });

  it("leaves the choice alone when another worker's email is switched off", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
    ]);

    await db.save({ routineId: "w2", emailEnabled: false });

    expect(db.state.sub?.notificationWorkerId).toBe("w1");
  });

  it("takes the account lock before reading anything", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
    ]);

    await db.save({ routineId: "w2", emailEnabled: true, confirmSwitch: true });

    expect(db.calls[0]).toBe("lock");
    expect(db.calls.indexOf("lock")).toBeLessThan(db.calls.indexOf("read-subscription"));
  });
});

/**
 * A choice carried in from another plan, or left pointing somewhere useless.
 *
 * **Only a live choice counts**: an existing worker of this account with its
 * email on. Anything else is nobody chosen — never somebody picked for them.
 */
describe("a choice carried over or gone stale", () => {
  it("honours a still-valid choice after a downgrade", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2", true),
    ]);

    const decision = await db.save({ routineId: "w2", emailEnabled: true });

    expect(decision.allowed).toBe(false);
  });

  it.each([
    ["a worker whose email is off", [worker("w1", false), worker("w2")]],
    ["a worker that no longer exists", [worker("w2")]],
    ["another account's worker", [worker("w1", true, OTHER), worker("w2")]],
  ])("treats a choice pointing at %s as nobody chosen", async (_label, workers) => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), workers);

    const decision = await db.save({ routineId: "w2", emailEnabled: true });

    expect(decision.allowed).toBe(true);
    expect(db.state.sub?.notificationWorkerId).toBe("w2");
  });

  /** Another account's worker is never switched off on this account's behalf. */
  it("never touches another account's worker", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true, OTHER),
      worker("w2"),
    ]);

    await db.save({ routineId: "w2", emailEnabled: true, confirmSwitch: true });

    expect(db.state.workers.find((w) => w.id === "w1")?.emailNotificationsEnabled).toBe(true);
  });
});

describe("plans that let every worker email", () => {
  it.each(["standard", "pro", "trial", "beta"])(
    "saves %s workers' switches as given, choosing nothing",
    async (plan) => {
      const db = account(subscription(plan, { notificationWorkerId: "w1" }), [
        worker("w1", true),
        worker("w2"),
      ]);

      const decision = await db.save({ routineId: "w2", emailEnabled: true });

      expect(decision).toEqual({ allowed: true, plan: { kind: "unrestricted" } });
      expect(db.emailing()).toEqual(["w1", "w2"]);
      expect(db.state.sub?.notificationWorkerId).toBe("w1");
    },
  );

  it("saves as given for an account with no plan yet", async () => {
    const db = account(null, []);

    const decision = await db.save({ routineId: null, emailEnabled: true });

    expect(decision).toEqual({ allowed: true, plan: { kind: "unrestricted" } });
  });

  it("does not stop a save over a plan it cannot read", async () => {
    const db = account(subscription("enterprise"), []);

    const decision = await db.save({ routineId: null, emailEnabled: true });

    expect(decision).toEqual({ allowed: true, plan: { kind: "unrestricted" } });
  });
});

/**
 * **Two saves cannot both win.** Each takes the account lock before it reads, so
 * the database runs them one after the other; the second sees the first's
 * choice. Whatever order they land in, one worker emails and it is the chosen
 * one.
 */
describe("two switches for one account", () => {
  it.each([
    ["w2 then w3", ["w2", "w3"]],
    ["w3 then w2", ["w3", "w2"]],
  ])("leave exactly one emailing worker, the chosen one (%s)", async (_label, order) => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
      worker("w3"),
    ]);

    for (const id of order) {
      await db.save({ routineId: id, emailEnabled: true, confirmSwitch: true });
    }

    expect(db.emailing()).toEqual([order[1]]);
    expect(db.state.sub?.notificationWorkerId).toBe(order[1]);
  });

  it("refuses the second switch that was confirmed against a choice that has since moved", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
      worker("w3"),
    ]);

    await db.save({ routineId: "w2", emailEnabled: true, confirmSwitch: true });
    const second = await db.save({ routineId: "w3", emailEnabled: true });

    expect(second).toEqual({ allowed: false, currentWorkerName: "Name of w2" });
    expect(db.emailing()).toEqual(["w2"]);
  });
});

describe("deleting a worker", () => {
  function inTransaction(db: ReturnType<typeof account>) {
    prismaMock.$transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) =>
      run(db.client),
    );
  }

  it("forgets the chosen worker, choosing nobody in its place", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2", false),
    ]);
    inTransaction(db);

    expect(await deleteRoutine("w1", USER)).toBe(true);

    expect(db.state.sub?.notificationWorkerId).toBeNull();
    expect(db.emailing()).toEqual([]);
  });

  it("leaves the choice alone when another worker is deleted", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true),
      worker("w2"),
    ]);
    inTransaction(db);

    await deleteRoutine("w2", USER);

    expect(db.state.sub?.notificationWorkerId).toBe("w1");
  });

  it("locks the account before deleting, the same order a save takes", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [worker("w1", true)]);
    inTransaction(db);

    await deleteRoutine("w1", USER);

    expect(db.calls.slice(0, 2)).toEqual(["lock", "delete-worker"]);
  });

  it("changes nothing for a worker this account does not own", async () => {
    const db = account(subscription("lite", { notificationWorkerId: "w1" }), [
      worker("w1", true, OTHER),
    ]);
    inTransaction(db);

    expect(await deleteRoutine("w1", USER)).toBe(false);
    expect(db.state.sub?.notificationWorkerId).toBe("w1");
    expect(db.state.workers).toHaveLength(1);
  });
});
