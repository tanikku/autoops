import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the quota asks the database, and in what order.
 *
 * **The lock is the part that cannot be tested here**, and saying so plainly
 * matters more than the assertions below: that a second transaction waits at
 * the `UPDATE` is a property of PostgreSQL, and a mock that returns
 * immediately proves nothing about it. It was measured against local
 * PostgreSQL instead, the same way `claimRoutineSlot`'s exclusivity is.
 *
 * What these do fix is everything that would quietly disable that lock: that
 * the account row is written rather than read, that the write is the
 * self-assignment Prisma actually turns into an `UPDATE`, and that the counts
 * happen after it and are scoped to the account.
 */

const { update, count } = vi.hoisted(() => ({
  update: vi.fn(),
  count: vi.fn(),
}));

const clientStub = { user: { update }, routine: { count } };

const {
  ACTIVE_WORKER_LIMIT,
  claimWorkerActivation,
  claimWorkerCreation,
  TOTAL_WORKER_LIMIT,
} = await import("@/lib/worker-quota");

/** Stands in for a transaction client: the two tables the quota touches. */
const client = clientStub as unknown as Parameters<
  typeof claimWorkerCreation
>[0];

const USER = "google-sub-1";

beforeEach(() => {
  update.mockReset().mockResolvedValue({ id: USER });
  count.mockReset();
});

describe("the limits themselves", () => {
  it("is twenty workers, ten of them active", () => {
    expect(TOTAL_WORKER_LIMIT).toBe(20);
    expect(ACTIVE_WORKER_LIMIT).toBe(10);
  });
});

describe("the account lock", () => {
  it("writes the account row rather than reading it", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "draft");

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

    await claimWorkerCreation(client, USER, "active");
    await claimWorkerActivation(client, USER);

    for (const [argument] of update.mock.calls) {
      expect(argument.data).toEqual({ id: USER });
      expect(Object.keys(argument.data)).toHaveLength(1);
    }
  });

  it("takes the lock before counting anything", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "active");

    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      count.mock.invocationCallOrder[0],
    );
  });
});

describe("claimWorkerCreation", () => {
  it("allows a create below the limit", async () => {
    count.mockResolvedValue(TOTAL_WORKER_LIMIT - 1);

    expect(await claimWorkerCreation(client, USER, "draft")).toBeNull();
  });

  it("refuses a create at the limit", async () => {
    count.mockResolvedValue(TOTAL_WORKER_LIMIT);

    expect(await claimWorkerCreation(client, USER, "draft")).toBe("total");
  });

  it("counts every worker the account has, whatever its state", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "draft");

    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it("asks about the active limit only for a worker that would be active", async () => {
    count.mockResolvedValue(0);

    await claimWorkerCreation(client, USER, "paused");

    expect(count).toHaveBeenCalledTimes(1);
  });

  it("counts the account's active workers when one more would be", async () => {
    count
      .mockResolvedValueOnce(TOTAL_WORKER_LIMIT - 1)
      .mockResolvedValueOnce(0);

    await claimWorkerCreation(client, USER, "active");

    expect(count).toHaveBeenNthCalledWith(2, {
      where: { userId: USER, status: "active" },
    });
  });

  it("allows an active create below the active limit", async () => {
    count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(ACTIVE_WORKER_LIMIT - 1);

    expect(await claimWorkerCreation(client, USER, "active")).toBeNull();
  });

  it("refuses an active create at the active limit", async () => {
    count.mockResolvedValueOnce(0).mockResolvedValueOnce(ACTIVE_WORKER_LIMIT);

    expect(await claimWorkerCreation(client, USER, "active")).toBe("active");
  });

  it("answers with the total limit first when both are reached", async () => {
    count.mockResolvedValue(TOTAL_WORKER_LIMIT);

    expect(await claimWorkerCreation(client, USER, "active")).toBe("total");
    // The active count is never asked for: there is no room for the row at all.
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("lets a database failure through rather than calling it a rejection", async () => {
    count.mockRejectedValue(new Error("connection terminated"));

    await expect(claimWorkerCreation(client, USER, "draft")).rejects.toThrow(
      "connection terminated",
    );
  });
});

describe("claimWorkerActivation", () => {
  it("allows a transition below the limit", async () => {
    count.mockResolvedValue(ACTIVE_WORKER_LIMIT - 1);

    expect(await claimWorkerActivation(client, USER)).toBeNull();
  });

  it("refuses a transition at the limit", async () => {
    count.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    expect(await claimWorkerActivation(client, USER)).toBe("active");
  });

  it("counts only this account's active workers, and nothing else", async () => {
    count.mockResolvedValue(0);

    await claimWorkerActivation(client, USER);

    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({
      where: { userId: USER, status: "active" },
    });
  });

  it("lets a database failure through", async () => {
    update.mockRejectedValue(new Error("connection terminated"));

    await expect(claimWorkerActivation(client, USER)).rejects.toThrow(
      "connection terminated",
    );
  });
});
