import "server-only";

import {
  type CheckoutAttemptPlan,
  isCheckoutAttemptPlan,
} from "@/lib/billing/checkout-attempt";
import { computeEntitlement } from "@/lib/entitlements/index";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * What somebody coming back from a payment page is told, and when.
 *
 * **A provider's redirect is not an entitlement.** Stripe sends people back the
 * moment the card clears, and what Koqentra knows at that instant is still
 * whatever it knew before: the subscription is created at the provider, a
 * webhook says so, and a reconciliation run reads the provider's state and
 * writes the entitlement. Measured in production, that took **52 seconds**; the
 * run that does it is a cron tick on a five-minute cadence, so it can take
 * longer. For the length of that window a page that reported what the row says
 * would tell somebody who has just paid that they are not on a plan — which is
 * how F-90 was found.
 *
 * **So the return page waits rather than reports.** This module answers three
 * things: the entitlement landed, or it has not landed yet and there is a
 * payment in flight to explain why, or neither. It never claims a purchase
 * succeeded on the strength of somebody having arrived at a URL.
 *
 * **Koqentra's own rows are the only source.** No provider is reached from here,
 * on any poll: a page that asked Stripe would be asking a second question whose
 * answer Koqentra has not acted on yet, and would be doing it on a loop. What
 * the provider says arrives through the webhook and the reconciliation, as it
 * already does.
 */

/**
 * What the return page has to say.
 *
 * **Four answers, because there are four situations and no more.** `pending` is
 * the one this module exists for; `not-entitled` covers both a payment that did
 * not result in an active plan and a state — behind on payment, cancelled inside
 * its period — that this screen deliberately does not write its own copy for,
 * because the plans page already says each of those precisely.
 */
export type CheckoutReturnStatus =
  /** Nothing has landed yet, and something is in flight that explains it. */
  | { readonly status: "pending" }
  /** A bought plan is in force. This is the only success. */
  | { readonly status: "active"; readonly plan: CheckoutAttemptPlan }
  /** Nothing is in flight and no bought plan is active. */
  | { readonly status: "not-entitled" }
  /** A row this version cannot read, or a query that failed. */
  | { readonly status: "unavailable" };

/** The columns `computeEntitlement` needs. The same set the pricing view reads. */
const SUBSCRIPTION_FIELDS = {
  plan: true,
  state: true,
  source: true,
  trialStartedAt: true,
  trialEndsAt: true,
  trialConsumedAt: true,
  trialForfeitedAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  notificationWorkerId: true,
  expiresAt: true,
} as const;

/**
 * What to tell this account about the payment it has just come back from.
 *
 * **Success is three facts together**, and every one of them is needed:
 * `active`, bought rather than granted, and a plan that can be bought. The
 * Closed Beta's accounts are `active` on a plan they did not pay for, and a
 * trial is `trialing` on a plan nobody sells — neither is a purchase landing,
 * and a check that read only the state would call both of them one.
 *
 * **Pending needs something in flight.** An attempt that is still open is what
 * says a payment may be on its way; without one, "not yet" would be a promise
 * with nothing behind it and the page would wait out its whole budget for
 * somebody who typed the URL. It is never enough on its own, though — an open
 * attempt says a checkout was started, not that it was paid for.
 *
 * @param userId from the session, never from a request payload
 */
export async function readCheckoutReturnStatus(
  userId: string,
  options: { readonly now?: Date; readonly client?: DbClient } = {},
): Promise<CheckoutReturnStatus> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();

  const [subscription, attempt] = await Promise.all([
    client.subscription.findUnique({
      where: { userId },
      select: SUBSCRIPTION_FIELDS,
    }),
    client.checkoutAttempt.findUnique({
      where: { userId },
      select: { state: true, expiresAt: true },
    }),
  ]);

  if (subscription !== null) {
    let settled: CheckoutReturnStatus | null;

    try {
      settled = readSettled(subscription);
    } catch {
      // A state written by a version that knew more. Describing it would be
      // guessing at what somebody just paid for.
      return { status: "unavailable" };
    }

    if (settled !== null) {
      return settled;
    }
  }

  return inFlight(attempt, now) ? { status: "pending" } : { status: "not-entitled" };
}

/**
 * A bought plan in force, or nothing to report yet.
 *
 * Returns `null` rather than `not-entitled` so the caller can still look for a
 * payment in flight — a subscription row exists long before a purchase lands,
 * and its state during the window is the state the purchase is replacing.
 */
function readSettled(
  row: Parameters<typeof computeEntitlement>[0] & { readonly source: string },
): CheckoutReturnStatus | null {
  const entitlement = computeEntitlement(row, new Date());

  if (entitlement.state !== "active" || row.source !== "stripe") {
    return null;
  }

  // **A plan that cannot be bought cannot be what was bought.** `beta` is
  // granted and `trial` is not sold, so neither may satisfy a return from a
  // payment page whatever the state column says.
  return isCheckoutAttemptPlan(entitlement.plan)
    ? { status: "active", plan: entitlement.plan }
    : null;
}

/** Whether a checkout is still able to be paid for. */
function inFlight(
  attempt: { readonly state: string; readonly expiresAt: Date } | null,
  now: Date,
): boolean {
  return (
    attempt !== null &&
    attempt.state !== "closed" &&
    attempt.expiresAt.getTime() > now.getTime()
  );
}
