import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the queue decides, against a fake client.
 *
 * **The contended cases are not here.** Whether two racing inserts leave one
 * row, and whether two racing claims grant one lease, are properties of a
 * unique index and a conditional `UPDATE` against a real server; a mock has
 * neither. Those are settled against PostgreSQL 18 in
 * `integration/billing-reconciliation.integration.ts`. What is fixed here is
 * the shape that makes them work: that the constraint failure is carried out of
 * the transaction rather than swallowed inside it, that claiming stamps the
 * receipts in the same breath, and that the conditions on each write say what
 * they are meant to.
 */

const receiptCreate = vi.fn();
const receiptUpdateMany = vi.fn();
const receiptFindFirst = vi.fn();
const queueUpdateMany = vi.fn();
const queueFindUnique = vi.fn();
const queueFindUniqueOrThrow = vi.fn();
const queueCreate = vi.fn();
const transaction = vi.fn();

const clientStub = {
  providerEventReceipt: {
    create: receiptCreate,
    updateMany: receiptUpdateMany,
    findFirst: receiptFindFirst,
  },
  billingReconciliation: {
    updateMany: queueUpdateMany,
    findUnique: queueFindUnique,
    findUniqueOrThrow: queueFindUniqueOrThrow,
    create: queueCreate,
  },
  $transaction: transaction,
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));

const {
  claimReconciliation,
  recomputePendingSince,
  RECONCILIATION_LEASE_MS,
  recordProviderEventReceipt,
  releaseReconciliation,
} = await import("@/lib/billing/reconciliation-queue");

const PROVIDER = "test-provider";
const SUB = "provider-sub-1";
const TOKEN = "run-1";
const NOW = new Date("2026-10-15T00:00:00.000Z");

const input = {
  provider: PROVIDER,
  providerEventId: "evt-1",
  providerEventType: "provider.said.something",
  providerSubscriptionId: SUB,
};

function uniqueViolation() {
  return Object.assign(new Error("unique constraint"), { code: "P2002" });
}

beforeEach(() => {
  receiptCreate.mockReset().mockResolvedValue({ receivedAt: NOW });
  receiptUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  receiptFindFirst.mockReset().mockResolvedValue(null);
  queueUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  queueFindUnique.mockReset().mockResolvedValue({ id: "q1" });
  queueFindUniqueOrThrow
    .mockReset()
    .mockResolvedValue({ userId: null, unpaidFirstSeenRunId: null });
  queueCreate.mockReset().mockResolvedValue({ id: "q1" });
  transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(clientStub));
});

describe("recording a notification", () => {
  it("stores only identifiers and never a payload", async () => {
    await recordProviderEventReceipt(input, clientStub as never, NOW);

    const data = receiptCreate.mock.calls[0][0].data;

    expect(Object.keys(data).sort()).toEqual([
      "providerApiVersion",
      "providerCustomerId",
      "providerEventId",
      "providerEventType",
      "providerOccurredAt",
      "providerSubscriptionId",
      "provider",
      "receivedAt",
    ].sort());
  });

  /** The account may only be knowable after provider state has been read. */
  it("does not require an account", async () => {
    const result = await recordProviderEventReceipt(input, clientStub as never, NOW);

    expect(result).toEqual({ outcome: "recorded", receivedAt: NOW });
    expect(receiptCreate.mock.calls[0][0].data).not.toHaveProperty("userId");
  });

  /**
   * **The constraint failure leaves the transaction before it is answered.**
   * PostgreSQL will not accept another statement in a transaction a constraint
   * has aborted, so catching it in place and carrying on would fail on the
   * next line — the invariant the concurrency work established.
   */
  it("answers a redelivery without writing anything else", async () => {
    receiptCreate.mockRejectedValue(uniqueViolation());

    expect(await recordProviderEventReceipt(input, clientStub as never, NOW)).toEqual({
      outcome: "duplicate",
    });
    expect(queueUpdateMany).not.toHaveBeenCalled();
    expect(queueCreate).not.toHaveBeenCalled();
  });

  it("lets a failure that is not a redelivery through", async () => {
    receiptCreate.mockRejectedValue(new Error("disk is full"));

    await expect(
      recordProviderEventReceipt(input, clientStub as never, NOW),
    ).rejects.toThrow("disk is full");
  });

  /**
   * **Lowering it only when the arrival is earlier is `LEAST`, expressed as a
   * condition.** Asking the database to decide means two arrivals racing cannot
   * each write over the other's answer.
   */
  it("moves the oldest-owing mark only backwards", async () => {
    await recordProviderEventReceipt(input, clientStub as never, NOW);

    expect(queueUpdateMany.mock.calls[0][0].where.OR).toEqual([
      { pendingSince: null },
      { pendingSince: { gt: NOW } },
    ]);
  });

  it("creates the queue row when the subscription has none", async () => {
    queueUpdateMany.mockResolvedValue({ count: 0 });
    queueFindUnique.mockResolvedValue(null);

    await recordProviderEventReceipt(input, clientStub as never, NOW);

    expect(queueCreate.mock.calls[0][0].data).toMatchObject({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      pendingSince: NOW,
    });
  });

  it("leaves an earlier mark alone", async () => {
    queueUpdateMany.mockResolvedValue({ count: 0 });
    queueFindUnique.mockResolvedValue({ id: "q1" });

    await recordProviderEventReceipt(input, clientStub as never, NOW);

    expect(queueCreate).not.toHaveBeenCalled();
  });
});

