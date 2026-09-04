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

const rateLimit = await import("@/lib/rate-limit");
const {
  AI_DRAFT_LIMIT,
  AI_DRAFT_SCOPE,
  AI_DRAFT_WINDOW_MS,
  consumeAiDraftQuota,
  consumeCreatorAnalysisQuota,
  consumeManualRunQuota,
  CREATOR_ANALYSIS_LIMIT,
  CREATOR_ANALYSIS_SCOPE,
  CREATOR_ANALYSIS_WINDOW_MS,
  MANUAL_RUN_LIMIT,
  MANUAL_RUN_SCOPE,
  MANUAL_RUN_WINDOW_MS,
} = rateLimit;

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

describe("the allowances", () => {
  it("keeps drafting and running apart", () => {
    expect(MANUAL_RUN_LIMIT).toBe(20);
    expect(MANUAL_RUN_WINDOW_MS).toBe(3_600_000);
    expect(MANUAL_RUN_SCOPE).toBe("manual-run");
    expect(AI_DRAFT_SCOPE).toBe("worker-draft");
    expect(MANUAL_RUN_SCOPE).not.toBe(AI_DRAFT_SCOPE);
  });

  /**
   * **Three product decisions about three actions, each with its own
   * constants.** They happen to share an hour; one of them moving must not move
   * the others, which is why none of them reads another's.
   */
  it("gives Creator analysis its own, smaller allowance", () => {
    expect(CREATOR_ANALYSIS_LIMIT).toBe(5);
    expect(CREATOR_ANALYSIS_WINDOW_MS).toBe(3_600_000);
    expect(CREATOR_ANALYSIS_SCOPE).toBe("creator-analysis");

    expect(CREATOR_ANALYSIS_LIMIT).toBeLessThan(AI_DRAFT_LIMIT);
    expect(CREATOR_ANALYSIS_LIMIT).toBeLessThan(MANUAL_RUN_LIMIT);
  });

  it("gives each allowance a scope of its own", () => {
    const scopes = [AI_DRAFT_SCOPE, MANUAL_RUN_SCOPE, CREATOR_ANALYSIS_SCOPE];

    expect(new Set(scopes).size).toBe(scopes.length);
  });

  /**
   * **There is no "spend some quota" API, and that is the design.** A caller
   * that could name its own scope or its own limit could invent an allowance
   * nobody decided on, or spend one action's against another's. What is
   * exported is one function per action, each naming its own constants.
   */
  it("exposes only the named allowances", () => {
    const exported = Object.keys(rateLimit).filter((name) =>
      name.startsWith("consume"),
    );

    expect(exported.sort()).toEqual([
      "consumeAiDraftQuota",
      "consumeCreatorAnalysisQuota",
      "consumeManualRunQuota",
    ]);
    expect(consumeManualRunQuota.length).toBeLessThanOrEqual(2);
    expect(consumeCreatorAnalysisQuota.length).toBeLessThanOrEqual(2);
  });

  /** Nothing gives a count back, for any of the three. */
  it("offers no way to refund one", () => {
    const refundish = Object.keys(rateLimit).filter((name) =>
      /refund|release|restore|giveBack/i.test(name),
    );

    expect(refundish).toEqual([]);
  });
});

describe("consumeManualRunQuota — a live window", () => {
  it("allows the twentieth run of the hour", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeManualRunQuota(USER, NOW)).toBe(true);
    expect(updateCall(1).where).toMatchObject({
      userId: USER,
      scope: MANUAL_RUN_SCOPE,
      count: { lt: MANUAL_RUN_LIMIT },
    });
    expect(updateCall(1).data).toEqual({ count: { increment: 1 } });
  });

  it("refuses the twenty-first", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: "bucket-1" });

    expect(await consumeManualRunQuota(USER, NOW)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("reads nothing before writing", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeManualRunQuota(USER, NOW);

    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("consumeManualRunQuota — the window boundary", () => {
  it("counts a window that began exactly an hour ago as the current one", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeManualRunQuota(USER, NOW);

    const exactlyAnHourAgo = new Date(NOW.getTime() - MANUAL_RUN_WINDOW_MS);
    expect(matchesLiveWindow(updateCall(1).where, exactlyAnHourAgo)).toBe(true);
  });

  it("starts a new window on the first run past the hour", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    expect(await consumeManualRunQuota(USER, NOW)).toBe(true);

    const justPast = new Date(NOW.getTime() - MANUAL_RUN_WINDOW_MS - 1);
    expect(matchesLiveWindow(updateCall(1).where, justPast)).toBe(false);
    expect(matchesExpiredWindow(updateCall(2).where, justPast)).toBe(true);
    expect(updateCall(2).data).toEqual({ windowStartedAt: NOW, count: 1 });
  });
});

