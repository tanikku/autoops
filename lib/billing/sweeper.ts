import "server-only";

import { randomUUID } from "node:crypto";
import { describeBillingError } from "@/lib/billing/error-category";
import {
  type CheckoutSessionReaderResolver,
  recoverCheckouts,
} from "@/lib/billing/checkout-recovery";
import type { ProviderReader, ReconciliationRunResult } from "@/lib/billing/orchestrate";
import { runReconciliation } from "@/lib/billing/orchestrate";
import { requeueReconciliation } from "@/lib/billing/reconciliation-queue";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Working through the subscriptions that owe a look.
 *
 * **Waking is separate from doing.** A delivery only records that something may
 * have moved; this is what goes and finds out. Keeping them apart is what lets
 * several deliveries about one subscription be answered by a single reading,
 * and what lets a subscription still be reconciled when no delivery ever
 * arrives — a provider that drops one, a handler that died between recording
 * and finishing, a reading that failed and left the work owing.
 *
 * **Bounded, always.** One invocation takes a fixed number of subscriptions and
 * stops. An unbounded sweep would have no predictable end, and this runs behind
 * an HTTP request with a deadline.
 *
 * **One subscription's trouble is its own.** A provider that cannot be reached,
 * a configuration that is missing, a reading that makes no sense: each is
 * recorded against that subscription and the sweep carries on. A batch that
 * aborted on the first problem would let one broken account stop every other
 * account from ever being reconciled.
 */

/**
 * How many subscriptions one sweep will look at.
 *
 * **Small on purpose.** Each one is a provider call and a short transaction,
 * and the whole sweep sits inside a request the platform will cut off. Ten is a
 * number that finishes comfortably; anything left owing is still owing when the
 * next sweep runs, which is the property that makes a small batch safe.
 */
export const SWEEP_BATCH_LIMIT = 10;

/**
 * How long a known subscription may go unread before a sweep reads it anyway.
 *
 * **A delivery is a hint, and hints get lost.** Stripe stops retrying one after
 * days, a deployment can refuse one it should have taken, and a reading that
 * was refused is answered and never retried. Without this, a subscription whose
 * cancellation or failed payment was never heard about would stay as Koqentra
 * last saw it for good. Six hours bounds how long that can last.
 *
 * Measured from `lastRunAt`, which is written only when a run answers the row —
 * reconciled or refused — in the same transaction that clears `pendingSince`.
 * A read that failed leaves the row owing instead, so it is retried on the next
 * sweep and never waits for this.
 */
export const BILLING_PERIODIC_RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Why a subscription was in this sweep. */
export type SweepSource =
  /** A delivery, or a run that failed, left it owing. */
  | "pending"
  /** An unpaid ending was seen once and needs a second, separate run. */
  | "unpaid-confirmation"
  /** Nothing has read it for the resync interval. */
  | "periodic";

/** What became of one subscription's turn. */
export type SweptItem = {
  readonly provider: string;
  readonly providerSubscriptionId: string;
  readonly outcome: string;
  readonly source: SweepSource;
  /**
   * Why, when the outcome alone does not say: the refusal, the mismatch, the
   * defect, or the kind of read that failed. A category from this code or an
   * error's class name — never a provider's message or an identifier.
   */
  readonly reason?: string;
};

/** What a whole sweep came to. Counts and categories, never provider objects. */
export type SweepSummary = {
  readonly examined: number;
  readonly outcomes: Readonly<Record<string, number>>;
  /** How many came from each source, so a log line can tell them apart. */
  readonly sources: Readonly<Record<string, number>>;
  /**
   * What looking at open checkouts came to, by outcome. Separate from
   * `outcomes` and `examined`, which count reconciliations: these are attempts,
   * and the response that reports those two does not change.
   */
  readonly checkoutRecovery: Readonly<Record<string, number>>;
  /** `outcome:reason` counts, for the outcomes that carry one. */
  readonly reasons: Readonly<Record<string, number>>;
  readonly items: readonly SweptItem[];
};

type QueuedRow = { readonly provider: string; readonly providerSubscriptionId: string };

/**
 * Where a provider's current state is read from, once there is work for it.
 *
 * **Asked for, not held.** A sweep with no Stripe work must not build a Stripe
 * client, and a deployment with no Stripe configuration must still be able to
 * sweep — so the reader is resolved per provider, when that provider turns up,
 * and a provider that cannot be configured fails only its own subscriptions.
 */
