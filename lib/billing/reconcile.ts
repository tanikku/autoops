import "server-only";

import {
  type BillingEventKind,
  comparePaidPlans,
  isPaidPlan,
} from "@/lib/billing/events";
import {
  desiredState,
  findSnapshotDefect,
  type ProviderSubscriptionSnapshot,
  type SnapshotDefect,
  snapshotPeriod,
} from "@/lib/billing/snapshot";
import {
  activatePaidSubscription,
  changeSubscriptionPlan,
  readStoredSubscription,
  renewPaidSubscription,
  setSubscriptionState,
  type StoredSubscription,
} from "@/lib/billing/subscription-writes";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Bringing an account's entitlement into line with what the provider says now.
 *
 * **Why this replaces applying events in order.** The layer before it decided
 * what to do from one notification at a time and judged which notification was
 * newer by the provider's own timestamp. That cannot be made correct: at least
 * one provider stamps events in whole seconds, does not guarantee delivery
 * order, and documents that those timestamps must not be used to order anything
 * — so two different changes could be indistinguishable, and the safe answer
 * was to apply neither. Silently dropping a cancellation is not a safe answer.
 *
 * **So nothing here is ordered.** What is applied is the difference between the
 * provider's current state and Koqentra's, which is the same whichever
 * notification prompted the look, and empty once they agree. A redelivery a
 * week late finds nothing to do rather than undoing something.
 *
 * **What this deliberately does not do.** It never reaches the provider — the
 * snapshot is handed to it, already translated. It holds no lease and takes no
 * lock: making two concurrent reads of provider state safe is a matter of
 * serialising the *reads*, which belongs to whatever calls this, and is why
 * everything here takes a transaction client rather than reaching for one.
 */

/** What a reconciliation did, or why it did nothing. */
export type ReconciliationResult =
  /** The differences named in `kinds` were applied. */
  | { readonly outcome: "applied"; readonly kinds: readonly BillingEventKind[] }
  /** Provider and Koqentra already agreed. Nothing was written but the sync time. */
  | { readonly outcome: "already-converged" }
  /**
   * The snapshot describes a subscription this account has since replaced.
   *
   * A late look at an old subscription must never overwrite the one in force;
   * knowing which is which is what `providerSubscriptionId` is for.
   */
  | { readonly outcome: "superseded-subscription" }
  /** The provider's state is one Koqentra cannot represent. Nothing applied. */
  | {
      readonly outcome: "provider-domain-mismatch";
      readonly reason: "downgrade" | "conflicting-subscription" | "unknown-plan";
    }
  /** The provider reported a period earlier than the one in force. Nothing applied. */
  | { readonly outcome: "provider-domain-regression" }
  /** The snapshot could not be used at all. Nothing read, nothing written. */
  | { readonly outcome: "malformed"; readonly reason: SnapshotDefect };

/**
 * Applies whatever the provider's current state says, and says what it applied.
 *
 * Runs the whole difference in one transaction when handed a client that can
 * open one, and inside the caller's when handed a transaction — so a future
 * lease holder can wrap this in its own.
 */
export async function reconcileProviderSubscription(
  snapshot: ProviderSubscriptionSnapshot,
  reconciliationRunId: string,
  client: DbClient = prisma,
): Promise<ReconciliationResult> {
  // Before a transaction is opened: a malformed snapshot should come back as an
  // answer rather than as a rolled-back transaction.
  const defect = findSnapshotDefect(snapshot, reconciliationRunId);

  if (defect !== null) {
    return { outcome: "malformed", reason: defect };
  }

  const run = (tx: DbClient) => converge(tx, snapshot, reconciliationRunId);

  return "$transaction" in client && typeof client.$transaction === "function"
    ? await (client as typeof prisma).$transaction(run)
    : await run(client);
}

async function converge(
  tx: DbClient,
  snapshot: ProviderSubscriptionSnapshot,
  runId: string,
): Promise<ReconciliationResult> {
  const stored = await readStoredSubscription(tx, snapshot.userId);
  const refusal = refuse(snapshot, stored);

  if (refusal !== null) {
    return refusal;
  }

  const kinds = await applyDifferences(tx, snapshot, stored, runId);

  // **Recorded even when nothing changed.** A run that found the two already in
  // agreement did reconcile provider state successfully, and "when did this
  // account last agree with the provider" is exactly the question this answers.
  await tx.subscription.update({
    where: { userId: snapshot.userId },
    data: { providerSyncedAt: snapshot.observedAt },
  });

  if (kinds.length === 0) {
    return { outcome: "already-converged" };
  }

  return { outcome: "applied", kinds };
}

/**
 * Whether the whole reconciliation must be refused, and why.
 *
 * **Refusals are whole, never partial.** Accepting a snapshot's period while
 * refusing its plan would knowingly leave the provider billing for one thing
 * and Koqentra granting another — a divergence created on purpose, which is
 * worse than standing still and saying so.
 */
