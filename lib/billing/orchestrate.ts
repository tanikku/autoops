import "server-only";

import {
  reconcileProviderSubscription,
  type ReconciliationResult,
} from "@/lib/billing/reconcile";
import {
  claimReconciliation,
  recomputePendingSince,
  releaseReconciliation,
} from "@/lib/billing/reconciliation-queue";
import type { ProviderSubscriptionSnapshot } from "@/lib/billing/snapshot";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Running one reconciliation from end to end.
 *
 * **The shape of it is the safety.** A lease is taken, provider state is read
 * *while it is held*, and only then is anything written — in one short
 * transaction that first checks the lease is still this run's. Reading inside
 * the lease is what orders two runs against each other; checking the lease
 * again before writing is what stops a run that overran from writing over the
 * one that took over from it.
 *
 * **Two locks, not one, and they guard different things.** The lease is keyed
 * by provider subscription, so two different subscriptions can be read at the
 * same time — which is correct, they are different work. But two subscriptions
 * can belong to the same account, and then their writes race over one
 * `Subscription` row. The account's own row is locked in the write transaction
 * for exactly that case, and the domain core re-reads the account after it.
 *
 * **No provider is reachable from here.** Reading provider state is an injected
 * function; what it returns is already provider-neutral. Translating anybody's
 * API into that is an adapter's job, in a later phase.
 */

/** What a provider currently says, plus how its ending should be treated. */
export type ProviderObservation = {
  readonly snapshot: ProviderSubscriptionSnapshot;
  /**
   * How much confirmation an ending needs before entitlement is withdrawn.
   *
   * - `none` — take the snapshot as it stands.
   * - `immediate` — the provider's ending cannot be undone, so it is applied at
   *   once.
   * - `confirm-twice` — the provider's ending *can* be undone, and no provider
   *   documents that two successive reads come back in order. A single late
   *   read could therefore withdraw a subscription that has in fact been paid,
   *   so two separate runs must agree before entitlement goes. The account
   *   stays entitled in the meantime, which costs one sweep against days
   *   already spent in grace.
   */
  readonly termination: "none" | "immediate" | "confirm-twice";
};

/** Why an observation could never be made, however many times it is tried. */
export type ObservationRefusal =
  | "unknown-user"
  | "unknown-plan"
  | "malformed";

/** What reading provider state produced. */
export type ObservationOutcome =
  | { readonly kind: "observed"; readonly observation: ProviderObservation }
  /** Nothing will change by asking again; the notifications are answered. */
  | { readonly kind: "refused"; readonly reason: ObservationRefusal }
  /** Asking again may work. The notifications stay owing. */
  | { readonly kind: "unavailable"; readonly reason: string };

/** Reads one subscription's current state from whoever bills it. */
export type ProviderReader = (
  provider: string,
  providerSubscriptionId: string,
) => Promise<ObservationOutcome>;

/** What a whole run came to. */
export type ReconciliationRunResult =
  /** Somebody else holds the lease, or nothing is owing. Nothing was read. */
  | { readonly outcome: "not-claimed" }
  /** The provider could not be read. The work is still owing. */
  | { readonly outcome: "unavailable"; readonly reason: string }
  /** The observation can never be used. The notifications were answered. */
  | { readonly outcome: "refused"; readonly reason: ObservationRefusal }
  /** The lease was lost while reading. Nothing was written. */
  | { readonly outcome: "fenced-out" }
  /** The domain was reconciled. */
  | {
      readonly outcome: "reconciled";
      readonly result: ReconciliationResult;
      readonly receipts: number;
    };

/**
 * Reconciles one provider subscription, if this caller may.
 *
 * `token` is the run's identity: it is the lease, the stamp on the receipts it
 * is answering for, and what the resulting `BillingEvent` rows carry. One value
 * for all three is what lets an audit trail be followed backwards.
 */
