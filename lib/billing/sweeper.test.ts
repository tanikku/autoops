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
const updateMany = vi.fn();
const runReconciliation = vi.fn();

const clientStub = { billingReconciliation: { findMany, updateMany } };

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));
vi.mock("@/lib/billing/orchestrate", () => ({ runReconciliation }));

const {
  BILLING_PERIODIC_RESYNC_INTERVAL_MS,
  SWEEP_BATCH_LIMIT,
  sweepBillingReconciliations,
} = await import(
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
  updateMany.mockReset().mockResolvedValue({ count: 0 });
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

    expect(summary).toEqual({
      examined: 0,
      outcomes: {},
      sources: {},
      checkoutRecovery: {},
      items: [],
    });
    expect(resolveReader).not.toHaveBeenCalled();
    expect(runReconciliation).not.toHaveBeenCalled();
  });
});

/**
 * Reading what nothing woke.
 *
 * **Three sources, one batch.** Rows a delivery or a failed run left owing come
 * first; an unpaid ending waiting for its second run next; a known subscription
 * nothing has read for six hours last. Each of the latter two is put back in
 * line with a conditional write and then read exactly as a delivery's row is.
 */
describe("filling the rest of the batch", () => {
  const NOW = new Date("2026-10-25T12:00:00.000Z");
  const clock = () => NOW;

  type Row = { provider: string; providerSubscriptionId: string; user?: unknown };

  let owing: Row[];
  let unpaid: Row[];
  let stale: Row[];

  /** An unpaid row whose account is in grace on this very subscription. */
  function confirming(id: string, graceOn: string | null = id): Row {
    return {
      provider: "stripe",
      providerSubscriptionId: id,
      user: graceOn === null ? null : { subscription: { providerSubscriptionId: graceOn } },
    };
  }

  type FindArgs = { where: Record<string, unknown>; take: number };

  const queryFor = (match: (where: Record<string, unknown>) => boolean) =>
    findMany.mock.calls.map((call) => call[0] as FindArgs).find((args) => match(args.where));

  const unpaidQuery = () => queryFor((where) => "unpaidFirstSeenRunId" in where);
  const staleQuery = () => queryFor((where) => "OR" in where);

  beforeEach(() => {
    owing = [];
    unpaid = [];
    stale = [];

    findMany.mockImplementation(async ({ where, take }: FindArgs) => {
      const rows =
        (where.pendingSince as { not?: unknown } | null)?.not === null
          ? owing
          : "unpaidFirstSeenRunId" in where
            ? unpaid
            : stale;

      return rows.slice(0, take);
    });
    updateMany.mockResolvedValue({ count: 1 });
  });

  const run = (options: Record<string, unknown> = {}) => sweep({ clock, ...options });

  const reconciled = () =>
    runReconciliation.mock.calls.map((call) => call[0].providerSubscriptionId);

  describe("a known subscription nothing has read for six hours", () => {
    it("is six hours, named once", () => {
      expect(BILLING_PERIODIC_RESYNC_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    });

    it("is read when nothing is owing", async () => {
      stale = pending({ id: "sub_quiet" });

      const summary = await run();

      expect(reconciled()).toEqual(["sub_quiet"]);
      expect(summary.items[0]).toMatchObject({ source: "periodic" });
      expect(summary.sources).toEqual({ periodic: 1 });
    });

    /**
     * **The six hours are decided by the query.** Read at or before the
     * threshold is due; anything newer is not asked for at all.
     */
    it("asks only for rows owing nothing and last read six hours ago or more", async () => {
      await run();

      expect(staleQuery()?.where).toEqual({
        pendingSince: null,
        OR: [
          { lastRunAt: null },
          { lastRunAt: { lte: new Date(NOW.getTime() - BILLING_PERIODIC_RESYNC_INTERVAL_MS) } },
        ],
      });
    });

    it("reads the longest-unread first, never-read before all", async () => {
      await run();

      expect(findMany.mock.calls.at(-1)?.[0].orderBy).toEqual([
        { lastRunAt: { sort: "asc", nulls: "first" } },
        { id: "asc" },
      ]);
    });

    it("puts it back in line before reading it, only if it still owes nothing", async () => {
      stale = pending({ id: "sub_quiet" });

      await run();

      expect(updateMany).toHaveBeenCalledWith({
        where: { provider: "stripe", providerSubscriptionId: "sub_quiet", pendingSince: null },
        data: { pendingSince: NOW },
      });
      expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        runReconciliation.mock.invocationCallOrder[0],
      );
    });

    /** The same path a delivery's row takes: lease, reader, fencing. */
    it("is read through the same reconciliation as everything else", async () => {
      stale = pending({ id: "sub_quiet" });

      await run();

      expect(runReconciliation.mock.calls[0][0]).toMatchObject({
        provider: "stripe",
        providerSubscriptionId: "sub_quiet",
        read: reader,
        clock,
      });
    });
  });

  describe("what is owing comes first", () => {
    it("takes owing rows before any other", async () => {
      owing = pending({ id: "sub_owing" });
      unpaid = [confirming("sub_unpaid")];
      stale = pending({ id: "sub_quiet" });

      const summary = await run();

      expect(reconciled()).toEqual(["sub_owing", "sub_unpaid", "sub_quiet"]);
      expect(summary.sources).toEqual({
        pending: 1,
        "unpaid-confirmation": 1,
        periodic: 1,
      });
    });

    it("looks for nothing else when owing rows fill the batch", async () => {
      owing = pending(...Array.from({ length: 10 }, (_, i) => ({ id: `sub_${i}` })));
      unpaid = [confirming("sub_unpaid")];
      stale = pending({ id: "sub_quiet" });

      const summary = await run();

      expect(summary.examined).toBe(10);
      expect(summary.sources).toEqual({ pending: 10 });
      expect(unpaidQuery()).toBeUndefined();
      expect(staleQuery()).toBeUndefined();
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("gives the remaining three of ten to the rest when seven are owing", async () => {
      owing = pending(...Array.from({ length: 7 }, (_, i) => ({ id: `sub_${i}` })));
      stale = pending(...Array.from({ length: 5 }, (_, i) => ({ id: `sub_quiet_${i}` })));

      const summary = await run();

      expect(unpaidQuery()?.take).toBe(3);
      expect(staleQuery()?.take).toBe(3);
      expect(summary.examined).toBe(10);
      expect(summary.sources).toEqual({ pending: 7, periodic: 3 });
    });

    it("gives the whole batch to the rest when nothing is owing", async () => {
      stale = pending(...Array.from({ length: 12 }, (_, i) => ({ id: `sub_quiet_${i}` })));

      const summary = await run();

      expect(staleQuery()?.take).toBe(10);
      expect(summary.examined).toBe(10);
    });

    it("lets unpaid confirmations take room before the resync does", async () => {
      owing = pending(...Array.from({ length: 8 }, (_, i) => ({ id: `sub_${i}` })));
      unpaid = [confirming("sub_unpaid_1"), confirming("sub_unpaid_2")];
      stale = pending({ id: "sub_quiet" });

      const summary = await run();

      expect(summary.sources).toEqual({ pending: 8, "unpaid-confirmation": 2 });
      expect(staleQuery()).toBeUndefined();
    });

    /** Asked for only after the earlier ones were put back in line. */
    it("reads no row twice in one sweep", async () => {
      unpaid = [confirming("sub_same")];
      stale = pending({ id: "sub_same" });
      updateMany
        .mockResolvedValueOnce({ count: 1 })
        // Already owing by the time the resync tries: someone else's write won.
        .mockResolvedValue({ count: 0 });

      const summary = await run();

      expect(reconciled()).toEqual(["sub_same"]);
      expect(summary.sources).toEqual({ "unpaid-confirmation": 1 });
    });

    /** An owing row is not "owing nothing", so neither later query can take it. */
    it("never asks the later queries for owing rows", async () => {
      await run();

      expect(unpaidQuery()?.where.pendingSince).toBeNull();
      expect(staleQuery()?.where.pendingSince).toBeNull();
    });
  });

  /**
   * **The second run an unpaid ending needs.** The first sighting keeps the
   * account in grace and records which run saw it, then clears `pendingSince`
   * like any answered row — which used to mean nothing would ever read it again
   * unless another delivery arrived. The next sweep now does.
   */
  describe("an unpaid ending seen once", () => {
    it("is read on the next sweep, not after six hours", async () => {
      unpaid = [confirming("sub_unpaid")];

      const summary = await run();

      expect(reconciled()).toEqual(["sub_unpaid"]);
      expect(summary.items[0]).toMatchObject({ source: "unpaid-confirmation" });
    });

    it("asks only for answered rows with a sighting, while the account is in grace", async () => {
      await run();

      expect(unpaidQuery()?.where).toEqual({
        pendingSince: null,
        unpaidFirstSeenRunId: { not: null },
        user: { is: { subscription: { is: { state: "grace" } } } },
      });
      // No lastRunAt condition: it does not wait for the resync interval.
      expect(unpaidQuery()?.where).not.toHaveProperty("lastRunAt");
      expect(unpaidQuery()?.where).not.toHaveProperty("OR");
    });

    /**
     * **Grace on another subscription is not this sighting's grace.** The
     * relation filter cannot compare columns, so it is finished in code — and a
     * row it removes is neither put back nor read.
     */
    it.each([
      ["grace on another subscription", confirming("sub_old", "sub_new")],
      ["no account", confirming("sub_orphan", null)],
    ])("is left alone with %s", async (_label, row) => {
      unpaid = [row];

      const summary = await run();

      expect(updateMany).not.toHaveBeenCalled();
      expect(runReconciliation).not.toHaveBeenCalled();
      expect(summary.examined).toBe(0);
    });

    /** Owing already, it is simply an owing row: taken once, as `pending`. */
    it("is not taken twice when a delivery has already made it owing", async () => {
      owing = pending({ id: "sub_unpaid" });
      // The later query asks for owing-nothing rows only, so it cannot return
      // the same row; the conditional write is the second guard.
      unpaid = [confirming("sub_unpaid")];
      updateMany.mockResolvedValue({ count: 0 });

      const summary = await run();

      expect(reconciled()).toEqual(["sub_unpaid"]);
      expect(summary.sources).toEqual({ pending: 1 });
    });
  });

  /**
   * **A refused row is an answered row, so the resync reads it.** Nothing about
   * refusal changes; what changes is that a refusal is no longer forever.
   */
  describe("a row that was refused", () => {
    it("is read again once six hours have passed, through the same query", async () => {
      stale = pending({ id: "sub_refused" });
      runReconciliation.mockResolvedValue({
        outcome: "reconciled",
        result: { outcome: "applied" },
        receipts: 0,
      });

      const summary = await run();

      expect(summary.items[0]).toMatchObject({
        providerSubscriptionId: "sub_refused",
        source: "periodic",
        outcome: "applied",
      });
    });
  });

  describe("when two sweeps choose the same row", () => {
    /** The conditional write lets exactly one of them put it back. */
    it("reads it only in the sweep that put it back", async () => {
      stale = pending({ id: "sub_quiet" });
      updateMany.mockResolvedValue({ count: 0 });

      const summary = await run();

      expect(runReconciliation).not.toHaveBeenCalled();
      expect(summary.examined).toBe(0);
    });
  });

  describe("when the read fails after the row was put back", () => {
    /**
     * **Nothing is lost.** Putting it back made it owing, and only a run that
     * answers it clears that — so a read that failed leaves it for the next
     * sweep's first query, and this sweep writes nothing to undo it.
     */
    it("leaves it owing for the next sweep", async () => {
      stale = pending({ id: "sub_quiet" });
      runReconciliation.mockRejectedValue(new Error("stripe down"));
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const summary = await run();

      expect(summary.items[0]).toMatchObject({ outcome: "failed", source: "periodic" });
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany.mock.calls[0][0].data).toEqual({ pendingSince: NOW });
    });

    it("carries on with the rest of the batch", async () => {
      stale = pending({ id: "sub_a" }, { id: "sub_b" });
      runReconciliation
        .mockRejectedValueOnce(new Error("stripe down"))
        .mockResolvedValue({ outcome: "reconciled", result: { outcome: "applied" }, receipts: 0 });
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const summary = await run();

      expect(summary.outcomes).toEqual({ failed: 1, applied: 1 });
    });
  });

  /**
   * **Out of scope, on purpose.** A subscription with no reconciliation row —
   * one whose every delivery was lost — is not something these queries can
   * find, and nothing here goes looking for it at the provider.
   */
  describe("a subscription Koqentra has no row for", () => {
    it("is not found: every query is of known reconciliation rows", async () => {
      await run();

      // The stub has no other table; reaching for one would have thrown.
      expect(findMany).toHaveBeenCalledTimes(3);
      expect(Object.keys(clientStub)).toEqual(["billingReconciliation"]);
      expect(resolveReader).not.toHaveBeenCalled();
    });
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
