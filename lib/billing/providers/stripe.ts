import "server-only";

import type Stripe from "stripe";
import type {
  ObservationOutcome,
  ProviderObservation,
  ProviderReader,
} from "@/lib/billing/orchestrate";
import type { PlanId } from "@/lib/plans";

/**
 * Stripe, translated into the only things Koqentra's billing needs.
 *
 * **The whole of what is Stripe-specific lives here.** Everything downstream —
 * the lease, the reconciliation, the domain transitions — reads a snapshot that
 * names no provider, and the direction is one-way: this file imports the
 * provider-neutral types, and nothing provider-neutral imports this. A second
 * provider is a second file beside this one and no change at all to the rest.
 *
 * **It reads current state; it does not follow events.** What Stripe says now
 * is what is acted on, because Stripe stamps event times in whole seconds, does
 * not guarantee delivery order, and says plainly that those timestamps must not
 * be used to order anything. No event id, event type or `created` appears here.
 *
 * **Nothing here is configured from the environment.** The client, the price
 * map and the clock are handed in, so importing this file cannot make a
 * deployment require a Stripe key it does not have. Wiring that up belongs to
 * whichever phase first gives it a caller.
 */

/** The one place this provider is named. */
export const STRIPE_PROVIDER = "stripe";

/** Where a Koqentra account id is kept on a Stripe subscription. */
export const KOQENTRA_USER_ID_KEY = "koqentra_user_id";

/**
 * Which Stripe price is which Koqentra plan.
 *
 * **Exact ids, and nothing else.** Not the product's name, not the amount, not
 * metadata: a price is a plan because somebody said so in configuration, and
 * every other route to the answer is a guess that would eventually hand out an
 * allowance nobody bought.
 */
export type StripePriceCatalogue = {
  readonly [plan in PlanId & ("lite" | "standard" | "pro")]: string;
};

export type StripeAdapterConfig = {
  readonly prices: StripePriceCatalogue;
  /**
   * Which Stripe world this configuration belongs to, when it is worth
   * enforcing. Left out, nothing is checked; set, a subscription from the other
   * world is refused rather than reconciled with prices that are not its own.
   */
  readonly expectedLivemode?: boolean;
};

/** What is wrong with a price catalogue, or null when nothing is. */
export function findCatalogueDefect(
  prices: StripePriceCatalogue,
): string | null {
  const entries = Object.entries(prices);

  for (const [plan, id] of entries) {
    if (typeof id !== "string" || id.trim() === "") {
      return `no price configured for ${plan}`;
    }
  }

  const ids = entries.map(([, id]) => id);

  if (new Set(ids).size !== ids.length) {
    // One price meaning two plans would make the mapping ambiguous in the one
    // direction that decides what somebody may do.
    return "the same price is configured for more than one plan";
  }

  return null;
}

/** Refused for good: asking again would produce the same answer. */
function refused(reason: ObservationOutcome & { kind: "refused" }) {
  return reason;
}

const refuse = (
  reason: "unknown-user" | "unknown-plan" | "malformed" | "unsupported-state",
): ObservationOutcome => refused({ kind: "refused", reason });

/**
 * A Stripe subscription, as Koqentra sees it.
 *
 * Pure: no network, no clock of its own, no database. Everything it decides can
 * therefore be exercised exhaustively from fixtures.
 */
