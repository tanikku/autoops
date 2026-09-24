import { isPlan, type PlanId } from "@/lib/plans";

/**
 * What a billing provider can tell Koqentra, in Koqentra's own words.
 *
 * **Seven things, and none of them is a provider's vocabulary.** Stripe calls
 * one of these `customer.subscription.updated`, the App Store calls another
 * `DID_RENEW`, and Google Play calls a third something else again. Translating
 * at the edge is an adapter's whole job; letting a provider's own event name
 * reach the domain would mean the second provider has to pretend to be the
 * first, and every branch downstream would quietly learn who bills.
 *
 * **Nothing here talks to a provider.** This file names events and checks that
 * one is usable; applying it is `applyBillingEvent`'s, and reaching a provider
 * is nobody's yet.
 */

/**
 * The events the domain understands.
 *
 * **A closed union rather than a database enum**, for the same reason `plan`
 * and `state` are strings: adding a kind should be a line here and a branch
 * that handles it, not a migration.
 */
export const billingEventKinds = [
  /** A paid entitlement now exists. The first paid event for a subscription. */
  "subscription.activated",
  /** The same subscription continues into a new provider period. */
  "subscription.renewed",
  /** The plan changed within the period somebody is already paying for. */
  "subscription.plan_changed",
  /** A payment is in question and the provider is still trying. */
  "subscription.payment_grace",
  /** Cancellation is scheduled; access continues to the period's end. */
  "subscription.canceled",
  /** It is over. Nothing is deleted and nothing runs. */
  "subscription.ended",
  /** A scheduled cancellation was withdrawn. */
  "subscription.reactivated",
] as const;

export type BillingEventKind = (typeof billingEventKinds)[number];

export function isBillingEventKind(value: unknown): value is BillingEventKind {
  return (
    typeof value === "string" &&
    (billingEventKinds as readonly string[]).includes(value)
  );
}

/**
 * One provider event, normalised.
 *
 * **What is missing is deliberate.** There is no price, no invoice, no
 * customer email, no raw payload and no provider-specific object: none of them
 * is needed to decide what an account may do, and a field that existed would
 * eventually be read by something that should not know about billing at all.
 */
export type BillingEventInput = {
  /** Who said it. Opaque to the domain — see `assertOpaqueProvider`. */
  readonly provider: string;
  /** The provider's own id for this delivery. The idempotency key. */
  readonly providerEventId: string;
  readonly kind: BillingEventKind;
  /** The account, resolved by the adapter from the provider's own identity. */
  readonly userId: string;
  /** Which plan, for the events that name one. Null for the rest. */
  readonly plan: PlanId | null;
  /** The provider's billing cycle, for the events that carry one. */
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  /**
   * When the provider says it happened.
   *
   * **Theirs, not ours.** It is what a late or out-of-order delivery is judged
   * against, and a local clock would judge the order things arrived in.
   */
  readonly occurredAt: Date;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
};

/** Why an event could not be used. Named so a caller can act on it. */
export type BillingEventRejection =
  /** The shape was wrong: a missing field, an unusable date, an unknown kind. */
  | "malformed-event"
  /** `activated` named a plan nobody can buy, or named none at all. */
  | "not-a-paid-plan"
  /** A period that is missing, unusable, or does not move forwards. */
  | "invalid-period"
  /** A lower plan. Deliberately not applied — see `applyBillingEvent`. */
  | "downgrade-not-supported-yet"
  /** An event about an account that has no entitlement to change. */
  | "no-subscription";

/** A refusal the caller can act on, raised before anything is written. */
export class BillingEventError extends Error {
  readonly reason: BillingEventRejection;

  constructor(reason: BillingEventRejection, detail: string) {
    super(`Billing event refused (${reason}): ${detail}`);
    this.name = "BillingEventError";
    this.reason = reason;
  }
}

/**
 * The plans somebody can buy, in the order they sit in.
 *
 * **Stated here rather than inferred.** A price is the one thing the plan
 * catalogue deliberately does not hold — see `lib/plans.ts` — so ordering
 * cannot be read off it, and reading it off the array order in `planIds` would
 * make `trial` and `beta` into positions on a ladder they are not on.
 *
 * **Trial and beta are absent on purpose.** Neither is bought, so neither is
 * above or below anything: moving from either to a paid plan is an activation,
 * not a change of position.
 */
const PAID_PLAN_ORDER: readonly PlanId[] = ["lite", "standard", "pro"];

/** Whether this is a plan somebody can pay for. */
export function isPaidPlan(plan: string): plan is PlanId {
  return (PAID_PLAN_ORDER as readonly string[]).includes(plan);
}

/**
 * Where two paid plans sit relative to each other.
 *
 * Null when either side is not a paid plan, which is the caller's signal that
 * the question does not apply rather than an answer to it.
 */
export function comparePaidPlans(
  from: string,
  to: string,
): "upgrade" | "downgrade" | "same" | null {
  if (!isPaidPlan(from) || !isPaidPlan(to)) {
    return null;
  }

  const before = PAID_PLAN_ORDER.indexOf(from);
  const after = PAID_PLAN_ORDER.indexOf(to);

  if (after === before) {
    return "same";
  }

  return after > before ? "upgrade" : "downgrade";
}

/** Whether a date is one that can be compared and stored. */
function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Checks an event before anything is written.
 *
 * **Every refusal happens here, before a transaction is opened.** An adapter
 * that normalised something wrong should learn it from the answer rather than
 * from a half-applied entitlement, and a check made after the first write
 * would have to decide what to do about that write.
 */
export function assertUsableBillingEvent(event: BillingEventInput): void {
  if (!isBillingEventKind(event.kind)) {
    throw new BillingEventError("malformed-event", `unknown kind ${event.kind}`);
  }

  for (const [name, value] of [
    ["provider", event.provider],
    ["providerEventId", event.providerEventId],
    ["userId", event.userId],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new BillingEventError("malformed-event", `${name} is empty`);
    }
  }

  if (!isUsableDate(event.occurredAt)) {
    throw new BillingEventError("malformed-event", "occurredAt is not a date");
  }

  if (event.plan !== null && !isPlan(event.plan)) {
    throw new BillingEventError("malformed-event", `unknown plan ${event.plan}`);
  }
}

/**
 * The plan an activation or a change names, once it is known to be buyable.
 *
 * **`trial` and `beta` are refused here.** Neither is something a provider can
 * sell, and an activation carrying one would be an adapter mapping a grant onto
 * a purchase — which would hand somebody a paid entitlement nobody bought, and
 * would take a beta account's expiry off a row that still needs it.
 */
export function requirePaidPlan(plan: PlanId | null): PlanId {
  if (plan === null) {
    throw new BillingEventError("not-a-paid-plan", "no plan was supplied");
  }

  if (!isPaidPlan(plan)) {
    throw new BillingEventError(
      "not-a-paid-plan",
      `${plan} is not a plan anybody buys`,
    );
  }

  return plan;
}

/** A provider's billing cycle, once it is known to be usable. */
export function requirePeriod(event: BillingEventInput): {
  start: Date;
  end: Date;
} {
  if (!isUsableDate(event.periodStart) || !isUsableDate(event.periodEnd)) {
    throw new BillingEventError("invalid-period", "the period is not two dates");
  }

  // A period that does not move forwards is not a period. An empty one would
  // open a window nothing could ever be counted in.
  if (event.periodStart.getTime() >= event.periodEnd.getTime()) {
    throw new BillingEventError(
      "invalid-period",
      "the period does not move forwards",
    );
  }

  return { start: event.periodStart, end: event.periodEnd };
}