export type ProviderReaderResolver = (
  provider: string,
) => ProviderReader | { readonly unavailable: string };

export type SweepOptions = {
  readonly resolveReader: ProviderReaderResolver;
  readonly client?: DbClient;
  readonly limit?: number;
  readonly clock?: () => Date;
  readonly newRunId?: () => string;
  /**
   * Where paid checkouts no delivery announced are read from. Without it the
   * sweep reconciles and nothing else; see `lib/billing/checkout-recovery.ts`.
   */
  readonly checkoutSessions?: CheckoutSessionReaderResolver;
  /** In [0, 1). Picks the roaming checkout slot; injected so tests can choose. */
  readonly random?: () => number;
};

/**
 * Reconciles the subscriptions that have been waiting longest.
 *
 * **Oldest first, and never by anything the provider said.** The order is how
 * long a subscription has been owed a look, which is Koqentra's own fact;
 * ordering by a provider's event times would be ordering by numbers that
 * provider tells us not to order by.
 *
 * **What is owing comes first, and the batch is not made bigger.** Rows a
 * delivery or a failed run left owing take the batch first; whatever room is
 * left goes to an unpaid ending waiting for its second run, and only then to a
 * known subscription nothing has read for the resync interval. Each of those is
 * put back in line with `requeueReconciliation` and then read exactly like a
 * delivery's row — the same lease, the same reader, the same fencing.
 */
