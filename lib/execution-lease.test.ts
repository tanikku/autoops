import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the lease promises, and the one thing it deliberately does not.
 *
 * These reach the primitive with the database replaced, so what they fix is
 * the shape of the two writes — which row is matched, under what condition,
 * and what each answer means. **That the condition is actually exclusive is
 * not something a mock can show**: a single `UPDATE` racing another `UPDATE`
 * is a property of PostgreSQL, and it is verified the same way
 * `claimRoutineSlot` is, which is to say by hand against a running database.
 *
 * The distinction worth keeping in view: a mock proves the release refuses to
 * write when the token does not match. Only a real database proves two callers
 * cannot both be told they acquired it.
 */

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { routine: { updateMany } },
}));

const {
  acquireExecutionLease,
  EXECUTION_LEASE_MS,
  releaseExecutionLease,
} = await import("@/lib/execution-lease");

const NOW = new Date("2026-08-10T12:00:00.000Z");
const ROUTINE = "worker-1";

/** The single argument the primitive handed Prisma. */
function lastCall() {
  return updateMany.mock.calls[updateMany.mock.calls.length - 1][0];
}

beforeEach(() => {
  updateMany.mockReset();
});

describe("EXECUTION_LEASE_MS", () => {
  it("is fifteen minutes", () => {
    expect(EXECUTION_LEASE_MS).toBe(900_000);
  });
});

describe("acquireExecutionLease", () => {
  it("grants a lease when nothing holds one", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await acquireExecutionLease(ROUTINE, NOW)).not.toBeNull();
  });

  it("reports contention when the write matched nothing", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(await acquireExecutionLease(ROUTINE, NOW)).toBeNull();
  });

  /**
   * Free and lapsed are the two ways a worker is available, and the condition
   * has to cover both — matching only `null` would let one lost process block
   * a worker for good.
   */
  it("takes a worker that is free or whose lease has lapsed", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireExecutionLease(ROUTINE, NOW);

    expect(lastCall().where).toEqual({
      id: ROUTINE,
      OR: [
        { executionLeaseUntil: null },
        { executionLeaseUntil: { lt: NOW } },
      ],
    });
  });

  it("writes the owner and the moment the lease lapses", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const lease = await acquireExecutionLease(ROUTINE, NOW);

    expect(lastCall().data).toEqual({
      executionOwner: lease?.token,
      executionLeaseUntil: new Date(NOW.getTime() + EXECUTION_LEASE_MS),
    });
  });

  it("returns the expiry it wrote", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const lease = await acquireExecutionLease(ROUTINE, NOW);

    expect(lease?.expiresAt).toEqual(
      new Date(NOW.getTime() + EXECUTION_LEASE_MS),
    );
  });

  /**
   * A token that repeated would let one run release another's lease, which is
   * the single failure the token exists to prevent.
   */
  it("mints a different token every time", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const first = await acquireExecutionLease(ROUTINE, NOW);
    const second = await acquireExecutionLease(ROUTINE, NOW);

    expect(first?.token).not.toBe(second?.token);
  });

  it("lets a database failure through", async () => {
    updateMany.mockRejectedValue(new Error("down"));

    await expect(acquireExecutionLease(ROUTINE, NOW)).rejects.toThrow("down");
  });
});

describe("releaseExecutionLease", () => {
  it("gives back a lease it holds", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await releaseExecutionLease(ROUTINE, "token-a")).toBe("released");
  });

  it("clears both columns", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await releaseExecutionLease(ROUTINE, "token-a");

    expect(lastCall().data).toEqual({
      executionOwner: null,
      executionLeaseUntil: null,
    });
  });

  /**
   * **The condition that keeps an overrun run from clearing its successor's
   * lease.** Matching on the id alone would do exactly that.
   */
  it("matches on the token as well as the worker", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await releaseExecutionLease(ROUTINE, "token-a");

    expect(lastCall().where).toEqual({
      id: ROUTINE,
      executionOwner: "token-a",
    });
  });

  it("reports not-held when the lease was no longer ours", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(await releaseExecutionLease(ROUTINE, "token-a")).toBe("not-held");
  });

  it("does not throw when the lease was no longer ours", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      releaseExecutionLease(ROUTINE, "token-a"),
    ).resolves.toBeDefined();
  });

  /**
   * The sequence the token defends against, end to end: a lease lapses, a
   * second run takes it, and the first finally tidies up. The write must miss.
   */
  it("leaves a lease taken over by someone else alone", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const first = await acquireExecutionLease(ROUTINE, NOW);

    const later = new Date(NOW.getTime() + EXECUTION_LEASE_MS + 1);
    const second = await acquireExecutionLease(ROUTINE, later);

    // The stale release now finds no row: the owner column holds the newer token.
    updateMany.mockResolvedValue({ count: 0 });
    const outcome = await releaseExecutionLease(ROUTINE, first!.token);

    expect(outcome).toBe("not-held");
    expect(lastCall().where.executionOwner).toBe(first!.token);
    expect(lastCall().where.executionOwner).not.toBe(second!.token);
  });

  /**
   * Release runs in the cleanup of whatever it is releasing, so a throw here
   * would replace that run's own outcome with this one's failure.
   */
  it("reports a failed write rather than throwing", async () => {
    updateMany.mockRejectedValue(new Error("down"));

    expect(await releaseExecutionLease(ROUTINE, "token-a")).toBe("failed");
  });
});
