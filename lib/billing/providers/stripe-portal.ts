import "server-only";

import Stripe from "stripe";
import type {
  BillingPortalProvider,
  BillingPortalSessionRequest,
} from "@/lib/billing/portal";
import {
  readStripeRuntime,
  type StripeRuntime,
} from "@/lib/billing/providers/stripe-runtime";

/**
 * The Stripe side of opening a billing portal.
 *
 * **Two parameters, and the absence of the rest is the point.** No
 * `configuration`, so the account's default portal configuration applies — the
 * one whose plan switching is checked to be off before this is rolled out. No
 * `flow_data`, so nothing deep-links into a cancellation or a plan change. No
 * subscription, no plan: this opens a page and changes nothing.
 *
 * **Built on use, never on import**, through the same runtime reader checkout
 * uses, so a deployment with no Stripe configuration still starts.
 */

export type StripePortalUnavailable = Extract<
  StripeRuntime,
  { ok: false }
>["reason"];

export function createStripeBillingPortalProvider(
  env: NodeJS.ProcessEnv = process.env,
): BillingPortalProvider | { readonly unavailable: StripePortalUnavailable } {
  const runtime = readStripeRuntime(env);

  if (!runtime.ok) {
    return { unavailable: runtime.reason };
  }

  const stripe = new Stripe(runtime.secretKey);

  return {
    async createPortalSession(request: BillingPortalSessionRequest) {
      const session = await stripe.billingPortal.sessions.create({
        customer: request.customerId,
        return_url: request.returnUrl,
      });

      return { url: typeof session.url === "string" ? session.url : null };
    },
  };
}
