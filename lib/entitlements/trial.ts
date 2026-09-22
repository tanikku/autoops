import { getPlanDefinition } from "@/lib/plans";
import { computeEntitlement } from "@/lib/entitlements/index";
import type { SubscriptionRecord } from "@/lib/entitlements/types";

/**
 * When a trial would end, and whether one may be started at all.
 *
 * **The arithmetic and the rule, kept apart from the starting.** What calls
 * these is `startTrialOnFirstWorkerActivation`, at the two boundaries where a
 * worker of an account becomes active — a worker can be created active as
 * easily as it can be switched on later, so both are activations. Keeping the
 * decision here means it can be fixed by tests that hold a row and an instant,
 * without a transaction anywhere near them.
 *
 * **Neither of these enforces anything.** A trial that has run out still
 * refuses a second trial and stops nothing else; see `computeEntitlement`,
 * where an ended trial is worked out rather than stored.
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
 * Whether this entitlement is one somebody was given rather than bought.
 *
 * **Two durable columns and nothing else.** Not the expiry, not the state, not
 * whether it currently entitles anything — all of those are answers about
 * *now*, and this is a question about what the account has been. A grant that
 * ran out is still a grant that was made.
 *
 * **Nothing about the current cohort is written here.** No account id, no
 * email, no date: any account given the beta allowance in future is covered by
 * the same two columns, because that is what being given it consists of.
 */
export function isAdminGrantedBeta(record: SubscriptionRecord): boolean {
  return record.plan === "beta" && record.source === "admin";
}

/**
 * Whether this account may begin a trial.
 *
 * Three questions, asked in this order:
 *
 * - **Has it ever been given the beta allowance?** If so, never — see below.
 * - **Has it used a trial?** `trialConsumedAt` stays set after the trial ends
 *   and after a plan is bought, because what was spent was the offer.
 * - **Does anything currently entitle it?** An account in the middle of a paid
 *   plan is not owed a free fortnight on top.
 *
 * No row at all means the last two are both true, which is the ordinary case.
 *
 * **Why the first question exists.** The carried-over accounts were given the
 * beta allowance free, for months, without a card. The trial is an offer to
 * people who have not tried Koqentra yet, and they have — so when their grant
 * ends they are being asked to decide, not offered another free run at it.
 *
 * **Why it is asked first, and from the grant rather than from a trial
 * column.** Every other signal moves: the grant expires, `entitled` turns
 * false, and the two conditions below would then both be true. Marking the
 * accounts as having consumed a trial would have made them lie — they never had
 * one — and would have meant rewriting five rows that are already correct. What
 * is durable is that the grant was made at all, and that is what this reads.
 */
export function isTrialEligible(
  record: SubscriptionRecord | null,
  now: Date,
): boolean {
  if (record === null) {
    return true;
  }

  // **Before the entitlement is computed**, so an expired grant — or one whose
  // state this version could not read — answers the same way a live one does.
  if (isAdminGrantedBeta(record)) {
    return false;
  }

  return (
    record.trialConsumedAt === null && !computeEntitlement(record, now).entitled
  );
}
