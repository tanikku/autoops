import "server-only";

import { computeEntitlement } from "@/lib/entitlements/index";
import { getPlanDefinition } from "@/lib/plans";
import type { DbClient } from "@/lib/prisma";

/**
 * How many workers this account may run at once.
 *
 * **Capacity, not consumption**, which is why it is here rather than in
 * `lib/usage/`. A counter records what a period has spent and only goes up; how
 * many workers are active is a number that moves in both directions all day,
 * and pausing one frees a slot with nothing having to be told. The question is
 * "how many may be on", and the answer is a plan's, not a period's.
 *
 * **One number, from one place.** The plans catalogue already says what each
 * plan allows; `computeEntitlement` already works out which plan applies. This
 * puts those two together and adds nothing — no second table of limits, and no
 * `3` written down anywhere a worker action could read it.
 */

/**
 * The plan an account is judged against before it has any entitlement.
 *
 * **Not a special case, and not a hardcoded three.** An account with no
 * `Subscription` is one that has not activated a worker yet — and the moment it
 * does, the trial it starts is the entitlement it will have. Judging it by the
 * trial's own allowance is therefore not a guess about the future; it is the
 * same number it is about to be given, read from the same catalogue.
 */
const PRE_TRIAL_PLAN = "trial" as const;

/** Which stored columns the entitlement is worked out from. */
const RECORD_FIELDS = {
  plan: true,
  state: true,
  trialStartedAt: true,
  trialEndsAt: true,
  trialConsumedAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  notificationWorkerId: true,
  source: true,
  expiresAt: true,
} as const;

/**
 * The account's active-worker capacity at this instant.
 *
 * **Read with the caller's client, so it can join a transaction.** The decision
 * has to be made inside the same transaction as the count and the write — see
 * `claimWorkerActivation`, where the account's own row is already locked. A
 * limit read on a separate connection would be a limit read at a different
 * moment.
 *
 * **The limits are reported for every state, including the ones that entitle
 * nothing.** An entitlement that has lapsed still says what its plan allowed,
 * because a screen explaining why somebody stopped being able to do something
 * needs the number they had. Capacity therefore does not change the day a
 * grant or a trial runs out — what happens *then* is an expiry question, and
 * this phase does not answer it. Nothing here blocks because something ended.
 *
 * **An unreadable entitlement throws rather than falls back.** A stored state
 * this version does not recognise was written by one that knew more, and
 * guessing a capacity from it would either hand out slots nobody granted or
 * take away ones somebody has. The activation fails, which is the only honest
 * answer available — the same rule `computeEntitlement` already follows.
 */
export async function resolveActiveWorkerLimit(
  client: DbClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const record = await client.subscription.findUnique({
    where: { userId },
    select: RECORD_FIELDS,
  });

  const { limits } = computeEntitlement(record, now);

  // `limits` is null only for an account with no row at all, which is exactly
  // the account that is about to be given a trial.
  return (
    limits?.activeWorkerLimit ??
    getPlanDefinition(PRE_TRIAL_PLAN).activeWorkerLimit
  );
}
