import "server-only";

import { randomUUID } from "node:crypto";
import type { ProviderReader } from "@/lib/billing/orchestrate";
import { runReconciliation } from "@/lib/billing/orchestrate";
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

/** What became of one subscription's turn. */
export type SweptItem = {
  readonly provider: string;
  readonly providerSubscriptionId: string;
  readonly outcome: string;
};

/** What a whole sweep came to. Counts and categories, never provider objects. */
export type SweepSummary = {
  readonly examined: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly items: readonly SweptItem[];
};

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
};

/**
 * Reconciles the subscriptions that have been waiting longest.
 *
 * **Oldest first, and never by anything the provider said.** The order is how
 * long a subscription has been owed a look, which is Koqentra's own fact;
 * ordering by a provider's event times would be ordering by numbers that
 * provider tells us not to order by.
 */
export async function sweepBillingReconciliations(
  options: SweepOptions,
): Promise<SweepSummary> {
  const client = options.client ?? prisma;
  const limit = options.limit ?? SWEEP_BATCH_LIMIT;
  const newRunId = options.newRunId ?? (() => randomUUID());

  const pending = await client.billingReconciliation.findMany({
    where: { pendingSince: { not: null } },
    // The tie-breaker keeps a sweep deterministic when several subscriptions
    // were woken by the same delivery batch and share an instant.
    orderBy: [{ pendingSince: "asc" }, { id: "asc" }],
    take: limit,
    select: { provider: true, providerSubscriptionId: true },
  });

  const items: SweptItem[] = [];

  for (const row of pending) {
    items.push(
      await sweepOne(row.provider, row.providerSubscriptionId, {
        ...options,
        client,
        newRunId,
      }),
    );
  }

  const outcomes: Record<string, number> = {};

  for (const item of items) {
    outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
  }

  return { examined: items.length, outcomes, items };
}

async function sweepOne(
  provider: string,
  providerSubscriptionId: string,
  options: SweepOptions & { client: DbClient; newRunId: () => string },
): Promise<SweptItem> {
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

    return {
      provider,
      providerSubscriptionId,
      outcome:
        result.outcome === "reconciled" ? result.result.outcome : result.outcome,
    };
  } catch (error) {
    // The cause stays in the log; the summary carries a category. One
    // subscription failing is not a reason to stop reconciling the others.
    console.error(
      `[billing] sweep failed for one subscription — provider=${provider}`,
      error,
    );

    return { provider, providerSubscriptionId, outcome: "failed" };
  }
}
