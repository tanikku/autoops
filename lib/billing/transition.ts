import "server-only";

import {
  assertUsableBillingEvent,
  BillingEventError,
  type BillingEventInput,
  type BillingEventRejection,
  comparePaidPlans,
  requirePaidPlan,
  requirePeriod,
} from "@/lib/billing/events";
import {
  activatePaidSubscription,
  changeSubscriptionPlan,
  isUniqueViolation,
  renewPaidSubscription,
  setSubscriptionState,
  type StoredSubscription,
  SUBSCRIPTION_FIELDS,
} from "@/lib/billing/subscription-writes";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * What a provider's event does to an account's entitlement.
 *
 * **The whole of the billing domain, and it has never heard of a provider.**
 * Everything below reads a normalised event and writes `Subscription`,
 * `UsagePeriod` and `UsageCounter`; no branch asks who billed, no field is
 * named after anybody's API, and nothing here opens a network connection. An
 * adapter turns one provider's payload into `BillingEventInput` and calls this;
 * a second provider is a second adapter and no change here at all.
 *
 * **One transaction per event, and the event row is inside it.** The record
 * that an event was applied and the effects of applying it commit together or
 * neither does — so a failure cannot leave a row implying work that did not
 * happen, and a retry cannot find a marker that stops it doing work that never
 * did.
 *
 * **Nothing here enforces anything, and nothing here schedules.** The scheduler
 * does not know this file exists, no quota is consumed, and no worker is
 * paused, deleted or started. What changes is what an account is entitled to;
 * acting on that is a later phase's.
 */

/** What became of one delivery. */
export type BillingTransitionResult =
  /** The event was applied and its row is stored. */
  | { readonly outcome: "applied"; readonly kind: string }
  /**
   * This exact event was applied before.
   *
   * **Answered by the database, not by memory.** `@@unique([provider,
   * providerEventId])` refuses the second row, so a redelivery cannot repeat a
   * side effect even if it arrives on another instance a week later.
   */
  | { readonly outcome: "duplicate" }
  /** The provider has already told us something newer. Nothing was applied. */
  | { readonly outcome: "stale" }
  /**
   * Two different events claim the same instant.
   *
   * **Reported rather than resolved.** With one timestamp and no sequence, the
   * only ways to order them are "whichever arrived first" and "whichever
   * arrived last" — both of which are a guess about somebody's entitlement
   * dressed up as a rule. See the note on `providerUpdatedAt` below.
   */
  | { readonly outcome: "ambiguous-order" }
  /** The event could not be used. Nothing was written. */
  | { readonly outcome: "rejected"; readonly reason: BillingEventRejection };

/** Thrown to roll a transaction back with an answer rather than a failure. */
class TransitionOutcome extends Error {
  readonly result: BillingTransitionResult;

  constructor(result: BillingTransitionResult) {
    super(`Billing transition ended as ${result.outcome}`);
    this.name = "TransitionOutcome";
    this.result = result;
  }
}

/**
 * Applies one provider event, or says why it did not.
 *
 * **The order of the steps is the design.** The event row is written first, so
 * a redelivery is refused by the database before anything is read; the
 * entitlement is read next, so staleness is judged against what is actually
 * stored; and every write happens after both, inside the same transaction.
 *
 * **A refusal rolls back, deliberately.** `BillingEvent` carries no outcome
 * column, so a row can only mean one thing — and the useful meaning is "this
 * event was applied". Leaving rows for events that changed nothing would make
 * the table ambiguous in the one direction that matters: somebody asking why an
 * account is inactive would find events that never took effect. See the phase
 * report; adding an outcome column is a decision for whoever needs one, not a
 * side effect of this.
 */