export function translateStripeSubscription(
  subscription: Stripe.Subscription,
  config: StripeAdapterConfig,
  observedAt: Date,
): ObservationOutcome {
  const catalogueDefect = findCatalogueDefect(config.prices);

  if (catalogueDefect !== null) {
    return refuse("malformed");
  }

  if (
    config.expectedLivemode !== undefined &&
    subscription.livemode !== config.expectedLivemode
  ) {
    // Test prices against live objects, or the other way round, would reconcile
    // an account against a catalogue that is not its own.
    return refuse("malformed");
  }

  const userId = subscription.metadata?.[KOQENTRA_USER_ID_KEY]?.trim();

  if (userId === undefined || userId === "") {
    // **Never derived from an email or a customer name.** The binding is an
    // immutable internal id put there when the subscription was created; there
    // is nothing else here that identifies an account without guessing.
    return refuse("unknown-user");
  }

  const providerCustomerId = customerIdOf(subscription.customer);

  if (providerCustomerId === null) {
    return refuse("malformed");
  }

  const item = singlePaidItem(subscription);

  if (item === null) {
    return refuse("malformed");
  }

  const plan = planForPrice(item.price?.id, config.prices);

  if (plan === null) {
    return refuse("unknown-plan");
  }

  const period = periodOf(item);

  if (period === null) {
    return refuse("malformed");
  }

  const state = entitlementFor(subscription.status);

  if (state === null) {
    return refuse("unsupported-state");
  }

  const observation: ProviderObservation = {
    termination: state.termination,
    snapshot: {
      provider: STRIPE_PROVIDER,
      providerCustomerId,
      providerSubscriptionId: subscription.id,
      userId,
      plan,
      entitlement: state.entitlement,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      periodStart: period.start,
      periodEnd: period.end,
      observedAt,
    },
  };

  return { kind: "observed", observation };
}

/** The customer's id, however the field came back. */
function customerIdOf(
  customer: Stripe.Subscription["customer"],
): string | null {
  if (typeof customer === "string") {
    return customer.trim() === "" ? null : customer;
  }

  // Expanded, and possibly a deleted customer — which still carries the id,
  // and is still the customer this subscription belongs to.
  const id = (customer as { id?: unknown } | null)?.id;

  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * The one item a Koqentra subscription is, or null when it is not one.
 *
 * **Several items are refused rather than narrowed to the first.** A second
 * item is somebody being billed for something this product does not sell, and
 * quietly reconciling against one of them would leave the provider charging for
 * more than Koqentra grants — invisibly, because the extra never appears
 * anywhere downstream.
 */
function singlePaidItem(
  subscription: Stripe.Subscription,
): Stripe.SubscriptionItem | null {
  const items = subscription.items;

  if (items === undefined || items === null || items.has_more === true) {
    return null;
  }

  if (!Array.isArray(items.data) || items.data.length !== 1) {
    return null;
  }

  const item = items.data[0];

  // One subscription, one seat. A quantity above one is a shape this product
  // has no price for and no way to express.
  if (item.quantity !== undefined && item.quantity !== null && item.quantity !== 1) {
    return null;
  }

  return item;
}

function planForPrice(
  priceId: string | undefined,
  prices: StripePriceCatalogue,
): PlanId | null {
  if (priceId === undefined) {
    return null;
  }

  for (const [plan, id] of Object.entries(prices)) {
    if (id === priceId) {
      return plan as PlanId;
    }
  }

  return null;
}

/**
 * The period the item is being billed for.
 *
 * **Read from the item, never from the subscription.** Stripe moved billing
 * periods onto subscription items; the top-level fields are gone from the
 * version this adapter is pinned to, and reading them would have been a silent
 * hole rather than a compile error on an older one.
 */
function periodOf(
  item: Stripe.SubscriptionItem,
): { start: Date; end: Date } | null {
  const start = secondsToDate(item.current_period_start);
  const end = secondsToDate(item.current_period_end);

  if (start === null || end === null || start.getTime() >= end.getTime()) {
    return null;
  }

  return { start, end };
}

/** Stripe counts in whole seconds; Koqentra keeps instants. */
function secondsToDate(seconds: unknown): Date | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }

  const date = new Date(seconds * 1000);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * What a Stripe status means for an entitlement, or null when it means nothing
 * Koqentra can act on.
 *
 * **Every status is decided here, including the ones this product never
 * creates.** The SDK's own type admits strings it has not heard of, so the
 * default has to be a refusal rather than a fall-through — an unrecognised
 * status resolving to "entitled" would hand out a plan, and one resolving to
 * "ended" would take away a plan somebody is paying for.
 */
