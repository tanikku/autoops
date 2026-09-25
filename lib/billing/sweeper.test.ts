import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Working through the subscriptions that owe a look.
 *
 * **What is fixed here is the sweep's shape**: which rows it takes, in what
 * order, how many, and — most of it — that one subscription's trouble stays its
 * own. That last property is the reason a batch exists at all: a sweep that
 * stopped at the first unreachable provider would let one broken account
 * prevent every other account from ever being reconciled.
 */

const findMany = vi.fn();
const runReconciliation = vi.fn();

const clientStub = { billingReconciliation: { findMany } };

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));
vi.mock("@/lib/billing/orchestrate", () => ({ runReconciliation }));

const { SWEEP_BATCH_LIMIT, sweepBillingReconciliations } = await import(
  "@/lib/billing/sweeper"
);

/** A reader that answers; what it answers does not matter to the sweep. */
const reader = vi.fn(async () => ({ kind: "observed" }));

type Resolved = typeof reader | { unavailable: string };

const resolveReader = vi.fn((provider: string): Resolved => (provider ? reader : reader));

function pending(...subs: { provider?: string; id: string }[]) {
  return subs.map(({ provider = "stripe", id }) => ({
    provider,
    providerSubscriptionId: id,
  }));
}

function sweep(options: Record<string, unknown> = {}) {
  return sweepBillingReconciliations({
    resolveReader,
    client: clientStub as never,
    newRunId: () => "run-1",
    ...options,
  } as Parameters<typeof sweepBillingReconciliations>[0]);
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  runReconciliation
    .mockReset()
    .mockResolvedValue({ outcome: "reconciled", result: { outcome: "applied" }, receipts: 1 });
  resolveReader.mockReset().mockReturnValue(reader);
  reader.mockClear();
});

describe("which subscriptions a sweep takes", () => {
  it("takes only the ones that owe a look", async () => {
    await sweep();

    expect(findMany.mock.calls[0][0].where).toEqual({
      pendingSince: { not: null },
    });
  });

  /**
   * **Oldest first, and by Koqentra's own clock.** Ordering by anything the
   * provider said would be ordering by numbers that provider tells us not to
   * order by.
   */
  it("takes the ones that have waited longest", async () => {
    await sweep();

    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { pendingSince: "asc" },
      { id: "asc" },
    ]);
  });

  it("takes a bounded number", async () => {
    await sweep();

    expect(findMany.mock.calls[0][0].take).toBe(SWEEP_BATCH_LIMIT);
    expect(SWEEP_BATCH_LIMIT).toBe(10);
  });

  it("takes the number it was given", async () => {
    await sweep({ limit: 3 });

    expect(findMany.mock.calls[0][0].take).toBe(3);
  });

  it("reads no more of each row than it needs", async () => {
    await sweep();

    expect(Object.keys(findMany.mock.calls[0][0].select).sort()).toEqual([
      "provider",
      "providerSubscriptionId",
    ]);
  });
});

describe("reconciling each one", () => {
  it("reconciles every subscription it took", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }, { id: "sub_2" }));

    const summary = await sweep();

    expect(runReconciliation).toHaveBeenCalledTimes(2);
    expect(summary.examined).toBe(2);
  });

  it("hands each one its provider's reader and a fresh run id", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }));

    await sweep();

    expect(runReconciliation.mock.calls[0][0]).toMatchObject({
      provider: "stripe",
      providerSubscriptionId: "sub_1",
      token: "run-1",
      read: reader,
    });
  });

  it("gives every run its own identity", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }, { id: "sub_2" }));
    let n = 0;

    await sweep({ newRunId: () => `run-${(n += 1)}` });

    expect(runReconciliation.mock.calls.map((call) => call[0].token)).toEqual([
      "run-1",
      "run-2",
    ]);
  });

  it("reports what each one came to", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }, { id: "sub_2" }));
    runReconciliation
      .mockResolvedValueOnce({ outcome: "reconciled", result: { outcome: "applied" } })
      .mockResolvedValueOnce({ outcome: "not-claimed" });

    const summary = await sweep();

    expect(summary.outcomes).toEqual({ applied: 1, "not-claimed": 1 });
  });

  /** Somebody else holding the lease is an ordinary answer, not a failure. */
  it("is untroubled by one it could not claim", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }, { id: "sub_2" }));
    runReconciliation
      .mockResolvedValueOnce({ outcome: "not-claimed" })
      .mockResolvedValueOnce({ outcome: "reconciled", result: { outcome: "applied" } });

    const summary = await sweep();

    expect(summary.examined).toBe(2);
    expect(summary.outcomes.applied).toBe(1);
  });
});

/**
 * One subscription's trouble.
 *
 * **Contained, every time.** A provider that cannot be reached, a configuration
 * that is missing, a reading that throws: each is recorded against that
 * subscription and the sweep carries on with the rest.
 */
describe("when one subscription cannot be reconciled", () => {
  it("does not stop the others", async () => {
    findMany.mockResolvedValue(
      pending({ id: "sub_1" }, { id: "sub_2" }, { id: "sub_3" }),
    );
    runReconciliation
      .mockResolvedValueOnce({ outcome: "reconciled", result: { outcome: "applied" } })
      .mockRejectedValueOnce(new Error("provider exploded"))
      .mockResolvedValueOnce({ outcome: "reconciled", result: { outcome: "already-converged" } });

    const summary = await sweep();

    expect(summary.examined).toBe(3);
    expect(summary.outcomes).toEqual({
      applied: 1,
      failed: 1,
      "already-converged": 1,
    });
  });

  it("carries a category rather than the cause", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }));
    runReconciliation.mockRejectedValue(
      new Error("card 4242 for alice@example.invalid"),
    );

    const summary = await sweep();

    const serialised = JSON.stringify(summary);

    expect(summary.outcomes).toEqual({ failed: 1 });
    expect(serialised).not.toContain("4242");
    expect(serialised).not.toContain("@");
  });

  it("reports an unavailable provider without reconciling it", async () => {
    findMany.mockResolvedValue(pending({ id: "sub_1" }));
    resolveReader.mockReturnValue({ unavailable: "no-secret-key" });

    const summary = await sweep();

    expect(summary.outcomes).toEqual({ "no-secret-key": 1 });
    expect(runReconciliation).not.toHaveBeenCalled();
  });

  /** Never another provider's reader: that would read the wrong service. */
  it("isolates a provider it does not know", async () => {
    findMany.mockResolvedValue(
      pending({ provider: "some-future-provider", id: "sub_x" }, { id: "sub_1" }),
    );
    resolveReader.mockImplementation((provider: string): Resolved =>
      provider === "stripe" ? reader : { unavailable: "unsupported-provider" },
    );

    const summary = await sweep();

    expect(summary.outcomes).toEqual({
      "unsupported-provider": 1,
      applied: 1,
    });
    expect(runReconciliation).toHaveBeenCalledTimes(1);
  });
});

describe("when there is nothing to do", () => {
  it("asks for no reader at all", async () => {
    const summary = await sweep();

    expect(summary).toEqual({ examined: 0, outcomes: {}, items: [] });
    expect(resolveReader).not.toHaveBeenCalled();
    expect(runReconciliation).not.toHaveBeenCalled();
  });
});

describe("what the sweeper is not", () => {
  it("names no provider in its own code", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/sweeper.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of ["stripe", "Stripe", "customer.subscription"]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** An unbounded sweep would have no predictable end. */
  it("has no unbounded query and no loop without an end", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/sweeper.ts", "utf8");

    expect(source).toContain("take: limit");
    expect(source).not.toContain("while (true)");
  });
});
