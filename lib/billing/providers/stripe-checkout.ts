import "server-only";

import Stripe from "stripe";
import { KOQENTRA_USER_ID_KEY } from "@/lib/billing/providers/stripe";
import {
  matchesExpectedLivemode,
  readStripeRuntime,
  StripeLivemodeMismatchError,
} from "@/lib/billing/providers/stripe-runtime";
import type {
  CheckoutProvider,
  CheckoutSessionRequest,
  ProviderSessionState,
  ProviderSubscriptionPresence,
} from "@/lib/billing/checkout";

/**
 * Everything about starting a Stripe checkout that is Stripe's.
 *
 * **The orchestration does not import this, and cannot.** It is handed a
 * `CheckoutProvider` and works against that — so the decisions about who may
 * buy, which slot is held, and what a retry means are testable without a
 * provider, and this file has no opinion about any of them. The same shape
 * `sweepBillingReconciliations` uses for reading a provider, for the same
 * reason.
 *
 * **Built on use, never on import.** A deployment with no Stripe configuration
 * must still start, so the client is constructed when a checkout actually needs
 * one — see `stripe-runtime.ts`, which this asks for the configuration rather
 * than reading the environment itself.
 */

/** Why Stripe cannot be asked to start a checkout. */
export type StripeCheckoutUnavailable =
  | "no-secret-key"
  | "no-price-catalogue"
  | "bad-livemode-flag";

/**
 * How long a session may be paid for.
 *
 * **Twelve hours, and the provider will not take more than a day.** Stripe
 * refuses an expiry twenty-four hours or further out and defaults to exactly
 * that — which leaves no room under the eighteen hours an attempt holds its
 * slot for. Naming twelve keeps the two apart: the session lapses first, the
 * slot outlives it, and the provider's replay window outlives both.
 */
export const STRIPE_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * Which Stripe statuses mean a subscription is still somebody's.
 *
 * **Not "any subscription exists".** An account that cancelled last year has a
 * `canceled` subscription on the provider's side and is perfectly entitled to
 * buy again; refusing it would make cancellation permanent. What stops a second
 * purchase is a subscription that is still live, or one that is partway through
 * being paid for.
 *
 * - `active`, `trialing` — plainly live.
 * - `past_due`, `unpaid` — live but behind. The account's problem is a payment
 *   method, and a second subscription would bill them twice for one lapse.
 * - `incomplete` — a first payment that has not landed yet. Buying again here
 *   is the duplicate this whole mechanism exists to prevent.
 * - `paused` — collection is stopped and the subscription is not gone. Whatever
 *   resumes it would resume alongside a second one.
 *
 * **Deliberately not blocking**: `canceled` and `incomplete_expired` are both
 * final and un-resumable — Stripe documents them as such — so a subscription in
 * either is history rather than an entitlement.
 */
export const BLOCKING_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
] as const;

function isBlockingStatus(status: string): boolean {
  return (BLOCKING_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Turns a Stripe session into the three answers coordination cares about.
 *
 * **Complete and expired are different questions, not different degrees.** One
 * means the money has been taken and reconciliation has not caught up; the
 * other means nobody can pay through it any more. Collapsing them would send
 * somebody who has already paid to a new payment page.
 */
function readSessionStatus(status: string | null): ProviderSessionState["kind"] {
  switch (status) {
    case "open":
      return "payable";
    case "complete":
      return "paid";
    case "expired":
      return "lapsed";
    default:
      // A status this version does not know was written by a Stripe that knows
      // more. Guessing would either send a payer to a second page or strand
      // them on a dead one, so it is refused.
      return "unreadable";
  }
}

/**
 * The Stripe side of starting a checkout.
 *
 * **Returns its own unavailability rather than throwing it.** A missing secret
 * key is a deployment fact, not an error the person clicking `Buy` caused, and
 * the orchestration turns it into the same answer whatever provider it came
 * from.
 */
export function createStripeCheckoutProvider(
  env: NodeJS.ProcessEnv = process.env,
): CheckoutProvider | { readonly unavailable: StripeCheckoutUnavailable } {
  const runtime = readStripeRuntime(env);

  if (!runtime.ok) {
    return { unavailable: runtime.reason };
  }

  // **One construction, after the configuration has been read and found
  // whole.** Importing this file builds nothing.
  const stripe = new Stripe(runtime.secretKey);
  const config = runtime.config;
  const prices = config.prices;

  return {
    async createSession(request: CheckoutSessionRequest) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          line_items: [{ price: prices[request.plan], quantity: 1 }],
          // **The binding, and the only one.** Reconciliation reads this and
          // nothing else to decide whose subscription it is — never an email,
          // never a customer's name.
          subscription_data: {
            metadata: { [KOQENTRA_USER_ID_KEY]: request.userId },
          },
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          // **Derived from the attempt, not from the clock.** See
          // `sessionExpiresAt`: the same attempt must produce the same number
          // or the provider refuses the replay.
          expires_at: Math.floor(request.expiresAt.getTime() / 1000),
          automatic_tax: { enabled: false },
          allow_promotion_codes: false,
          tax_id_collection: { enabled: false },
          // Only when the account already has one. A customer is never looked
          // up by email, and one Stripe creates here is never written back —
          // reconciliation writes it, from the provider's own state.
          ...(request.providerCustomerId === null
            ? {}
            : { customer: request.providerCustomerId }),
        },
        // **The attempt's id is the key.** A retry of the same attempt replays
        // to the same session; a different attempt is a different purchase and
        // gets its own.
        { idempotencyKey: `checkout:${request.attemptId}` },
      );

      // **Refused before anybody is sent to it.** Thrown rather than returned
      // without a url, so the attempt is never marked open with this session:
      // an attempt that named it would later be resumed through `readSession`.
      // Nothing is asked of Stripe about the session — it lapses on its own.
      if (!matchesExpectedLivemode(config, session.livemode)) {
        throw new StripeLivemodeMismatchError();
      }

      return { sessionId: session.id, url: session.url };
    },

    async readSession(sessionId: string): Promise<ProviderSessionState> {
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // A stored session from the other world is not one to send anybody back
      // to. `unreadable` is what the orchestration already refuses.
      if (!matchesExpectedLivemode(config, session.livemode)) {
        return { kind: "unreadable", url: null };
      }

      return {
        kind: readSessionStatus(session.status ?? null),
        url: session.url,
      };
    },

    async findLiveSubscription(
      providerCustomerId: string,
    ): Promise<ProviderSubscriptionPresence> {
      // **`list`, never `search`.** Search is eventually consistent — Stripe
      // documents a lag of up to an hour during an outage — and a check that
      // can be an hour stale is no check at all for something that happened
      // ninety seconds ago.
      const subscriptions = await stripe.subscriptions.list({
        customer: providerCustomerId,
        status: "all",
        limit: 100,
      });

      const live = subscriptions.data.find((subscription) =>
        isBlockingStatus(subscription.status),
      );

      return live === undefined
        ? { kind: "none" }
        : { kind: "live", providerSubscriptionId: live.id };
    },
  };
}