export async function runReconciliation(input: {
  provider: string;
  providerSubscriptionId: string;
  token: string;
  read: ProviderReader;
  client?: DbClient;
  /**
   * Read afresh at each decision that turns on time.
   *
   * **A single timestamp for the whole run would make the lease's expiry a
   * fiction.** The deadline is set from the moment the lease is taken, so
   * comparing it against that same moment always says the lease is live — and
   * the one decision that has to notice a run overrunning is exactly the one
   * that would then never fire.
   */
  clock?: () => Date;
}): Promise<ReconciliationRunResult> {
  const client = input.client ?? prisma;
  const clock = input.clock ?? (() => new Date());
  const { provider, providerSubscriptionId, token } = input;

  const lease = await claimReconciliation(
    provider,
    providerSubscriptionId,
    token,
    client,
    clock(),
  );

  if (lease === null) {
    return { outcome: "not-claimed" };
  }

  // **Outside every transaction, inside the lease.** The call is to somebody
  // else's service; holding a transaction across it would tie up a connection
  // for as long as they take to answer.
  let observation: ObservationOutcome;

  try {
    observation = await input.read(provider, providerSubscriptionId);
  } catch (error) {
    observation = {
      kind: "unavailable",
      // Only the shape of the failure, never what it carried: a provider's
      // error body can quote an address or an amount.
      reason: error instanceof Error ? error.name : "read-failed",
    };
  }

  if (observation.kind === "unavailable") {
    await releaseReconciliation(
      provider,
      providerSubscriptionId,
      token,
      observation.reason,
      client,
    );

    return { outcome: "unavailable", reason: observation.reason };
  }

  const apply = (tx: DbClient) =>
    observation.kind === "refused"
      ? answerWithoutReconciling(tx, {
          provider,
          providerSubscriptionId,
          token,
          reason: observation.reason,
          clock,
        })
      : reconcileUnderLease(tx, {
          provider,
          providerSubscriptionId,
          token,
          observation: observation.observation,
          clock,
        });

  return "$transaction" in client && typeof client.$transaction === "function"
    ? await (client as typeof prisma).$transaction(apply)
    : await apply(client);
}

/**
 * Confirms the lease is still ours and takes the queue row with it.
 *
 * **The write is what takes the row**, and taking it is as important as the
 * check: a notification arriving for this subscription now waits for this
 * transaction, so clearing `pendingSince` later cannot leave it stranded.
 */
async function holdLease(
  tx: DbClient,
  provider: string,
  providerSubscriptionId: string,
  token: string,
  at: Date,
): Promise<boolean> {
  const { count } = await tx.billingReconciliation.updateMany({
    where: {
      provider,
      providerSubscriptionId,
      leaseToken: token,
      // **Holding the token is not owning the lease.** A run whose lease ran
      // out has lost its authority whether or not anybody has taken over yet;
      // treating the stored token as ownership would mean the expiry only
      // mattered once a competitor turned up, and a slow run could apply a
      // reading from minutes ago. Read with a fresh clock — comparing against
      // the instant the lease was taken would be comparing a deadline with the
      // moment it was set, which is always in the run's favour.
      leaseUntil: { gt: at },
    },
    data: { lastRunAt: at },
  });

  return count === 1;
}

/** Marks this run's notifications answered and gives the lease back. */
async function finish(
  tx: DbClient,
  input: {
    provider: string;
    providerSubscriptionId: string;
    token: string;
    outcome: string;
    userId: string | null;
    at: Date;
    terminationMarker?: string | null;
  },
): Promise<number> {
  const { count } = await tx.providerEventReceipt.updateMany({
    where: { reconciliationRunId: input.token, resolvedAt: null },
    data: {
      resolvedAt: input.at,
      outcome: input.outcome,
      ...(input.userId === null ? {} : { userId: input.userId }),
    },
  });

  await recomputePendingSince(tx, input.provider, input.providerSubscriptionId);

  await tx.billingReconciliation.updateMany({
    where: { provider: input.provider, providerSubscriptionId: input.providerSubscriptionId },
    data: {
      leaseToken: null,
      leaseUntil: null,
      lastFailureReason: null,
      ...(input.userId === null ? {} : { userId: input.userId }),
      ...(input.terminationMarker === undefined
        ? {}
        : { unpaidFirstSeenRunId: input.terminationMarker }),
    },
  });

  return count;
}

