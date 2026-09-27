"use server";

import {
  type CheckoutReturnStatus,
  readCheckoutReturnStatus,
} from "@/lib/billing/checkout-return";
import { requireUserId } from "@/lib/session";

/**
 * What a page waiting for a purchase to land is allowed to ask.
 *
 * **It reads and it cannot do anything else.** No provider is reached, no
 * reconciliation is triggered, no cron is invoked, nothing is written — including
 * the account row, which is why this authenticates with `requireUserId` rather
 * than provisioning. A screen that polls must not be able to cause anything, and
 * this one structurally cannot.
 *
 * **It takes no arguments, and that is the security property.** There is nothing
 * to send: not an account, not a session id, not a plan. The account is whoever
 * the session says it is, so the answer cannot be aimed at somebody else however
 * the call is made.
 *
 * **What comes back is three words and a plan name at most.** A provider's
 * identifiers, the attempt's id, the reconciliation's id and the reason behind a
 * failure are all things a browser has no use for and a history should not hold.
 */
export async function readCheckoutReturnStatusAction(): Promise<CheckoutReturnStatus> {
  // A visitor with no session is redirected, which travels as a thrown error and
  // is left to travel: answering them would be showing a status on a page they
  // are not signed in to.
  const userId = await requireUserId();

  try {
    return await readCheckoutReturnStatus(userId);
  } catch (error) {
    // **The category, never the cause.** A driver's complaint names a host and a
    // database; "not right now" is the whole of what a waiting page can act on.
    console.error(
      "[checkout] could not read the return status —",
      error instanceof Error ? error.name : "an unexpected failure",
    );

    return { status: "unavailable" };
  }
}