describe("taking the lease", () => {
  it("is refused unless something is owing and nobody holds it", async () => {
    await claimReconciliation(PROVIDER, SUB, TOKEN, clientStub as never, NOW);

    expect(queueUpdateMany.mock.calls[0][0].where).toMatchObject({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      pendingSince: { not: null },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: NOW } }],
    });
  });

  it("writes the token, the expiry and one more attempt together", async () => {
    await claimReconciliation(PROVIDER, SUB, TOKEN, clientStub as never, NOW);

    expect(queueUpdateMany.mock.calls[0][0].data).toEqual({
      leaseToken: TOKEN,
      leaseUntil: new Date(NOW.getTime() + RECONCILIATION_LEASE_MS),
      attempts: { increment: 1 },
    });
  });

  it("answers null when somebody else holds it", async () => {
    queueUpdateMany.mockResolvedValue({ count: 0 });

    expect(
      await claimReconciliation(PROVIDER, SUB, TOKEN, clientStub as never, NOW),
    ).toBeNull();
    expect(receiptUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * **Claiming draws the observation boundary.** It names the notifications
   * this run is answering for; anything arriving afterwards has not been looked
   * at. A clock could not draw that line, because when a row is written and
   * when it becomes visible are not the same instant.
   */
  it("stamps the notifications that are unanswered right now", async () => {
    await claimReconciliation(PROVIDER, SUB, TOKEN, clientStub as never, NOW);

    expect(receiptUpdateMany.mock.calls[0][0]).toEqual({
      where: { provider: PROVIDER, providerSubscriptionId: SUB, resolvedAt: null },
      data: { reconciliationRunId: TOKEN },
    });
  });

  /** A crashed runner would otherwise strand its notifications forever. */
  it("takes over the ones a dead run had stamped", async () => {
    await claimReconciliation(PROVIDER, SUB, TOKEN, clientStub as never, NOW);

    const { where } = receiptUpdateMany.mock.calls[0][0];

    expect(where).not.toHaveProperty("reconciliationRunId");
    expect(where.resolvedAt).toBeNull();
  });

  it("claims and stamps in one transaction", async () => {
    await claimReconciliation(PROVIDER, SUB, TOKEN, clientStub as never, NOW);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe("giving the lease back", () => {
  /** Releasing by subscription alone would take it from whoever took over. */
  it("only releases the lease it was given", async () => {
    await releaseReconciliation(PROVIDER, SUB, TOKEN, "Timeout", clientStub as never);

    expect(queueUpdateMany.mock.calls[0][0].where).toEqual({
      provider: PROVIDER,
      providerSubscriptionId: SUB,
      leaseToken: TOKEN,
    });
  });

  it("leaves the pending work where it was", async () => {
    await releaseReconciliation(PROVIDER, SUB, TOKEN, "Timeout", clientStub as never);

    expect(queueUpdateMany.mock.calls[0][0].data).not.toHaveProperty(
      "pendingSince",
    );
  });

  it("reports whether it still held it", async () => {
    queueUpdateMany.mockResolvedValue({ count: 0 });

    expect(
      await releaseReconciliation(PROVIDER, SUB, TOKEN, null, clientStub as never),
    ).toBe(false);
  });
});

describe("what is still owing afterwards", () => {
  it("points at the oldest notification left unanswered", async () => {
    const later = new Date("2026-10-16T00:00:00.000Z");

    receiptFindFirst.mockResolvedValue({ receivedAt: later });

    expect(await recomputePendingSince(clientStub as never, PROVIDER, SUB)).toEqual(
      later,
    );
    expect(queueUpdateMany.mock.calls[0][0].data).toEqual({ pendingSince: later });
  });

  it("clears the mark when none are left", async () => {
    expect(await recomputePendingSince(clientStub as never, PROVIDER, SUB)).toBeNull();
    expect(queueUpdateMany.mock.calls[0][0].data).toEqual({ pendingSince: null });
  });

  it("looks only at unanswered ones, oldest first", async () => {
    await recomputePendingSince(clientStub as never, PROVIDER, SUB);

    expect(receiptFindFirst.mock.calls[0][0]).toMatchObject({
      where: { provider: PROVIDER, providerSubscriptionId: SUB, resolvedAt: null },
      orderBy: { receivedAt: "asc" },
    });
  });
});
