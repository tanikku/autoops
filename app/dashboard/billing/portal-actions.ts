"use server";

import { describeBillingError } from "@/lib/billing/error-category";
import { openBillingPortal } from "@/lib/billing/portal";
import { createStripeBillingPortalProvider } from "@/lib/billing/providers/stripe-portal";
import { requireUserId } from "@/lib/session";

/**
 * The doorway between the plans page and the provider's billing portal.
 *
 * **Nothing arrives from the browser.** Not an account, not a customer, not a
 * return address: the account is the session's, the customer is read from that
 * account's own row, and the return address is fixed. An action that took any
 * of them would be an action somebody could point at somebody else's billing.
 *
 * **Not behind checkout's rollout switch.** Starting a purchase and managing
 * one already made are separate questions, and closing the first must leave
 * every paying account able to reach the second — to cancel, above all. Who
 * may open the portal is decided by `openBillingPortal` from the account's own
 * subscription: bought through Stripe, on a paid plan, in a state there is
 * something to manage, with a customer on record. Anybody else is refused there,
 * on the server, whatever the page showed.
 *
 * **No provisioning.** Opening a portal writes no row, so the read-only
 * `requireUserId` is all this needs.
 */

export type OpenBillingPortalActionResult =
  | { readonly outcome: "portal-ready"; readonly url: string }
  | { readonly outcome: "not-eligible" }
  | { readonly outcome: "unavailable" };

export async function openBillingPortalAction(): Promise<OpenBillingPortalActionResult> {
  // A redirect travels as a thrown error and is left to travel.
  const userId = await requireUserId();

  const provider = createStripeBillingPortalProvider();

  try {
    const result = await openBillingPortal({ userId, provider });

    if (result.outcome === "unavailable") {
      // **A closed set of reasons, and nothing else.** No account, no
      // customer, no address: the portal url is a credential for the page it
      // opens and does not belong in a log.
      console.error(`[portal] could not open the billing portal — ${result.reason}`);

      return { outcome: "unavailable" };
    }

    // Rebuilt rather than passed through, so a field added to the
    // orchestration's answer does not reach a browser by default.
    return result.outcome === "portal-ready"
      ? { outcome: "portal-ready", url: result.url }
      : { outcome: "not-eligible" };
  } catch (error) {
    console.error(`[portal] could not open the billing portal — ${describeBillingError(error)}`);

    return { outcome: "unavailable" };
  }
}