describe("consumeManualRunQuota — an account with no row yet", () => {
  it("opens a window with one run counted against it", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    expect(await consumeManualRunQuota(USER, NOW)).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        scope: MANUAL_RUN_SCOPE,
        windowStartedAt: NOW,
        count: 1,
      },
    });
  });

  it("takes the row somebody else created first", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await consumeManualRunQuota(USER, NOW)).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it("denies the loser of that race when the winner filled the window", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await consumeManualRunQuota(USER, NOW)).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it("throws a create failure that is not the unique constraint", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(
      Object.assign(new Error("foreign key violated"), { code: "P2003" }),
    );

    await expect(consumeManualRunQuota(USER, NOW)).rejects.toThrow(
      "foreign key violated",
    );
  });

  it("throws rather than denying when the write fails", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    await expect(consumeManualRunQuota(USER, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });
});

/**
 * **One account, two allowances, and nothing in common but the table.** The
 * unique key is the account *and* the scope, so a run and a draft address
 * different rows; what these fix is that neither function ever names the
 * other's scope.
 */
describe("the scopes do not meet", () => {
  it("spends a run against the manual-run row only", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    await consumeManualRunQuota(USER, NOW);

    for (const [argument] of updateMany.mock.calls) {
      expect(argument.where.scope).toBe("manual-run");
    }
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_scope: { userId: USER, scope: "manual-run" } },
    });
    expect(create.mock.calls[0][0].data.scope).toBe("manual-run");
  });

  it("spends a draft against the worker-draft row only", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    await consumeAiDraftQuota(USER, NOW);

    for (const [argument] of updateMany.mock.calls) {
      expect(argument.where.scope).toBe("worker-draft");
    }
    expect(create.mock.calls[0][0].data.scope).toBe("worker-draft");
  });

  it("asks each about its own limit", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);
    await consumeManualRunQuota(USER, NOW);

    expect(updateCall(1).where.count).toEqual({ lt: AI_DRAFT_LIMIT });
    expect(updateCall(2).where.count).toEqual({ lt: MANUAL_RUN_LIMIT });
    expect(AI_DRAFT_LIMIT).not.toBe(MANUAL_RUN_LIMIT);
  });
});

/**
 * The Creator allowance, which is the same machinery under a third name.
 *
 * These check the two things that are actually its own: that it counts against
 * a row nobody else touches, and that five is the number. The window logic
 * underneath is `consumeFixedWindowQuota`, already fixed above for the other
 * two — re-testing every branch of it here would be testing the same code a
 * third time and calling it coverage.
 */
describe("consumeCreatorAnalysisQuota — a live window", () => {
  it("allows the fifth reading of the hour", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await consumeCreatorAnalysisQuota(USER, NOW)).toBe(true);
    expect(updateCall(1).where.count).toEqual({ lt: 5 });
  });

  /**
   * **The limit is a condition inside the write.** Two requests arriving
   * together are separated by the database rather than by whichever read the
   * count first — the same property the other two allowances rely on, and the
   * reason nothing here reads a number and then decides.
   */
  it("lets the database do the adding, and the comparing", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeCreatorAnalysisQuota(USER, NOW);

    const { where, data } = updateCall(1);

    expect(data).toEqual({ count: { increment: 1 } });
    expect(where.count).toEqual({ lt: CREATOR_ANALYSIS_LIMIT });
    expect(where.scope).toBe("creator-analysis");
  });

  it("refuses the sixth when nothing else can take it", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: "bucket-1" });

    expect(await consumeCreatorAnalysisQuota(USER, NOW)).toBe(false);
  });
});