function entitlementFor(status: Stripe.Subscription.Status): {
  entitlement: "entitled" | "grace" | "ended";
  termination: "none" | "immediate" | "confirm-twice";
} | null {
  switch (status) {
    case "active":
      return { entitlement: "entitled", termination: "none" };

    // Payment is in question and Stripe is still trying. The account keeps
    // working, which is what `grace` is for.
    case "past_due":
      return { entitlement: "grace", termination: "none" };

    /**
     * **Recoverable, so it needs a second opinion.** Stripe documents that an
     * unpaid subscription returns to active when its invoice is paid, and no
     * provider promises that two successive reads come back in order — so one
     * late reading could withdraw a subscription that has in fact been paid.
     * The orchestration keeps the account entitled until a second, separately
     * serialised run agrees; this adapter only says which kind of ending it is.
     */
    case "unpaid":
      return { entitlement: "ended", termination: "confirm-twice" };

    // Documented as final and not renewable, so there is no reading that could
    // later contradict it.
    case "canceled":
      return { entitlement: "ended", termination: "immediate" };

    /**
     * **Everything else is refused rather than mapped.**
     *
     * `incomplete` and `incomplete_expired` describe a first payment that never
     * succeeded: Koqentra activates from a paid invoice, so it never had an
     * entitlement for these to end, and treating `incomplete_expired` as a
     * terminal ending would let a subscription that was never paid for drive a
     * withdrawal path meant for one that was.
     *
     * `trialing` is Stripe's own trial. Koqentra runs its own, on its own
     * terms, and never asks Stripe for one — so a subscription in this state is
     * configured in a way this product did not intend, and granting paid
     * entitlement for it would be granting something nobody was charged for.
     *
     * `paused` is reached only by a Stripe trial ending without a payment
     * method, which follows from the same misconfiguration.
     *
     * An unrecognised future status lands here too, which is the point.
     */
    default:
      return null;
  }
}

/**
 * Reads one subscription's current state from Stripe.
 *
 * **Retrieved by its exact id, never searched for.** The lease that makes a
 * reading safe is held per subscription, so a reading that returned a different
 * subscription — or several — would be outside what the lease serialises.
 *
 * **The clock is read before the call, not after.** What the snapshot claims is
 * that the provider was in this state as of an instant; the instant the request
 * began is one it can support, and one taken after the answer came back would
 * claim freshness the reading does not have.
 */
export function createStripeProviderReader(
  client: Pick<Stripe, "subscriptions">,
  config: StripeAdapterConfig,
  clock: () => Date = () => new Date(),
): ProviderReader {
  return async (provider, providerSubscriptionId) => {
    if (provider !== STRIPE_PROVIDER) {
      return refuse("malformed");
    }

    const observedAt = clock();

    let subscription: Stripe.Subscription;

    try {
      subscription = await client.subscriptions.retrieve(
        providerSubscriptionId,
      );
    } catch (error) {
      return classify(error);
    }

    return translateStripeSubscription(subscription, config, observedAt);
  };
}

/**
 * What a failed read means for the work.
 *
 * **Only the shape is kept.** A provider's error carries invoice amounts,
 * customer names and sometimes an address; none of it belongs in a column
 * somebody reads while debugging, and none of it is needed to decide whether to
 * try again.
 */
function classify(error: unknown): ObservationOutcome {
  const type = (error as { type?: unknown } | null)?.type;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;

  if (type === "StripeInvalidRequestError") {
    /**
     * **A subscription that cannot be found is not a cancellation.** Stripe
     * keeps canceled subscriptions retrievable, so a missing one means the id
     * is wrong — a binding that points at nothing — and retrying forever would
     * never make it right.
     */
    return refuse("malformed");
  }

  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
    // Something about the request itself; asking again unchanged is pointless.
    return refuse("malformed");
  }

  // Rate limits, Stripe's own failures, connection and timeout problems: all
  // worth trying again, and the work stays owing until one succeeds.
  return {
    kind: "unavailable",
    reason: typeof type === "string" ? type : "read-failed",
  };
}
