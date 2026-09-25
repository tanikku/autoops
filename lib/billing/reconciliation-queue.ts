import "server-only";

import { isUniqueViolation } from "@/lib/billing/subscription-writes";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * What is waiting to be reconciled, and who is allowed to do it.
 *
 * **Two things live here that look like one.** A provider's notification is a
 * durable fact on its own — it arrived, and it must be recorded whether or not
 * anything can be made of it. Reconciling is separate work, done for a whole
 * provider subscription rather than for any one notification, and only by one
 * runner at a time. Keeping them apart is what lets several notifications be
 * answered by a single look at provider state without any of them claiming to
 * have caused what that look found.
 *
 * **The lease is the ordering.** Provider state is read *while the lease is
 * held*, so a later run's reading cannot be older than an earlier run's — which
 * is the property no timestamp could give us, because at least one provider
 * records event times in whole seconds and does not guarantee delivery order.
 * A lease that only covered the writing would leave the readings unordered and
 * let a stale one be applied over a fresh one.
 *
 * **A row with an expiry, not a database lock.** The read in the middle is a
 * network call, and no transaction may be open across one.
 */

/**
 * How long a runner may hold a subscription before another may take over.
 *
 * **Sized for one provider call and a short transaction**, not for the work a
 * worker does: this is deliberately not `EXECUTION_LEASE_MS`, which covers a
 * model call and is measured in minutes. Too long and a crashed runner strands
 * its subscription for that whole time; too short and a slow provider gets
 * fenced out mid-flight and its work is simply redone.
 */
export const RECONCILIATION_LEASE_MS = 60 * 1000;

/** A notification from a provider, as the queue needs it. */
export type ProviderEventReceiptInput = {
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerEventType: string;
  readonly providerSubscriptionId: string;
  readonly providerCustomerId?: string | null;
  readonly providerOccurredAt?: Date | null;
  readonly providerApiVersion?: string | null;
};

/** What became of recording one. */
export type ReceiptRecord =
  | { readonly outcome: "recorded"; readonly receivedAt: Date }
  | { readonly outcome: "duplicate" };

/** Carries a duplicate out of the transaction it was found in. */
class DuplicateDelivery extends Error {
  constructor() {
    super("this delivery was already recorded");
    this.name = "DuplicateDelivery";
  }
}

/**
 * Records that a provider said something, and marks its subscription as owing
 * a look.
 *
 * **No account is required.** Which account a notification belongs to may only
 * be knowable after reading provider state, and a notification whose account
 * cannot be worked out is exactly the one somebody will need to find.
 *
 * **A duplicate is refused by the database, not by memory.** The unique index
 * makes a redelivery a constraint failure, so the same notification cannot
 * create a second row or a second piece of pending work — and the failure is
 * carried out of the transaction rather than swallowed inside it, because
 * PostgreSQL will not accept another statement in a transaction a constraint
 * has already aborted.
 */
export async function recordProviderEventReceipt(
  input: ProviderEventReceiptInput,
  client: DbClient = prisma,
  now: Date = new Date(),
): Promise<ReceiptRecord> {
  const run = async (tx: DbClient): Promise<ReceiptRecord> => {
    let receivedAt: Date;

    try {
      const created = await tx.providerEventReceipt.create({
        data: {
          provider: input.provider,
          providerEventId: input.providerEventId,
          providerEventType: input.providerEventType,
          providerSubscriptionId: input.providerSubscriptionId,
          providerCustomerId: input.providerCustomerId ?? null,
          providerOccurredAt: input.providerOccurredAt ?? null,
          providerApiVersion: input.providerApiVersion ?? null,
          receivedAt: now,
        },
        select: { receivedAt: true },
      });

      receivedAt = created.receivedAt;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateDelivery();
      }

      throw error;
    }

    await ensurePendingWork(
      tx,
      input.provider,
      input.providerSubscriptionId,
      receivedAt,
    );

    return { outcome: "recorded", receivedAt };
  };

  try {
    return "$transaction" in client && typeof client.$transaction === "function"
      ? await (client as typeof prisma).$transaction(run)
      : await run(client);
  } catch (error) {
    if (error instanceof DuplicateDelivery) {
      return { outcome: "duplicate" };
    }

    throw error;
  }
}

/**
 * Makes sure the subscription has a queue row, and that it owes a look from at
 * least as early as this notification.
 *
 * **`pendingSince` is the oldest unanswered notification, expressed as a
 * conditional update rather than read-then-write.** Lowering it only when the
 * new arrival is earlier is the same `LEAST` the invariant asks for, and asking
 * the database to decide means two arrivals racing cannot each write over the
 * other's answer.
 */
