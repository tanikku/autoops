import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the allowance promises, and the one thing it deliberately does not.
 *
 * These reach the primitive with the database replaced, so what they fix is
 * the shape of the writes — which row is matched, under what condition, and
 * what each answer means. **That the condition is actually exclusive is not
 * something a mock can show**: two `UPDATE`s racing each other is a property
 * of PostgreSQL, and it is the same limit `lib/execution-lease.test.ts`
 * records about the lease.
 *
 * What that leaves worth fixing here is everything a race would be lost to:
 * that the limit is a condition inside the write rather than a number read
 * back and compared, that the addition is the database's, and that nothing
 * reads the row before deciding. A test that could pass with a read-then-write
 * implementation would be checking the wrong property.
 */

const { updateMany, findUnique, create } = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { rateLimitBucket: { updateMany, findUnique, create } },
}));

const {
  AI_DRAFT_LIMIT,
  AI_DRAFT_SCOPE,
  AI_DRAFT_WINDOW_MS,
  consumeAiDraftQuota,
} = await import("@/lib/rate-limit");

const NOW = new Date("2026-08-28T12:00:00.000Z");
const USER = "google-sub-1";

/** The argument of the nth `updateMany`, counting from one. */
function updateCall(n: number) {
  return updateMany.mock.calls[n - 1][0];
}

/** Prisma's unique-constraint failure, in the shape the module tests for. */
function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

/**
 * Whether a row that began at `startedAt` would be matched by a `where` the
 * module built. **The boundary is the thing under test**, so it is evaluated
 * rather than asserted on as a date: what matters is which of the two writes
 * claims a window of a given age, not what the floor happens to be.
 */
function matchesLiveWindow(where: { windowStartedAt: { gte: Date } }, startedAt: Date) {
  return startedAt.getTime() >= where.windowStartedAt.gte.getTime();
}

function matchesExpiredWindow(
  where: { windowStartedAt: { lt: Date } },
  startedAt: Date,
) {
  return startedAt.getTime() < where.windowStartedAt.lt.getTime();
}

beforeEach(() => {
  updateMany.mockReset();
  findUnique.mockReset();
  create.mockReset();
});

describe("the allowance itself", () => {
  it("is ten drafts an hour, under one scope", () => {
    expect(AI_DRAFT_LIMIT).toBe(10);
    expect(AI_DRAFT_WINDOW_MS).toBe(3_600_000);
    expect(AI_DRAFT_SCOPE).toBe("worker-draft");
  });
});

describe("consumeAiDraftQuota — a live window", () => {
  it("allows a request that the window had room for", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeAiDraftQuota(USER, NOW)).toBe(true);
  });

  it("asks the database to do the adding", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);

    expect(updateCall(1).data).toEqual({ count: { increment: 1 } });
  });

  it("puts the limit in the condition rather than in a comparison", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);

    expect(updateCall(1).where).toMatchObject({
      userId: USER,
      scope: AI_DRAFT_SCOPE,
      count: { lt: AI_DRAFT_LIMIT },
    });
  });

  it("reads nothing before writing", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);

    expect(findUnique).not.toHaveBeenCalled();
  });

  it("denies a request once the window is full", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: "bucket-1" });

    expect(await consumeAiDraftQuota(USER, NOW)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("never reads the count back to decide, even when it denies", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: "bucket-1", count: 10 });

    await consumeAiDraftQuota(USER, NOW);

    // The row is read to find out whether it exists, and that read happens
    // after both writes have already declined to match it. Nothing compares
    // what it holds against the limit.
    const [firstWrite] = updateMany.mock.invocationCallOrder;
    expect(findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(firstWrite);
  });
});

describe("consumeAiDraftQuota — the window boundary", () => {
  it("counts a window that began exactly an hour ago as the current one", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);

    const exactlyAnHourAgo = new Date(NOW.getTime() - AI_DRAFT_WINDOW_MS);
    expect(matchesLiveWindow(updateCall(1).where, exactlyAnHourAgo)).toBe(true);
  });

  it("starts a new window on the first request past the hour", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    expect(await consumeAiDraftQuota(USER, NOW)).toBe(true);

    const justPastAnHourAgo = new Date(NOW.getTime() - AI_DRAFT_WINDOW_MS - 1);
    expect(matchesLiveWindow(updateCall(1).where, justPastAnHourAgo)).toBe(
      false,
    );
    expect(matchesExpiredWindow(updateCall(2).where, justPastAnHourAgo)).toBe(
      true,
    );
  });

  it("moves the window and counts the request that moved it, in one write", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);

    expect(updateCall(2).data).toEqual({ windowStartedAt: NOW, count: 1 });
    expect(updateCall(2).where).toMatchObject({
      userId: USER,
      scope: AI_DRAFT_SCOPE,
    });
  });
});

describe("consumeAiDraftQuota — an account with no row yet", () => {
  it("opens a window with one request counted against it", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    expect(await consumeAiDraftQuota(USER, NOW)).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        scope: AI_DRAFT_SCOPE,
        windowStartedAt: NOW,
        count: 1,
      },
    });
  });

  it("takes from the row somebody else created first", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await consumeAiDraftQuota(USER, NOW)).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateCall(3)).toEqual(updateCall(1));
  });

  it("denies the loser of that race when the winner filled the window", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await consumeAiDraftQuota(USER, NOW)).toBe(false);
    // Once, and not in a loop: after the create there is a row, so the only
    // thing left that can deny the request is a window that is genuinely full.
    expect(updateMany).toHaveBeenCalledTimes(3);
  });
});

describe("consumeAiDraftQuota — a database that will not answer", () => {
  it("throws rather than denying when the first write fails", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    await expect(consumeAiDraftQuota(USER, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });

  it("throws a create failure that is not the unique constraint", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(
      Object.assign(new Error("foreign key violated"), { code: "P2003" }),
    );

    await expect(consumeAiDraftQuota(USER, NOW)).rejects.toThrow(
      "foreign key violated",
    );
  });
});

describe("consumeAiDraftQuota — the scope", () => {
  it("names the same allowance in every write", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    await consumeAiDraftQuota(USER, NOW);

    for (const [argument] of updateMany.mock.calls) {
      expect(argument.where.scope).toBe("worker-draft");
    }
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_scope: { userId: USER, scope: "worker-draft" } },
    });
    expect(create.mock.calls[0][0].data.scope).toBe("worker-draft");
  });
});
