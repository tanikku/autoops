import { getPlanDefinition } from "@/lib/plans";
import { computeEntitlement } from "@/lib/entitlements/index";
import type { SubscriptionRecord } from "@/lib/entitlements/types";

/**
 * When a trial would end, and whether one may be started at all.
 *
 * **Neither of these starts anything, and nothing calls them.** A trial begins
 * the first time a worker of an account becomes active, and that is a change to
 * `claimWorkerCreation` and `claimWorkerActivation` — both of them, since a
 * worker can be created active as easily as it can be switched on later.
 * Neither has been touched. What is here is the arithmetic and the eligibility
 * rule, so that when the integration arrives it is a call rather than a
 * decision.
 */

/** How long a trial lasts, in milliseconds. */
const TRIAL_DURATION_MS =
  // Non-null by construction: the trial plan is the one that defines a length,
  // and the assertion is a `?? 0` rather than a `!` so a catalogue that ever
  // stopped saying so fails visibly instead of producing `NaN`.
  (getPlanDefinition("trial").trialDurationDays ?? 0) * 24 * 60 * 60 * 1000;

/**
 * When a trial started at this instant would end.
 *
 * **Plain instant arithmetic, and no timezone anywhere.** Fourteen days is
 * fourteen days wherever somebody is; reading `User.timezone` here would mean a
 * trial's length changed when its owner moved, and that somebody could extend
 * one by changing a setting.
 *
 * The result is written to `Subscription.trialEndsAt` rather than recomputed,
 * so a later change to the length cannot move an end date somebody was already
 * told about.
 */
export function computeTrialEnd(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TRIAL_DURATION_MS);
}

/**
 * Whether this account may begin a trial.
 *
 * Two conditions, and both are needed:
 *
 * - **It has never used one.** `trialConsumedAt` stays set after the trial ends
 *   and after a plan is bought, because what was spent was the offer.
 * - **Nothing currently entitles it.** An account in the middle of a paid plan,
 *   or holding a grant, is not owed a free fortnight on top.
 *
 * No row at all means both are true, which is the ordinary case.
 */
export function isTrialEligible(
  record: SubscriptionRecord | null,
  now: Date,
): boolean {
  if (record === null) {
    return true;
  }

  return (
    record.trialConsumedAt === null && !computeEntitlement(record, now).entitled
  );
}
