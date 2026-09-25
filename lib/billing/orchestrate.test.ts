import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The orchestration's decisions, against a fake client.
 *
 * **These say what the code decides; they cannot say what two runners do.**
 * Whether exactly one of them gets the lease, and whether a runner that
 * overran can still write, are properties of a conditional `UPDATE` against a
 * real server — a mock answers immediately and has no rows to contend over. So
 * those are settled in `integration/billing-reconciliation.integration.ts`,
 * against PostgreSQL 18, and what is fixed here is everything that would still
 * have to hold: that the provider is read only after a lease is granted and
 * never inside a transaction, that a lost lease writes nothing, and that a
 * sighting is only recorded by a run that got as far as writing.
 */

const claim = vi.fn();
const release = vi.fn();
const reconcile = vi.fn();

const reconciliationUpdateMany = vi.fn();
const reconciliationFindUniqueOrThrow = vi.fn();
const receiptUpdateMany = vi.fn();
const receiptFindFirst = vi.fn();
const receiptCount = vi.fn();
const userUpdate = vi.fn();
const transaction = vi.fn();

const clientStub = {
  billingReconciliation: {
    updateMany: reconciliationUpdateMany,
    findUniqueOrThrow: reconciliationFindUniqueOrThrow,
  },
  providerEventReceipt: {
    updateMany: receiptUpdateMany,
    findFirst: receiptFindFirst,
    count: receiptCount,
  },
  user: { update: userUpdate },
  $transaction: transaction,
};

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));
vi.mock("@/lib/billing/reconciliation-queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimReconciliation: claim,
  releaseReconciliation: release,
}));
vi.mock("@/lib/billing/reconcile", () => ({
  reconcileProviderSubscription: reconcile,
}));

const { runReconciliation } = await import("@/lib/billing/orchestrate");

const PROVIDER = "test-provider";
const SUB = "provider-sub-1";
const USER = "google-sub-1";
const TOKEN = "run-1";
const OBSERVED = new Date("2026-10-15T00:00:00.000Z");

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    provider: PROVIDER,
    providerCustomerId: "cus-1",
    providerSubscriptionId: SUB,
    userId: USER,
    plan: "standard",
    entitlement: "entitled",
    cancelAtPeriodEnd: false,
    periodStart: new Date("2026-10-01T00:00:00.000Z"),
    periodEnd: new Date("2026-11-01T00:00:00.000Z"),
    observedAt: OBSERVED,
    ...overrides,
  };
}

const reading = (
  termination: "none" | "immediate" | "confirm-twice" = "none",
  overrides: Record<string, unknown> = {},
) =>
  vi.fn(async () => ({
    kind: "observed" as const,
    observation: { termination, snapshot: snapshot(overrides) },
  }));

/** The data of the queue update that carried a given field. */
function queueUpdateWith(field: string): Record<string, unknown> | undefined {
  return reconciliationUpdateMany.mock.calls
    .map((call) => call[0].data as Record<string, unknown>)
    .find((data) => field in data);
}

function go(input: Record<string, unknown> = {}) {
  return runReconciliation({
    provider: PROVIDER,
    providerSubscriptionId: SUB,
    token: TOKEN,
    read: reading(),
    ...input,
  } as Parameters<typeof runReconciliation>[0]);
}

beforeEach(() => {
  claim
    .mockReset()
    .mockResolvedValue({ token: TOKEN, expiresAt: OBSERVED, userId: null, terminationMarker: null });
  release.mockReset().mockResolvedValue(true);
  reconcile
    .mockReset()
    .mockResolvedValue({ outcome: "applied", kinds: ["subscription.activated"] });

  // The lease is still ours unless a test says otherwise.
  reconciliationUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  reconciliationFindUniqueOrThrow
    .mockReset()
    .mockResolvedValue({ unpaidFirstSeenRunId: null });
  receiptUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  receiptFindFirst.mockReset().mockResolvedValue(null);
  receiptCount.mockReset().mockResolvedValue(1);
  userUpdate.mockReset().mockResolvedValue({ id: USER });
  transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(clientStub));
});