/** An observation nothing can be made of: answered, not retried. */
async function answerWithoutReconciling(
  tx: DbClient,
  input: {
    provider: string;
    providerSubscriptionId: string;
    token: string;
    reason: ObservationRefusal;
    clock: () => Date;
  },
): Promise<ReconciliationRunResult> {
  const at = input.clock();

  if (
    !(await holdLease(
      tx,
      input.provider,
      input.providerSubscriptionId,
      input.token,
      at,
    ))
  ) {
    return { outcome: "fenced-out" };
  }

  await finish(tx, { ...input, outcome: input.reason, userId: null, at });

  return { outcome: "refused", reason: input.reason };
}

async function reconcileUnderLease(
  tx: DbClient,
  input: {
    provider: string;
    providerSubscriptionId: string;
    token: string;
    observation: ProviderObservation;
    clock: () => Date;
  },
): Promise<ReconciliationRunResult> {
  const { provider, providerSubscriptionId, token, observation } = input;
  const at = input.clock();

  if (!(await holdLease(tx, provider, providerSubscriptionId, token, at))) {
    // **Somebody took over while we were reading.** Whatever we hold describes
    // a moment they have already moved past, so none of it may be written —
    // not the domain, not the receipts, and not the confirmation marker.
    return { outcome: "fenced-out" };
  }

  const queue = await tx.billingReconciliation.findUniqueOrThrow({
    where: {
      provider_providerSubscriptionId: { provider, providerSubscriptionId },
    },
    select: { unpaidFirstSeenRunId: true },
  });

  const confirmed = confirmTermination(
    observation,
    queue.unpaidFirstSeenRunId,
    token,
  );

  // **The account's own row, before the domain reads anything.** Two provider
  // subscriptions can belong to one account and be reconciled at the same time;
  // this is what makes the second of them see what the first wrote. Updating a
  // column to the value it already has is a real `UPDATE` and holds the row —
  // `data: {}` would be turned into a `SELECT` and take nothing. Both were
  // measured before `lockAccountForWorkerQuota` relied on it.
  await tx.user.update({
    where: { id: confirmed.snapshot.userId },
    data: { id: confirmed.snapshot.userId },
  });

  const result = await reconcileProviderSubscription(
    confirmed.snapshot,
    token,
    tx,
  );

  const receipts = await finish(tx, {
    provider,
    providerSubscriptionId,
    token,
    outcome: receiptOutcomeFor(result, await claimedCount(tx, token)),
    userId: confirmed.snapshot.userId,
    at,
    terminationMarker: confirmed.marker,
  });

  return { outcome: "reconciled", result, receipts };
}

async function claimedCount(tx: DbClient, token: string): Promise<number> {
  return tx.providerEventReceipt.count({
    where: { reconciliationRunId: token, resolvedAt: null },
  });
}

/**
 * Turns an observation into the entitlement the domain should act on.
 *
 * **Only reached once the lease has been confirmed**, which is what makes a
 * first sighting count: a run that was fenced out, or one whose read failed,
 * never gets here and so never records one.
 */
function confirmTermination(
  observation: ProviderObservation,
  marker: string | null,
  token: string,
): { snapshot: ProviderSubscriptionSnapshot; marker: string | null } {
  if (observation.termination === "immediate") {
    return {
      snapshot: { ...observation.snapshot, entitlement: "ended" },
      marker,
    };
  }

  if (observation.termination === "none") {
    // The provider is not reporting an ending, so any sighting on record is
    // about a state it has since left.
    return { snapshot: observation.snapshot, marker: null };
  }

  if (marker === null) {
    // **First sighting: entitlement is kept.** The account stays in grace,
    // which is also the truthful description — payment is in question.
    return {
      snapshot: { ...observation.snapshot, entitlement: "grace" },
      marker: token,
    };
  }

  return {
    snapshot: { ...observation.snapshot, entitlement: "ended" },
    marker,
  };
}

/**
 * What to record against each notification this run answered.
 *
 * **Several notifications answered by one reading own none of it.** Saying
 * `applied` on each would claim that each caused the transitions, and a run can
 * be prompted by three deliveries or by none at all. What actually caused them
 * is the run, and the `BillingEvent` rows carry its id.
 */
function receiptOutcomeFor(
  result: ReconciliationResult,
  claimed: number,
): string {
  if (result.outcome !== "applied") {
    return result.outcome === "provider-domain-mismatch"
      ? `provider-domain-mismatch:${result.reason}`
      : result.outcome;
  }

  return claimed > 1 ? "coalesced" : "applied";
}
