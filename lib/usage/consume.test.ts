import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spending part of an allowance, and the one thing a mock cannot show.
 *
 * These reach the primitive with the database replaced, so what they fix is the
 * shape of the write: which row is matched, under what condition, and what each
 * answer means. **That the condition is actually exclusive is a property of
 * PostgreSQL**, and it is the same limit `lib/rate-limit.test.ts`,
 * `lib/execution-lease.test.ts` and `lib/manual-run-slot.test.ts` all record.
 *
 * What is worth fixing here is everything a race would be lost to: that the
 * comparison travels inside the `UPDATE` rather than being made in JavaScript
 * from a number read a moment earlier, and that the limit the decision was made
 * against is matched again so it cannot have moved underneath.
 *
 * **Nothing calls this.** No run spends anything on this version.
 */

const { findUnique, updateMany } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { usageCounter: { findUnique, updateMany } },
}));

const { consumeUsage } = await import("@/lib/usage/consume");

const PERIOD = "usage-period-1";

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset();
});

/** The argument of the only `updateMany`. */
function updateCall() {
  return updateMany.mock.calls[0][0];
}

describe("taking from an allowance", () => {
  it("takes what was asked for when there is room", async () => {
    findUnique.mockResolvedValue({ limit: 150 });
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeUsage(PERIOD, "aiProcessing", 1)).toEqual({
      granted: true,
      limit: 150,
    });
  });

  it("addresses the one counter for this period and kind", async () => {
    findUnique.mockResolvedValue({ limit: 150 });
    updateMany.mockResolvedValue({ count: 1 });

    await consumeUsage(PERIOD, "discovery", 1);

    expect(findUnique.mock.calls[0][0].where).toEqual({
      periodId_kind: { periodId: PERIOD, kind: "discovery" },
    });
    expect(updateCall().where.periodId).toBe(PERIOD);
    expect(updateCall().where.kind).toBe("discovery");
  });

  /**
   * **The comparison is in the `where`, not in JavaScript.** A version that
   * read the row, compared, and then wrote would let two callers through at the
   * boundary, and the account would end the period over its allowance.
   */
  it("makes the decision inside the write", async () => {
    findUnique.mockResolvedValue({ limit: 150 });
    updateMany.mockResolvedValue({ count: 1 });

    await consumeUsage(PERIOD, "aiProcessing", 1);

    expect(updateCall().where.used).toEqual({ lte: 149 });
    expect(updateCall().data).toEqual({ used: { increment: 1 } });
  });

  /**
   * **The limit is matched again in the condition.** Prisma cannot compare two
   * columns, so the number has to come from a read — and re-matching it is what
   * makes that safe: if the stored limit moved in between, nothing is taken.
   */
  it("matches the limit the decision was made against", async () => {
    findUnique.mockResolvedValue({ limit: 30 });
    updateMany.mockResolvedValue({ count: 0 });

    await consumeUsage(PERIOD, "manualRun", 1);

    expect(updateCall().where.limit).toBe(30);
  });

  it("scales the room it asks for to the units it wants", async () => {
    findUnique.mockResolvedValue({ limit: 300 });
    updateMany.mockResolvedValue({ count: 1 });

    await consumeUsage(PERIOD, "aiProcessing", 5);

    expect(updateCall().where.used).toEqual({ lte: 295 });
    expect(updateCall().data).toEqual({ used: { increment: 5 } });
  });

  /**
   * **Units, not requests.** What one call to a model is worth is decided by
   * the caller from a table that can change; the counter holds product units,
   * so a re-weighting is a constant rather than a migration.
   */
  it("takes more than one unit for a single spend", async () => {
    findUnique.mockResolvedValue({ limit: 50 });
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeUsage(PERIOD, "aiProcessing", 3)).toEqual({
      granted: true,
      limit: 50,
    });
  });
});

describe("an allowance that is spent", () => {
  it("takes nothing and says so", async () => {
    findUnique.mockResolvedValue({ limit: 30 });
    updateMany.mockResolvedValue({ count: 0 });

    expect(await consumeUsage(PERIOD, "manualRun", 1)).toEqual({
      granted: false,
      reason: "exhausted",
    });
  });

  /**
   * **A spend larger than the whole allowance cannot squeeze in.** The
   * condition becomes one nothing satisfies rather than one that happens to
   * pass when the counter is empty.
   */
  it("refuses a spend bigger than the allowance", async () => {
    findUnique.mockResolvedValue({ limit: 10 });
    updateMany.mockResolvedValue({ count: 0 });

    await consumeUsage(PERIOD, "discovery", 11);

    expect(updateCall().where.used).toEqual({ lte: -1 });
  });
});

describe("a counter that is not there", () => {
  /**
   * Distinguished from an exhausted allowance because they mean opposite
   * things: one is an account that has spent what it had, the other is a period
   * that was never opened properly.
   */
  it("is its own answer, and writes nothing", async () => {
    findUnique.mockResolvedValue(null);

    expect(await consumeUsage(PERIOD, "aiProcessing", 1)).toEqual({
      granted: false,
      reason: "unknown-counter",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

/**
 * **Spent on the way in, and never given back.** The hourly allowances follow
 * the same rule for the same reason: a call that failed was still made, and a
 * refund would be a second way for two callers to disagree about what is left.
 */
describe("what the module deliberately does not offer", () => {
  it("has no way to return units", async () => {
    const exported = await import("@/lib/usage/consume");

    expect(Object.keys(exported)).toEqual(["consumeUsage"]);
  });
});

describe("an amount that is not an amount", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("refuses %s before reading anything", async (_label, units) => {
    await expect(consumeUsage(PERIOD, "aiProcessing", units)).rejects.toThrow();

    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