describe("when the lease is not available", () => {
  beforeEach(() => claim.mockResolvedValue(null));

  it("says so", async () => {
    expect(await go()).toEqual({ outcome: "not-claimed" });
  });

  /** Unserialised reads are the thing the lease exists to prevent. */
  it("does not read the provider", async () => {
    const read = reading();

    await go({ read });

    expect(read).not.toHaveBeenCalled();
  });

  it("writes nothing", async () => {
    await go();

    expect(transaction).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("reading the provider", () => {
  /**
   * **Inside the lease, outside every transaction.** The call is to somebody
   * else's service; a transaction held across it would tie up a connection for
   * as long as they take.
   */
  it("happens after the lease is granted and before any transaction", async () => {
    const read = reading();

    await go({ read });

    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(
      read.mock.invocationCallOrder[0],
    );
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
  });

  it("leaves the work owing when it cannot be done", async () => {
    const result = await go({
      read: async () => {
        throw new TypeError("network is down");
      },
    });

    expect(result).toEqual({ outcome: "unavailable", reason: "TypeError" });
    expect(release).toHaveBeenCalledWith(
      PROVIDER,
      SUB,
      TOKEN,
      "TypeError",
      clientStub,
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  /**
   * **Only the shape of the failure is kept.** A provider's error body can
   * quote an address or an amount, and none of that belongs in a column
   * somebody reads while debugging.
   */
  it("records what kind of failure it was, never what it said", async () => {
    await go({
      read: async () => {
        throw new Error("card 4242 for alice@example.com was declined");
      },
    });

    const reason = release.mock.calls[0][3] as string;

    expect(reason).toBe("Error");
    expect(reason).not.toContain("4242");
    expect(reason).not.toContain("@");
  });

  it("answers a reading nothing can be made of without retrying it", async () => {
    const result = await go({
      read: async () => ({ kind: "refused" as const, reason: "unknown-user" as const }),
    });

    expect(result).toEqual({ outcome: "refused", reason: "unknown-user" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(receiptUpdateMany.mock.calls[0][0].data.outcome).toBe("unknown-user");
  });
});

describe("when the lease was lost while reading", () => {
  beforeEach(() => reconciliationUpdateMany.mockResolvedValue({ count: 0 }));

  it("says it was fenced out", async () => {
    expect(await go()).toEqual({ outcome: "fenced-out" });
  });

  /**
   * **What it holds describes a moment the new owner has moved past.** None of
   * it may be written — not the domain, not the answering, not the sighting.
   */
  it("writes nothing at all", async () => {
    await go({ read: reading("confirm-twice") });

    expect(reconcile).not.toHaveBeenCalled();
    expect(receiptUpdateMany).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("the write transaction", () => {
  /**
   * **The account's row before the domain reads anything.** Two provider
   * subscriptions can belong to one account and be reconciled at once; this is
   * what makes the second see what the first wrote.
   */
  it("locks the account before the domain reads it", async () => {
    await go();

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: USER },
      data: { id: USER },
    });
    expect(userUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0],
    );
  });

  /**
   * **`data: {}` would take no lock.** Prisma issues no `UPDATE` for an empty
   * data object and turns the call into a `SELECT` — the distinction
   * `lockAccountForWorkerQuota` was built on.
   */
  it("locks with a real update rather than an empty one", async () => {
    await go();

    expect(userUpdate.mock.calls[0][0].data).not.toEqual({});
  });

  it("hands the domain the same transaction", async () => {
    await go();

    expect(reconcile).toHaveBeenCalledWith(expect.anything(), TOKEN, clientStub);
  });

  it("gives the lease back when it is done", async () => {
    await go();

    expect(queueUpdateWith("leaseToken")).toMatchObject({
      leaseToken: null,
      leaseUntil: null,
      lastFailureReason: null,
    });
  });

  it("answers only the notifications this run claimed", async () => {
    await go();

    expect(receiptUpdateMany.mock.calls[0][0].where).toMatchObject({
      reconciliationRunId: TOKEN,
      resolvedAt: null,
    });
  });
});

describe("what each answered notification is told", () => {
  it.each([
    [1, "applied"],
    [2, "coalesced"],
    [5, "coalesced"],
  ])("with %s claimed says %s", async (claimed, outcome) => {
    receiptCount.mockResolvedValue(claimed);

    await go();

    expect(receiptUpdateMany.mock.calls[0][0].data.outcome).toBe(outcome);
  });

  it.each([
    [{ outcome: "already-converged" }, "already-converged"],
    [{ outcome: "superseded-subscription" }, "superseded-subscription"],
    [{ outcome: "provider-domain-regression" }, "provider-domain-regression"],
    [
      { outcome: "provider-domain-mismatch", reason: "downgrade" },
      "provider-domain-mismatch:downgrade",
    ],
  ])("passes the domain's own answer through", async (result, outcome) => {
    reconcile.mockResolvedValue(result);

    await go();

    expect(receiptUpdateMany.mock.calls[0][0].data.outcome).toBe(outcome);
  });
});

/**
 * An ending the provider could still take back.
 *
 * **Two runs must agree before entitlement goes.** No provider documents that
 * two successive reads come back in order, so a single late one could withdraw
 * a subscription that has in fact been paid.
 */
describe("confirming an ending", () => {
  it("keeps the account entitled on the first sighting", async () => {
    await go({ read: reading("confirm-twice") });

    expect(reconcile.mock.calls[0][0].entitlement).toBe("grace");
    expect(queueUpdateWith("unpaidFirstSeenRunId")?.unpaidFirstSeenRunId).toBe(
      TOKEN,
    );
  });

  it("withdraws it when a different run has seen it before", async () => {
    reconciliationFindUniqueOrThrow.mockResolvedValue({
      unpaidFirstSeenRunId: "an-earlier-run",
    });

    await go({ read: reading("confirm-twice") });

    expect(reconcile.mock.calls[0][0].entitlement).toBe("ended");
  });

  it("forgets the sighting once the provider stops reporting an ending", async () => {
    reconciliationFindUniqueOrThrow.mockResolvedValue({
      unpaidFirstSeenRunId: "an-earlier-run",
    });

    await go({ read: reading("none") });

    expect(reconcile.mock.calls[0][0].entitlement).toBe("entitled");
    expect(
      queueUpdateWith("unpaidFirstSeenRunId")?.unpaidFirstSeenRunId,
    ).toBeNull();
  });

  /** An ending that cannot be undone needs no second opinion. */
  it("withdraws it at once when the ending is final", async () => {
    await go({ read: reading("immediate") });

    expect(reconcile.mock.calls[0][0].entitlement).toBe("ended");
  });

  it("does not disturb a sighting when the ending is final", async () => {
    reconciliationFindUniqueOrThrow.mockResolvedValue({
      unpaidFirstSeenRunId: "an-earlier-run",
    });

    await go({ read: reading("immediate") });

    expect(
      queueUpdateWith("unpaidFirstSeenRunId")?.unpaidFirstSeenRunId,
    ).toBe("an-earlier-run");
  });

  /** A run that never reached the write cannot have seen anything. */
  it("records no sighting when the read failed", async () => {
    await go({
      read: async () => {
        throw new Error("boom");
      },
    });

    expect(queueUpdateWith("unpaidFirstSeenRunId")).toBeUndefined();
  });
});

describe("provider neutrality", () => {
  it.each(["stripe", "app-store", "play", "some-future-provider"])(
    "behaves identically whoever %s is",
    async (provider) => {
      const result = await go({ provider });

      expect(result).toMatchObject({ outcome: "reconciled" });
    },
  );

  it("uses no provider's vocabulary in its code", async () => {
    const { readFileSync } = await import("node:fs");

    const code = (path: string) =>
      readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

    for (const path of [
      "lib/billing/orchestrate.ts",
      "lib/billing/reconciliation-queue.ts",
    ]) {
      for (const forbidden of [
        "stripe",
        "Stripe",
        "invoice.paid",
        "customer.subscription",
        "checkout.session",
        "Event.created",
        "past_due",
      ]) {
        expect(code(path), `${path} mentions ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });
});
