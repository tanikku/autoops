import "server-only";

import { prisma } from "@/lib/prisma";
import { getPlanDefinition } from "@/lib/plans";
import {
  InvalidSubscriptionError,
  isSubscriptionState,
} from "@/lib/entitlements/states";
import type {
  EffectiveEntitlement,
  EntitlementLimits,
  EntitlementState,
  SubscriptionRecord,
} from "@/lib/entitlements/types";

/**
 * What an account may do, worked out rather than looked up.
 *
 * **Nothing acts on this.** One caller reads it — the eligibility rule, to see
 * whether an account is already entitled before offering it a trial — and no
 * scheduler, dispatcher or run does. A worker that runs today runs for exactly
 * the reasons it ran yesterday, whatever the state below says.
 *
 * **`now` is an argument, everywhere it can be.** Three of the eight states
 * below are the clock's opinion about a stored row, and a boundary tested
 * against the wall clock is a boundary tested once a day by accident.
 */

/**
 * The answer for an account with no entitlement row.
 *
 * **A perfectly ordinary condition.** Rows here are created when somebody
 * starts a trial or buys a plan, and an account that has done neither is not
 * missing anything. Nothing provisions one to make this look tidier — that
 * would make signing in a billing event.
 */
export const NO_ENTITLEMENT: EffectiveEntitlement = {
  state: "none",
  entitled: false,
  plan: null,
  limits: null,
  trial: null,
  period: null,
  expiresAt: null,
  notificationWorkerId: null,
};

/** Which fields of a stored row the domain is allowed to see. */
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
 * Works out the state, and whether anything may be done under it.
 *
 * The order is what makes the rules readable:
 *
 * 1. **An expiry that has passed ends it, whatever the state says.** A grant
 *    with a date on it stops on that date; nothing has to run to make that
 *    true.
 * 2. A trial is judged against its own end, not against a period.
 * 3. A cancellation is judged against the period somebody already paid for.
 * 4. Everything else is what it says it is.
 *
 * **`grace` keeps access on purpose.** It means a payment is in question, and
 * stopping an account's workers while its card is re-authorised would punish
 * the wrong thing; what ends access is the state that follows if it is never
 * sorted out.
 */
function resolveState(
  record: SubscriptionRecord,
  now: Date,
): { state: EntitlementState; entitled: boolean } {
  if (!isSubscriptionState(record.state)) {
    throw new InvalidSubscriptionError(`unknown state ${record.state}`);
  }

  if (record.expiresAt !== null && now.getTime() >= record.expiresAt.getTime()) {
    return { state: "expired", entitled: false };
  }

  if (record.state === "trialing") {
    // A trial that cannot say when it ends cannot be judged, and guessing
    // would either extend it forever or end it now. Neither is a reading.
    if (record.trialEndsAt === null) {
      throw new InvalidSubscriptionError("a trial with no end");
    }

    return now.getTime() >= record.trialEndsAt.getTime()
      ? { state: "trial_expired", entitled: false }
      : { state: "trialing", entitled: true };
  }

  if (record.state === "canceled_active") {
    const end = record.currentPeriodEnd;

    // No period end on a cancellation means nothing says when access stops,
    // and a cancellation that never takes effect is not a cancellation.
    if (end === null) {
      throw new InvalidSubscriptionError("a cancellation with no period end");
    }

    return now.getTime() >= end.getTime()
      ? { state: "inactive", entitled: false }
      : { state: "canceled_active", entitled: true };
  }

  if (record.state === "inactive") {
    return { state: "inactive", entitled: false };
  }

  return { state: record.state, entitled: true };
}

/** A plan's numbers, copied into the shape features read. */
function limitsOf(plan: string): EntitlementLimits {
  const definition = getPlanDefinition(plan);

  return {
    activeWorkerLimit: definition.activeWorkerLimit,
    aiProcessingLimit: definition.aiProcessingLimit,
    manualRunLimit: definition.manualRunLimit,
    discoveryLimit: definition.discoveryLimit,
    history: definition.history,
    email: definition.email,
  };
}

/**
 * The whole of the decision, with no database in it.
 *
 * Separated from the read so the eight states and their boundaries can be
 * fixed by tests that hold a row and an instant, and nothing else.
 *
 * **The limits are reported whether or not they apply.** A trial that ran out
 * yesterday still says what a trial allows, because a screen asking why
 * somebody stopped being able to do something needs to say what they had.
 * `entitled` is what decides; the numbers are what explains.
 */
export function computeEntitlement(
  record: SubscriptionRecord | null,
  now: Date,
): EffectiveEntitlement {
  if (record === null) {
    return NO_ENTITLEMENT;
  }

  const { state, entitled } = resolveState(record, now);

  return {
    state,
    entitled,
    plan: getPlanDefinition(record.plan).id,
    limits: limitsOf(record.plan),
    trial:
      record.trialStartedAt === null && record.trialConsumedAt === null
        ? null
        : {
            startedAt: record.trialStartedAt,
            endsAt: record.trialEndsAt,
            consumed: record.trialConsumedAt !== null,
          },
    period:
      record.currentPeriodStart === null || record.currentPeriodEnd === null
        ? null
        : { start: record.currentPeriodStart, end: record.currentPeriodEnd },
    expiresAt: record.expiresAt,
    notificationWorkerId: record.notificationWorkerId,
  };
}

/**
 * What one account may do, right now.
 *
 * **Read by account, and the account comes from the session.** The argument is
 * a `User.id`, which is a Google account id; no caller may supply one from a
 * form, for the same reason no other owned read accepts one.
 */
export async function getEffectiveEntitlement(
  userId: string,
  now: Date = new Date(),
): Promise<EffectiveEntitlement> {
  const record = await prisma.subscription.findUnique({
    where: { userId },
    select: RECORD_FIELDS,
  });

  return computeEntitlement(record, now);
}