function refuse(
  snapshot: ProviderSubscriptionSnapshot,
  stored: StoredSubscription | null,
): ReconciliationResult | null {
  if (stored === null) {
    // Nothing bound yet: only an entitled snapshot can do anything, and a
    // non-entitled one about an account with no entitlement is already true.
    return null;
  }

  const bound = stored.providerSubscriptionId;

  if (bound !== null && bound !== snapshot.providerSubscriptionId) {
    // **A subscription that is not the one in force.** Which of the two is
    // current is not something to guess at: if the entitlement is over, this
    // may be a genuine new purchase taking over; if it is not, two live
    // subscriptions for one account is the provider's anomaly to resolve.
    return stored.state === "inactive"
      ? null
      : snapshot.entitlement === "entitled"
        ? {
            outcome: "provider-domain-mismatch",
            reason: "conflicting-subscription",
          }
        : { outcome: "superseded-subscription" };
  }

  const period = snapshotPeriod(snapshot);

  if (
    period !== null &&
    stored.currentPeriodStart !== null &&
    period.start.getTime() < stored.currentPeriodStart.getTime()
  ) {
    // **Billing periods move forwards.** One that appears to have moved back is
    // a stale read or a provider-side fault, and either way reopening it would
    // hand back an allowance that has been spent.
    return { outcome: "provider-domain-regression" };
  }

  if (
    snapshot.plan !== null &&
    isPaidPlan(stored.plan) &&
    comparePaidPlans(stored.plan, snapshot.plan) === "downgrade"
  ) {
    // Taking an allowance away inside a period already paid for would stop an
    // account mid-month, and doing it properly needs the owner to say which
    // workers stay on — a conversation, not a reconciliation.
    return { outcome: "provider-domain-mismatch", reason: "downgrade" };
  }

  return null;
}

/**
 * The differences, applied in the one order that leaves every record truthful.
 *
 * **Activation, then period, then plan, then state.** Each step can settle what
 * a later one would otherwise have had to do, so each is decided against what
 * the step before it left behind rather than against the original reading —
 * which is why a renewal that restores an account to active writes no separate
 * recovery row, while one that lands on a subscription due to cancel still
 * writes the cancellation.
 */
async function applyDifferences(
  tx: DbClient,
  snapshot: ProviderSubscriptionSnapshot,
  stored: StoredSubscription | null,
  runId: string,
): Promise<BillingEventKind[]> {
  const kinds: BillingEventKind[] = [];
  const period = snapshotPeriod(snapshot);

  // What the account looks like as the sequence proceeds.
  let plan = stored?.plan ?? null;
  let state = stored?.state ?? null;
  let periodStart = stored?.currentPeriodStart ?? null;

  const bound =
    stored !== null &&
    stored.providerSubscriptionId === snapshot.providerSubscriptionId;
  const hasPaidBinding = bound && isPaidPlan(stored.plan);

  if (!hasPaidBinding) {
    // Only an entitled snapshot with a period and a plan can start one; a
    // snapshot that says nothing is owed matches an account with nothing.
    if (snapshot.entitlement !== "entitled" || period === null) {
      return kinds;
    }

    await activatePaidSubscription(tx, {
      userId: snapshot.userId,
      plan: snapshot.plan as string,
      period,
      source: snapshot.provider,
      providerCustomerId: snapshot.providerCustomerId,
      providerSubscriptionId: snapshot.providerSubscriptionId,
      forfeitTrialAt: snapshot.observedAt,
      existing: stored,
      // No provenance stamp: the deprecated ordering column is not written by
      // anything here, and the sync time is set once for the whole run.
    });

    kinds.push("subscription.activated");
    plan = snapshot.plan;
    state = "active";
    periodStart = period.start;
  }

  if (
    period !== null &&
    periodStart !== null &&
    period.start.getTime() > periodStart.getTime()
  ) {
    // **Opened under the plan the provider says applies to it**, so a cycle
    // that advanced and upgraded in one move records the plan the new window
    // actually runs under rather than the one the last window ran under.
    await renewPaidSubscription(tx, {
      userId: snapshot.userId,
      plan: snapshot.plan ?? (plan as string),
      period,
      providerCustomerId: snapshot.providerCustomerId,
      providerSubscriptionId: snapshot.providerSubscriptionId,
    });

    kinds.push("subscription.renewed");
    state = "active";
    periodStart = period.start;
  }

  if (snapshot.plan !== null && plan !== null && snapshot.plan !== plan) {
    // The refusal above has already turned back anything lower, so this is an
    // upgrade. The limits it raises are the current period's — which, after a
    // renewal, is the period the renewal opened.
    await changeSubscriptionPlan(tx, {
      userId: snapshot.userId,
      plan: snapshot.plan,
      periodStart,
    });

    kinds.push("subscription.plan_changed");
    plan = snapshot.plan;
  }

  const wanted = desiredState(snapshot);

  if (state !== null && state !== wanted) {
    await setSubscriptionState(tx, { userId: snapshot.userId, state: wanted });
    kinds.push(stateTransitionKind(wanted));
  }

  for (const kind of kinds) {
    await tx.billingEvent.create({
      data: {
        provider: snapshot.provider,
        userId: snapshot.userId,
        kind,
        // **Both legacy columns stay empty, and that is the truthful shape.**
        // There is no single delivery behind what a look at provider state
        // found — a run can answer several notifications or none — and no
        // provider instant to record, only the instant Koqentra looked.
        providerEventId: null,
        occurredAt: null,
        observedAt: snapshot.observedAt,
        reconciliationRunId: runId,
      },
    });
  }

  return kinds;
}

/**
 * The name for arriving at a state.
 *
 * **Named by where it lands, not by the pair it crossed.** An account moving
 * from grace to a scheduled cancellation changed two things at the provider,
 * but only one state exists to hold the result, and writing an intermediate
 * recovery row would record a moment that never happened.
 */
function stateTransitionKind(
  state: "active" | "grace" | "canceled_active" | "inactive",
): BillingEventKind {
  switch (state) {
    case "grace":
      return "subscription.payment_grace";
    case "canceled_active":
      return "subscription.canceled";
    case "inactive":
      return "subscription.ended";
    case "active":
      return "subscription.reactivated";
  }
}