async function ensurePendingWork(
  tx: DbClient,
  provider: string,
  providerSubscriptionId: string,
  receivedAt: Date,
): Promise<void> {
  const { count } = await tx.billingReconciliation.updateMany({
    where: {
      provider,
      providerSubscriptionId,
      OR: [{ pendingSince: null }, { pendingSince: { gt: receivedAt } }],
    },
    data: { pendingSince: receivedAt },
  });

  if (count === 1) {
    return;
  }

  // Either the row already owes a look from earlier — in which case there is
  // nothing to lower — or there is no row yet.
  const existing = await tx.billingReconciliation.findUnique({
    where: {
      provider_providerSubscriptionId: { provider, providerSubscriptionId },
    },
    select: { id: true },
  });

  if (existing !== null) {
    return;
  }

  await tx.billingReconciliation.create({
    data: { provider, providerSubscriptionId, pendingSince: receivedAt },
  });
}

/** The right to read provider state for one subscription and act on it. */
export type ReconciliationLease = {
  readonly token: string;
  readonly expiresAt: Date;
  readonly userId: string | null;
  readonly terminationMarker: string | null;
};

/**
 * Takes the right to reconcile one subscription, or reports that it is not
 * available.
 *
 * **A single conditional `UPDATE`, following `acquireExecutionLease`.** Two
 * callers arriving together produce one `1` and one `0`, so exactly one of them
 * goes on to read provider state — which is the whole point: unserialised
 * reads are what let an older view be applied over a newer one.
 *
 * **Claiming stamps the receipts in the same transaction**, and that stamp is
 * the observation boundary: it names the notifications this run is answering
 * for. Anything arriving afterwards has not been looked at and belongs to the
 * next run. Drawing that line with a clock could not work, because when a row
 * is written and when it becomes visible are not the same instant.
 *
 * **Receipts stamped by a dead run are re-stamped.** A runner that crashed
 * after claiming would otherwise strand its notifications behind a token
 * nobody will ever resolve.
 *
 * `now` is the application's clock, as it is for the execution lease; passing
 * it is what makes the expiry boundary testable without moving time.
 *
 * @returns the lease when it was granted, `null` when there is nothing owing or
 *   somebody else holds it.
 */
export async function claimReconciliation(
  provider: string,
  providerSubscriptionId: string,
  token: string,
  client: DbClient = prisma,
  now: Date = new Date(),
): Promise<ReconciliationLease | null> {
  const expiresAt = new Date(now.getTime() + RECONCILIATION_LEASE_MS);

  const run = async (tx: DbClient): Promise<ReconciliationLease | null> => {
    const { count } = await tx.billingReconciliation.updateMany({
      where: {
        provider,
        providerSubscriptionId,
        pendingSince: { not: null },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: { leaseToken: token, leaseUntil: expiresAt, attempts: { increment: 1 } },
    });

    if (count !== 1) {
      return null;
    }

    await tx.providerEventReceipt.updateMany({
      where: { provider, providerSubscriptionId, resolvedAt: null },
      data: { reconciliationRunId: token },
    });

    const row = await tx.billingReconciliation.findUniqueOrThrow({
      where: {
        provider_providerSubscriptionId: { provider, providerSubscriptionId },
      },
      select: { userId: true, unpaidFirstSeenRunId: true },
    });

    return {
      token,
      expiresAt,
      userId: row.userId,
      terminationMarker: row.unpaidFirstSeenRunId,
    };
  };

  return "$transaction" in client && typeof client.$transaction === "function"
    ? await (client as typeof prisma).$transaction(run)
    : await run(client);
}

/**
 * Gives back a lease without having reconciled anything.
 *
 * **The token in the condition is the whole point.** A run that overran its
 * lease has already lost it, and releasing by subscription alone would take the
 * lease out from under whoever took over.
 *
 * The pending work is deliberately left as it was: nothing was answered, so
 * the subscription still owes a look.
 */
export async function releaseReconciliation(
  provider: string,
  providerSubscriptionId: string,
  token: string,
  failureReason: string | null,
  client: DbClient = prisma,
): Promise<boolean> {
  const { count } = await client.billingReconciliation.updateMany({
    where: { provider, providerSubscriptionId, leaseToken: token },
    data: {
      leaseToken: null,
      leaseUntil: null,
      ...(failureReason === null ? {} : { lastFailureReason: failureReason }),
    },
  });

  return count === 1;
}

/**
 * Sets `pendingSince` to the oldest notification still unanswered, or clears it.
 *
 * **Read inside the caller's transaction, after its receipts are resolved.**
 * The caller holds the queue row, so an arrival racing with this waits for the
 * commit and then lowers `pendingSince` itself — which is why clearing it here
 * cannot strand a notification that arrived while the run was working.
 */
export async function recomputePendingSince(
  tx: DbClient,
  provider: string,
  providerSubscriptionId: string,
): Promise<Date | null> {
  const oldest = await tx.providerEventReceipt.findFirst({
    where: { provider, providerSubscriptionId, resolvedAt: null },
    orderBy: { receivedAt: "asc" },
    select: { receivedAt: true },
  });

  const pendingSince = oldest?.receivedAt ?? null;

  await tx.billingReconciliation.updateMany({
    where: { provider, providerSubscriptionId },
    data: { pendingSince },
  });

  return pendingSince;
}
