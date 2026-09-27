import "server-only";

import {
  closeCheckoutAttempt,
  isCheckoutAttemptPlan,
} from "@/lib/billing/checkout-attempt";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Letting go of the slot a purchase has finished with.
 *
 * **The provider is what says a checkout is over, not the browser.** An attempt
 * holds the account's one coordination slot until it is closed or lapses, and
 * nothing closed it when a payment succeeded — so a paid-for attempt sat `open`
 * for the eighteen hours of its TTL, which is F-91. Waiting for somebody to come
 * back to a success page would not fix it: they can close the tab, lose signal,
 * or pay on a phone and never return, and the slot would still be held.
 * Reconciliation, which reads the provider's own state, always runs.
 *
 * **Coordination cleanup may never undo a domain truth.** This is called *after*
 * the reconciliation transaction has committed, not inside it: an entitlement
 * that has been applied is what the account is owed, and a failure to tidy a
 * coordination row is not a reason to take it away again. If this does nothing —
 * because the query failed, or because the rules below refuse — the attempt is
 * left exactly as it is today and lapses at its TTL.
 *
 * **It refuses far more often than it acts.** Closing the wrong attempt would
 * release a slot somebody else's purchase is holding, so every condition has to
 * agree before anything is written.
 */

/** What the cleanup did, or why it did nothing. */
export type CloseSettledCheckoutAttemptResult =
  | { readonly outcome: "closed" }
  /** Nothing was holding a slot. */
  | { readonly outcome: "no-attempt" }
  /** Already closed, by a lapse or by an earlier run. */
  | { readonly outcome: "already-closed" }
  /** The attempt is for a different plan from the one that activated. */
  | { readonly outcome: "plan-mismatch" }
  /** The attempt was taken after this subscription started: a later purchase. */
  | { readonly outcome: "newer-attempt" }
  /** The plan that activated is not one this module can match an attempt to. */
  | { readonly outcome: "not-a-bought-plan" };

/**
 * Closes the attempt this activation was the end of, if that is what it was.
 *
 * Every condition, and why each one is there:
 *
 * - **Same account.** `CheckoutAttempt.userId` is unique, so the account's one
 *   attempt is the only candidate — there is no set to choose from and therefore
 *   nothing to choose wrongly.
 * - **Same plan.** An attempt for Standard is not ended by a Lite subscription
 *   activating; whatever produced that pair, releasing the slot would let a
 *   second purchase start beside a first that is still live at the provider.
 * - **Taken before the subscription began.** An attempt created *after* the
 *   provider's period started is a later purchase in progress, and this
 *   activation is not its ending. This is the condition that makes a late
 *   reconciliation run — a redelivery an hour afterwards — safe.
 * - **Not already closed.** Handled by `closeCheckoutAttempt`, which writes
 *   nothing to a closed row and says so.
 *
 * **Only an activation calls this.** A cancellation, a renewal, a plan change or
 * a run that found nothing to do all leave the attempt alone: none of them is a
 * purchase completing, and a cancellation arriving while somebody is midway
 * through buying must not release their slot.
 *
 * @param plan the plan that activated, as the provider stated it
 * @param subscriptionStartedAt the start of the period the provider activated
 */
export async function closeSettledCheckoutAttempt(input: {
  readonly userId: string;
  readonly plan: string;
  readonly subscriptionStartedAt: Date;
  readonly client?: DbClient;
}): Promise<CloseSettledCheckoutAttemptResult> {
  const client = input.client ?? prisma;

  if (!isCheckoutAttemptPlan(input.plan)) {
    return { outcome: "not-a-bought-plan" };
  }

  const attempt = await client.checkoutAttempt.findUnique({
    where: { userId: input.userId },
    select: { id: true, plan: true, state: true, createdAt: true },
  });

  if (attempt === null) {
    return { outcome: "no-attempt" };
  }

  if (attempt.state === "closed") {
    return { outcome: "already-closed" };
  }

  if (attempt.plan !== input.plan) {
    return { outcome: "plan-mismatch" };
  }

  if (attempt.createdAt.getTime() > input.subscriptionStartedAt.getTime()) {
    return { outcome: "newer-attempt" };
  }

  const closed = await closeCheckoutAttempt({
    attemptId: attempt.id,
    client,
  });

  return closed.outcome === "closed"
    ? { outcome: "closed" }
    : // A lapse or a concurrent close got there first. Either way the slot is
      // free, which is the point.
      { outcome: "already-closed" };
}
