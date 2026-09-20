/**
 * The states an entitlement row may be stored in, and the ones only ever
 * worked out.
 *
 * **Five are written down; three are not.** "No subscription at all", "the
 * trial has run out" and "the grant has expired" are all answers to the
 * question "what time is it now", and a column holding one of them would be a
 * fact that goes stale on its own — needing a job to keep it true, and being
 * wrong in between. What is stored is what somebody decided; what is derived is
 * what the clock says about it. See `computeEntitlement`.
 */

/** What a `Subscription.state` column may say. */
export const subscriptionStates = [
  /** A trial is running. Ends at `trialEndsAt`. */
  "trialing",
  /** A paid or granted entitlement is in force. */
  "active",
  /** Payment is in question, and access continues while it is sorted out. */
  "grace",
  /** Cancelled, and still usable until `currentPeriodEnd`. */
  "canceled_active",
  /** Over. Nothing is deleted; nothing runs. */
  "inactive",
] as const;

export type SubscriptionState = (typeof subscriptionStates)[number];

/** Whether a stored string names a state this version knows. */
export function isSubscriptionState(value: unknown): value is SubscriptionState {
  return (
    typeof value === "string" &&
    (subscriptionStates as readonly string[]).includes(value)
  );
}

/**
 * A stored entitlement that cannot be read.
 *
 * **Thrown rather than absorbed.** An unreadable row is not the same as an
 * account with no entitlement: treating it as one would hand somebody an
 * allowance nobody granted, or take away one somebody paid for, and either way
 * the error would be invisible. Failing closed here means the question goes
 * unanswered, which is the only honest answer available.
 */
export class InvalidSubscriptionError extends Error {
  constructor(reason: string) {
    super(`Unreadable subscription: ${reason}`);
    this.name = "InvalidSubscriptionError";
  }
}
