import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the slot promises, and the one thing it deliberately does not.
 *
 * These reach the primitive with the database replaced, so what they fix is the
 * shape of the writes — which row is matched, under what condition, and what
 * each answer means. **That the condition is actually exclusive is not something
 * a mock can show**: two `UPDATE`s racing each other is a property of
 * PostgreSQL, and it is the same limit `lib/execution-lease.test.ts` and
 * `lib/rate-limit.test.ts` both record.
 *
 * What is worth fixing here is everything a race would be lost to: that a slot
 * being free is a condition inside the write rather than something read back and
 * compared, that the expiry boundary is where the lease's is, and that a release
 * only lands while the token still matches.
 */

const { updateMany, findUnique, create } = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { manualRunSlot: { updateMany, findUnique, create } },
}));

const {
  acquireManualRunSlot,
  MANUAL_RUN_CONCURRENCY_LIMIT,
  MANUAL_RUN_SLOT_TTL_MS,
  releaseManualRunSlot,
} = await import("@/lib/manual-run-slot");

const NOW = new Date("2026-08-28T12:00:00.000Z");
const USER = "google-sub-1";

/** The argument of the nth `updateMany`, counting from one. */
function updateCall(n: number) {
  return updateMany.mock.calls[n - 1][0];
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

/**
 * Whether a row whose claim lapses at `leaseUntil` would be matched by the
 * `where` the module built. **The boundary is the thing under test**, so it is
 * evaluated rather than asserted on as a date.
 */
function matchesFreeSlot(
  where: { OR: [{ leaseUntil: null }, { leaseUntil: { lt: Date } }] },
  leaseUntil: Date,
) {
  return leaseUntil.getTime() < where.OR[1].leaseUntil.lt.getTime();
}

beforeEach(() => {
  updateMany.mockReset();
  findUnique.mockReset();
  create.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the guard itself", () => {
  it("allows one run at a time, recovering after fifteen minutes", () => {
    expect(MANUAL_RUN_CONCURRENCY_LIMIT).toBe(1);
    expect(MANUAL_RUN_SLOT_TTL_MS).toBe(900_000);
  });
});

describe("acquireManualRunSlot", () => {
  it("grants the slot when nothing holds it", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const slot = await acquireManualRunSlot(USER, NOW);

    expect(slot).not.toBeNull();
    expect(slot?.slotNumber).toBe(0);
    expect(slot?.expiresAt).toEqual(
      new Date(NOW.getTime() + MANUAL_RUN_SLOT_TTL_MS),
    );
  });

  it("addresses the account's own slot, and writes a token with an expiry", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const slot = await acquireManualRunSlot(USER, NOW);

    expect(updateCall(1).where).toMatchObject({ userId: USER, slotNumber: 0 });
    expect(updateCall(1).data).toEqual({
      owner: slot?.token,
      leaseUntil: slot?.expiresAt,
    });
  });

  it("refuses while somebody holds it, without reading the row first", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ userId: USER, slotNumber: 0 });

    expect(await acquireManualRunSlot(USER, NOW)).toBeNull();
    // The read happens after the conditional write has already declined, and
    // only to tell an occupied slot from a row that has never existed.
    expect(findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateMany.mock.invocationCallOrder[0],
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps accounts apart", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireManualRunSlot("other-user", NOW);

    expect(updateCall(1).where).toMatchObject({ userId: "other-user" });
  });
});

describe("acquireManualRunSlot — the expiry boundary", () => {
  it("still refuses a claim that lapses exactly now", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireManualRunSlot(USER, NOW);

    // `leaseUntil < now`, as the execution lease has it: the instant of expiry
    // still belongs to whoever holds the slot.
    expect(matchesFreeSlot(updateCall(1).where, NOW)).toBe(false);
  });

  it("frees a claim that lapsed a millisecond ago", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireManualRunSlot(USER, NOW);

    expect(
      matchesFreeSlot(updateCall(1).where, new Date(NOW.getTime() - 1)),
    ).toBe(true);
  });

  it("treats a row with no claim on it as free", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireManualRunSlot(USER, NOW);

    expect(updateCall(1).where.OR[0]).toEqual({ leaseUntil: null });
  });
});

describe("acquireManualRunSlot — an account with no row yet", () => {
  it("creates the slot it is about to hold", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ userId: USER, slotNumber: 0 });

    const slot = await acquireManualRunSlot(USER, NOW);

    expect(slot).not.toBeNull();
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        slotNumber: 0,
        owner: slot?.token,
        leaseUntil: slot?.expiresAt,
      },
    });
  });

  it("takes the row somebody else created first, when they have let it go", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await acquireManualRunSlot(USER, NOW)).not.toBeNull();
    // Once, and not in a loop: after the create there is a row, and asking the
    // same question again would spin.
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("refuses when the request that created the row is still holding it", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await acquireManualRunSlot(USER, NOW)).toBeNull();
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("acquireManualRunSlot — a database that will not answer", () => {
  it("throws rather than refusing when the write fails", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    await expect(acquireManualRunSlot(USER, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });

  it("throws a create failure that is not the unique constraint", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(
      Object.assign(new Error("foreign key violated"), { code: "P2003" }),
    );

    await expect(acquireManualRunSlot(USER, NOW)).rejects.toThrow(
      "foreign key violated",
    );
  });
});

describe("releaseManualRunSlot", () => {
  it("clears the slot it was given", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await releaseManualRunSlot(USER, 0, "token-1")).toBe("released");
    expect(updateCall(1)).toEqual({
      where: { userId: USER, slotNumber: 0, owner: "token-1" },
      data: { owner: null, leaseUntil: null },
    });
  });

  it("writes nothing for a token that no longer holds it", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(await releaseManualRunSlot(USER, 0, "stale-token")).toBe("not-held");
    // Not silently: a run that outlived the recovery window is the only
    // evidence that the window is too short.
    expect(console.warn).toHaveBeenCalled();
  });

  it("cannot free a slot a newer run has taken over", async () => {
    // The database answers zero because `owner` is the newer token; what
    // matters is that the old holder's token is what was asked for.
    updateMany.mockResolvedValue({ count: 0 });

    expect(await releaseManualRunSlot(USER, 0, "old-token")).toBe("not-held");
    expect(updateCall(1).where.owner).toBe("old-token");
  });

  it("reports a failed release rather than throwing it", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    expect(await releaseManualRunSlot(USER, 0, "token-1")).toBe("failed");
    expect(console.error).toHaveBeenCalled();
  });
});
