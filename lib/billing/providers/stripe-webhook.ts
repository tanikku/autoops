import "server-only";

import Stripe from "stripe";
import type { ProviderEventReceiptInput } from "@/lib/billing/reconciliation-queue";
import { STRIPE_PROVIDER } from "@/lib/billing/providers/stripe";

/**
 * Turning a Stripe delivery into something worth waking reconciliation for.
 *
 * **A notification is a knock at the door, not a instruction.** What Stripe
 * sends says something happened; what it does not say — reliably — is in what
 * order, or what the subscription looks like now. So nothing here decides an
 * entitlement: it works out which subscription might have changed, records
 * that, and stops. Reading the provider's current state is the sweeper's, and
 * that is what the account is actually reconciled against.
 *
 * **The event type is a hint and never a mapping.** `customer.subscription
 * .deleted` does not mean the entitlement ended, and `invoice.paid` does not
 * mean one began: both mean "look again". Deciding from the type would put the
 * ordering problem back, because two types can arrive in either order.
 *
 * **No network, and no API key.** Signature verification is a static function
 * on the SDK, so this whole file works from a webhook secret and the bytes that
 * arrived.
 */

/**
 * The deliveries worth waking a reconciliation for.
 *
 * **Only the subscription's own lifecycle.** Every one of these carries the
 * subscription as `data.object`, so the id can be read without guessing.
 * Invoice and payment events are deliberately absent: they identify a
 * subscription only indirectly, and each of them is accompanied by a
 * subscription event that says the same thing — "this subscription may have
 * moved" — without the indirection.
 */
export const WOKEN_BY = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export type WakingEventType = (typeof WOKEN_BY)[number];

export function isWakingEvent(type: string): type is WakingEventType {
  return (WOKEN_BY as readonly string[]).includes(type);
}

/** What a delivery turned out to be. */
export type StripeDelivery =
  /** Worth recording: this subscription may have moved. */
  | { readonly kind: "wake"; readonly receipt: ProviderEventReceiptInput }
  /** Nothing here concerns Koqentra's billing. Answer and forget. */
  | { readonly kind: "ignored"; readonly eventType: string }
  /** The right kind of event, but it names no subscription to look at. */
  | { readonly kind: "unusable"; readonly eventType: string };

/**
 * What a verified Stripe event asks Koqentra to do about it.
 *
 * **Given an already-verified event.** Verification is the route's, because it
 * needs the bytes exactly as they arrived; by the time anything gets here the
 * delivery has been proven to be Stripe's.
 */
export function readStripeDelivery(event: Stripe.Event): StripeDelivery {
  if (!isWakingEvent(event.type)) {
    return { kind: "ignored", eventType: event.type };
  }

  const object = event.data?.object as { id?: unknown; customer?: unknown };
  const providerSubscriptionId =
    typeof object?.id === "string" && object.id.trim() !== ""
      ? object.id
      : null;

  if (providerSubscriptionId === null) {
    // **Never searched for.** Looking one up by customer would mean choosing
    // between subscriptions, and choosing is exactly what this must not do.
    return { kind: "unusable", eventType: event.type };
  }

  const customer = object?.customer;
  const providerCustomerId =
    typeof customer === "string" && customer.trim() !== ""
      ? customer
      : typeof (customer as { id?: unknown } | null)?.id === "string"
        ? ((customer as { id: string }).id)
        : null;

  return {
    kind: "wake",
    receipt: {
      provider: STRIPE_PROVIDER,
      providerEventId: event.id,
      providerEventType: event.type,
      providerSubscriptionId,
      providerCustomerId,
      /**
       * **Kept for reading, never for ordering.** Stripe records this in whole
       * seconds and says plainly it must not be used to order events or to
       * decide whether one was handled. It is here so a delivery gap can be
       * seen afterwards, and for nothing else.
       */
      providerOccurredAt:
        typeof event.created === "number"
          ? new Date(event.created * 1000)
          : null,
      providerApiVersion: event.api_version ?? null,
    },
  };
}

/** Why a delivery could not be accepted. */
export type VerificationFailure = "not-configured" | "unsigned" | "invalid";

export type VerifiedDelivery =
  | { readonly ok: true; readonly event: Stripe.Event }
  | { readonly ok: false; readonly failure: VerificationFailure };

/**
 * Proves a delivery is Stripe's, from the bytes exactly as they arrived.
 *
 * **The raw body, never a re-serialised one.** The signature covers the exact
 * text Stripe sent; parsing it and stringifying it again changes whitespace and
 * key order and the signature stops matching — so nothing may read the body as
 * JSON until this has succeeded.
 *
 * **Static, so no API key and no network.** Verification is arithmetic over the
 * body and the endpoint's own secret; a client that could call Stripe is not
 * needed and is not built.
 *
 * **The secret is read when a request arrives, not when this module loads.**
 * A deployment without one must still start; it simply cannot accept a
 * delivery, which is the safe half of that trade.
 */
export function verifyStripeDelivery(
  rawBody: string,
  signature: string | null,
  webhookSecret: string | undefined,
): VerifiedDelivery {
  if (webhookSecret === undefined || webhookSecret.trim() === "") {
    return { ok: false, failure: "not-configured" };
  }

  if (signature === null || signature.trim() === "") {
    return { ok: false, failure: "unsigned" };
  }

  try {
    const event = Stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret,
    );

    return { ok: true, event };
  } catch {
    // **Nothing about the failure escapes.** The error quotes the signature
    // header and sometimes the body, and an unverified body is by definition
    // something a stranger may have written.
    return { ok: false, failure: "invalid" };
  }
}