export async function applyBillingEvent(
  event: BillingEventInput,
  client: DbClient = prisma,
): Promise<BillingTransitionResult> {
  // **Before a transaction is opened.** An adapter's mistake should come back
  // as an answer rather than as a rolled-back transaction.
  try {
    assertUsableBillingEvent(event);
  } catch (error) {
    if (error instanceof BillingEventError) {
      return { outcome: "rejected", reason: error.reason };
    }

    throw error;
  }

  const run = async (tx: DbClient): Promise<BillingTransitionResult> => {
    // 1. The event row, first, so the database answers "seen before" rather
    //    than a comparison in this process.
    try {
      await tx.billingEvent.create({
        data: {
          provider: event.provider,
          providerEventId: event.providerEventId,
          userId: event.userId,
          kind: event.kind,
          occurredAt: event.occurredAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Nothing was written by this attempt, and the row that refused it is
        // the proof the work was already done.
        throw new TransitionOutcome({ outcome: "duplicate" });
      }

      throw error;
    }

    // 2. What the account has now.
    const existing: StoredSubscription | null =
      await tx.subscription.findUnique({
        where: { userId: event.userId },
        select: SUBSCRIPTION_FIELDS,
      });

    // 3. Whether the provider has already told us something newer.
    const ordering = compareWithApplied(event, existing);

    if (ordering !== "newer") {
      throw new TransitionOutcome(
        ordering === "stale"
          ? { outcome: "stale" }
          : { outcome: "ambiguous-order" },
      );
    }

    // 4. The transition itself.
    await applyTransition(tx, event, existing);

    return { outcome: "applied", kind: event.kind };
  };

  try {
    // A caller inside a transaction already has one; anything else opens one,
    // because the event row and its effects have to travel together.
    return "$transaction" in client && typeof client.$transaction === "function"
      ? await (client as typeof prisma).$transaction(run)
      : await run(client);
  } catch (error) {
    if (error instanceof TransitionOutcome) {
      return error.result;
    }

    if (error instanceof BillingEventError) {
      return { outcome: "rejected", reason: error.reason };
    }

    throw error;
  }
}

/**
 * Where this event sits against the last one applied.
 *
 * **`providerUpdatedAt` is the provider's own clock, not ours.** It holds when
 * the provider says the last applied event happened, so a delivery that
 * overtook another on the way here is judged by when things occurred rather
 * than by when they arrived.
 *
 * **An exact tie is reported, not resolved.** Two different events carrying the
 * same instant could be applied in either order and reach different states;
 * choosing by arrival would be a guess, and choosing by `providerEventId` would
 * be inventing a total order out of an identifier that has none. The caller is
 * told, and nothing is written.
 */
function compareWithApplied(
  event: BillingEventInput,
  existing: StoredSubscription | null,
): "newer" | "stale" | "ambiguous" {
  const applied = existing?.providerUpdatedAt ?? null;

  if (applied === null) {
    return "newer";
  }

  const incoming = event.occurredAt.getTime();
  const last = applied.getTime();

  if (incoming < last) {
    return "stale";
  }

  return incoming === last ? "ambiguous" : "newer";
}

/** Sends the event to the branch that knows what it means. */
async function applyTransition(
  tx: DbClient,
  event: BillingEventInput,
  existing: StoredSubscription | null,
): Promise<void> {
  switch (event.kind) {
    case "subscription.activated":
      return activate(tx, event, existing);
    case "subscription.renewed":
      return renew(tx, event, requireSubscription(existing));
    case "subscription.plan_changed":
      return changePlan(tx, event, requireSubscription(existing));
    case "subscription.payment_grace":
      return setState(tx, event, requireSubscription(existing), "grace");
    case "subscription.canceled":
      return setState(
        tx,
        event,
        requireSubscription(existing),
        "canceled_active",
      );
    case "subscription.ended":
      return setState(tx, event, requireSubscription(existing), "inactive");
    case "subscription.reactivated":
      return setState(tx, event, requireSubscription(existing), "active");
  }
}

/**
 * The entitlement an event is about, when the event needs one to exist.
 *
 * Only `activated` creates a subscription; everything else changes one, and an
 * event about an account with none is an adapter resolving the wrong account or
 * a provider replaying history from before Koqentra knew about it.
 */
function requireSubscription(
  existing: StoredSubscription | null,
): StoredSubscription {
  if (existing === null) {
    throw new BillingEventError(
      "no-subscription",
      "this account has no entitlement to change",
    );
  }

  return existing;
}

/**
 * A paid entitlement now exists.
 *
 * **`expiresAt` is cleared, and that line is load-bearing.** A granted beta row
 * carries an expiry, and `resolveState` reads it before anything else — so a
 * beta account that bought a plan and kept its old expiry would have its paid
 * subscription resolve as `expired` on the last day of the year, for a reason
 * nobody looking at the paid plan would think to check.
 *
 * **The trial's own columns are never touched.** What an account did with its
 * trial is a fact about the past; buying something does not change it.
 *
 * **`trialForfeitedAt` is set only if it is empty.** A beta account already
 * carries the moment its offer went away, and overwriting it with today would
 * replace a true statement with a later one. An account that never had a trial
 * gets this instant — which is what closes the hole where somebody could buy a
 * plan, cancel it, and be offered a trial they were never owed.
 */
async function activate(
  tx: DbClient,
  event: BillingEventInput,
  existing: StoredSubscription | null,
): Promise<void> {
  const plan = requirePaidPlan(event.plan);
  const period = requirePeriod(event);

  await activatePaidSubscription(tx, {
    userId: event.userId,
    plan,
    period,
    source: event.provider,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    forfeitTrialAt: event.occurredAt,
    existing,
    stamp: { providerUpdatedAt: event.occurredAt },
  });
}

/**
 * The same subscription continues into a new provider period.
 *
 * The plan is not changed and the trial columns are not touched; what moves is
 * the window the allowance is measured over, and a new window starts empty.
 */
async function renew(
  tx: DbClient,
  event: BillingEventInput,
  existing: StoredSubscription,
): Promise<void> {
  const period = requirePeriod(event);

  await renewPaidSubscription(tx, {
    userId: event.userId,
    plan: event.plan ?? existing.plan,
    period,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    stamp: { providerUpdatedAt: event.occurredAt },
  });
}

/**
 * The plan changed inside the period somebody is already paying for.
 *
 * **Only upwards, in this version.** A lower plan is refused outright rather
 * than half-applied: taking an allowance away inside a period already paid for
 * would stop an account mid-month, and doing it properly needs the owner to say
 * which workers stay on — a conversation, not a webhook. See the phase report.
 *
 * **`planAtStart` is not rewritten.** The period did open on the old plan, and
 * that stays true; what changes is the ceiling, which is what the counters'
 * `limit` records.
 *
 * **The state is preserved rather than forced.** An account in `grace` that
 * upgrades is still an account whose payment is in question, and rewriting it
 * to `active` here would resolve a payment problem by ignoring it.
 */
async function changePlan(
  tx: DbClient,
  event: BillingEventInput,
  existing: StoredSubscription,
): Promise<void> {
  const plan = requirePaidPlan(event.plan);
  const direction = comparePaidPlans(existing.plan, plan);

  if (direction === null) {
    // Coming from a trial or a grant is an activation, not a change of
    // position on a ladder neither of them is on.
    throw new BillingEventError(
      "not-a-paid-plan",
      `${existing.plan} is not a paid plan to change from`,
    );
  }

  if (direction === "downgrade") {
    throw new BillingEventError(
      "downgrade-not-supported-yet",
      `${existing.plan} to ${plan} takes effect next period and needs the owner to choose`,
    );
  }

  await changeSubscriptionPlan(tx, {
    userId: event.userId,
    plan,
    periodStart: direction === "same" ? null : existing.currentPeriodStart,
    stamp: { providerUpdatedAt: event.occurredAt },
  });
}

/** A state change that touches nothing else. */
async function setState(
  tx: DbClient,
  event: BillingEventInput,
  existing: StoredSubscription,
  state: "grace" | "canceled_active" | "inactive" | "active",
): Promise<void> {
  void existing;

  await setSubscriptionState(tx, {
    userId: event.userId,
    state,
    stamp: { providerUpdatedAt: event.occurredAt },
  });
}