export async function sweepBillingReconciliations(
  options: SweepOptions,
): Promise<SweepSummary> {
  const client = options.client ?? prisma;
  const limit = options.limit ?? SWEEP_BATCH_LIMIT;
  const newRunId = options.newRunId ?? (() => randomUUID());
  const now = (options.clock ?? (() => new Date()))();

  const pending = await client.billingReconciliation.findMany({
    where: { pendingSince: { not: null } },
    // The tie-breaker keeps a sweep deterministic when several subscriptions
    // were woken by the same delivery batch and share an instant.
    orderBy: [{ pendingSince: "asc" }, { id: "asc" }],
    take: limit,
    select: { provider: true, providerSubscriptionId: true },
  });

  const queue: { row: QueuedRow; source: SweepSource }[] = pending.map((row) => ({
    row,
    source: "pending",
  }));

  for (const row of await requeueUnpaidConfirmations(client, limit - queue.length, now)) {
    queue.push({ row, source: "unpaid-confirmation" });
  }

  for (const row of await requeueStaleSubscriptions(client, limit - queue.length, now)) {
    queue.push({ row, source: "periodic" });
  }

  const items: SweptItem[] = [];

  for (const { row, source } of queue) {
    items.push({
      ...(await sweepOne(row.provider, row.providerSubscriptionId, {
        ...options,
        client,
        newRunId,
      })),
      source,
    });
  }

  const outcomes: Record<string, number> = {};
  const sources: Record<string, number> = {};
  const reasons: Record<string, number> = {};

  for (const item of items) {
    outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
    sources[item.source] = (sources[item.source] ?? 0) + 1;

    if (item.reason !== undefined) {
      const key = `${item.outcome}:${item.reason}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }

  // **Last, and in a budget of its own.** Reconciliation keeps its ten and its
  // order; this reads at most three sessions after it, whatever came before.
  const checkoutRecovery: Record<string, number> = {};

  if (options.checkoutSessions !== undefined) {
    const recovered = await recoverCheckouts({
      client,
      now,
      random: options.random ?? Math.random,
      resolveReader: options.checkoutSessions,
    });

    for (const outcome of recovered) {
      checkoutRecovery[outcome] = (checkoutRecovery[outcome] ?? 0) + 1;
    }

    if (recovered.length > 0) {
      sources["checkout-recovery"] = recovered.length;
    }
  }

  return { examined: items.length, outcomes, sources, checkoutRecovery, reasons, items };
}

/**
 * Unpaid endings seen once, put back in line for the run that confirms them.
 *
 * **Not left to the resync interval.** The first sighting keeps the account in
 * `grace` and records which run saw it; withdrawing needs a second, separate run
 * to agree. That run used to depend on another delivery arriving — which for a
 * subscription left `unpaid` may never happen — so the account stayed in grace
 * indefinitely. Now the next sweep is that run.
 *
 * **Only while the account is still in grace on this subscription.** The marker
 * outlives the confirmation it asked for: a confirmed ending keeps it, so the
 * marker alone would read the same terminated subscription every five minutes
 * for good. Once the second run has moved the account out of `grace`, there is
 * nothing left to confirm and the row waits for the resync interval like any
 * other.
 */
async function requeueUnpaidConfirmations(
  client: DbClient,
  room: number,
  now: Date,
): Promise<QueuedRow[]> {
  if (room <= 0) {
    return [];
  }

  const rows = await client.billingReconciliation.findMany({
    where: {
      pendingSince: null,
      unpaidFirstSeenRunId: { not: null },
      user: { is: { subscription: { is: { state: "grace" } } } },
    },
    orderBy: [{ lastRunAt: "asc" }, { id: "asc" }],
    take: room,
    select: {
      provider: true,
      providerSubscriptionId: true,
      user: { select: { subscription: { select: { providerSubscriptionId: true } } } },
    },
  });

  // The relation filter cannot compare two columns, so "in grace on *this*
  // subscription" is finished here: grace on a different subscription is not
  // what this sighting was about.
  const confirming = rows.filter(
    (row) => row.user?.subscription?.providerSubscriptionId === row.providerSubscriptionId,
  );

  return requeueAll(client, confirming, now);
}

/** Known subscriptions nothing has read for the resync interval, oldest first. */
async function requeueStaleSubscriptions(
  client: DbClient,
  room: number,
  now: Date,
): Promise<QueuedRow[]> {
  if (room <= 0) {
    return [];
  }

  const due = new Date(now.getTime() - BILLING_PERIODIC_RESYNC_INTERVAL_MS);

  const rows = await client.billingReconciliation.findMany({
    where: {
      pendingSince: null,
      OR: [{ lastRunAt: null }, { lastRunAt: { lte: due } }],
    },
    orderBy: [{ lastRunAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: room,
    select: { provider: true, providerSubscriptionId: true },
  });

  return requeueAll(client, rows, now);
}

/** Keeps only the rows this sweep was the one to put back in line. */
async function requeueAll(
  client: DbClient,
  rows: readonly QueuedRow[],
  now: Date,
): Promise<QueuedRow[]> {
  const requeued: QueuedRow[] = [];

  for (const row of rows) {
    if (await requeueReconciliation(row.provider, row.providerSubscriptionId, client, now)) {
      requeued.push({ provider: row.provider, providerSubscriptionId: row.providerSubscriptionId });
    }
  }

  return requeued;
}

/** The detail a run's outcome name drops, when it has one. */
function reasonOf(result: ReconciliationRunResult): string | undefined {
  switch (result.outcome) {
    case "refused":
    case "unavailable":
      return result.reason;
    case "reconciled":
      return "reason" in result.result ? result.result.reason : undefined;
    default:
      return undefined;
  }
}

async function sweepOne(
  provider: string,
  providerSubscriptionId: string,
  options: SweepOptions & { client: DbClient; newRunId: () => string },
): Promise<Omit<SweptItem, "source">> {
  const resolved = options.resolveReader(provider);

  if ("unavailable" in resolved) {
    // **Its own subscriptions only.** An unknown provider, or one whose
    // configuration is missing, must not take the rest of the batch with it —
    // and must never be handed another provider's reader.
    return { provider, providerSubscriptionId, outcome: resolved.unavailable };
  }

  try {
    const result = await runReconciliation({
      provider,
      providerSubscriptionId,
      token: options.newRunId(),
      read: resolved,
      client: options.client,
      clock: options.clock,
    });

    const reason = reasonOf(result);

    return {
      provider,
      providerSubscriptionId,
      outcome:
        result.outcome === "reconciled" ? result.result.outcome : result.outcome,
      ...(reason === undefined ? {} : { reason }),
    };
  } catch (error) {
    // **A category, never the error.** A database error quotes the query and
    // the values in it; the summary and this line carry what kind it was. One
    // subscription failing is not a reason to stop reconciling the others.
    console.error(
      `[billing] sweep failed for one subscription — provider=${provider} ${describeBillingError(error)}`,
    );

    return { provider, providerSubscriptionId, outcome: "failed" };
  }
}