describe("consumeCreatorAnalysisQuota — the window boundary", () => {
  /**
   * **Exactly an hour old is still the same window.** The floor is `>=`, so it
   * is the first request *past* the hour that opens a new one — the same rule
   * the other two allowances follow, restated here because it is the kind of
   * off-by-one that only shows up on a boundary nobody tested.
   */
  it("keeps a window that is exactly an hour old", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeCreatorAnalysisQuota(USER, NOW);

    const exactlyAnHourAgo = new Date(NOW.getTime() - CREATOR_ANALYSIS_WINDOW_MS);
    expect(matchesLiveWindow(updateCall(1).where, exactlyAnHourAgo)).toBe(true);
  });

  it("starts a new window on the first request past the hour", async () => {
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    expect(await consumeCreatorAnalysisQuota(USER, NOW)).toBe(true);

    const justPastAnHourAgo = new Date(
      NOW.getTime() - CREATOR_ANALYSIS_WINDOW_MS - 1,
    );
    expect(matchesLiveWindow(updateCall(1).where, justPastAnHourAgo)).toBe(false);
    expect(matchesExpiredWindow(updateCall(2).where, justPastAnHourAgo)).toBe(true);
    expect(updateCall(2).data).toEqual({ count: 1, windowStartedAt: NOW });
  });
});

describe("consumeCreatorAnalysisQuota — an account with no row yet", () => {
  it("opens the account's first window at one", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    expect(await consumeCreatorAnalysisQuota(USER, NOW)).toBe(true);
    expect(create.mock.calls[0][0].data).toEqual({
      userId: USER,
      scope: "creator-analysis",
      windowStartedAt: NOW,
      count: 1,
    });
  });

  /**
   * Two first requests racing: one creates the row and the other loses to the
   * unique constraint, then tries the live window once more. Exactly as the
   * other allowances behave, because it is the same function.
   */
  it("tries once more when somebody else created the row first", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await consumeCreatorAnalysisQuota(USER, NOW)).toBe(true);
  });
});

describe("consumeCreatorAnalysisQuota — a database that will not answer", () => {
  /**
   * **A failure is not a refusal.** Throwing is what lets the caller fail
   * closed on purpose; returning `false` here would make "the allowance is
   * spent" and "we could not find out" the same answer, and only one of them is
   * something to tell a reader about.
   */
  it("throws rather than reporting a spent allowance", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    await expect(consumeCreatorAnalysisQuota(USER, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });

  it("lets a failed create out too", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(new Error("connection terminated"));

    await expect(consumeCreatorAnalysisQuota(USER, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });
});

describe("the Creator allowance stands alone", () => {
  it("touches only the creator-analysis row", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "bucket-1" });

    await consumeCreatorAnalysisQuota(USER, NOW);

    for (const [argument] of updateMany.mock.calls) {
      expect(argument.where.scope).toBe("creator-analysis");
    }
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_scope: { userId: USER, scope: "creator-analysis" } },
    });
    expect(create.mock.calls[0][0].data.scope).toBe("creator-analysis");
  });

  /**
   * Spending one of each in turn: three writes against three scopes with three
   * limits. Nothing an account reads a piece of writing with comes out of what
   * it runs workers with.
   */
  it("asks about its own limit, next to the other two", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await consumeAiDraftQuota(USER, NOW);
    await consumeManualRunQuota(USER, NOW);
    await consumeCreatorAnalysisQuota(USER, NOW);

    expect(updateCall(1).where).toMatchObject({
      scope: AI_DRAFT_SCOPE,
      count: { lt: AI_DRAFT_LIMIT },
    });
    expect(updateCall(2).where).toMatchObject({
      scope: MANUAL_RUN_SCOPE,
      count: { lt: MANUAL_RUN_LIMIT },
    });
    expect(updateCall(3).where).toMatchObject({
      scope: CREATOR_ANALYSIS_SCOPE,
      count: { lt: CREATOR_ANALYSIS_LIMIT },
    });
  });
});
