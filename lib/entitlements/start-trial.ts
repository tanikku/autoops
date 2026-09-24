import "server-only";

import type { DbClient } from "@/lib/prisma";
import { computeTrialEnd, isTrialEligible } from "@/lib/entitlements/trial";
import type { SubscriptionRecord } from "@/lib/entitlements/types";
import { planLimitFor } from "@/lib/usage/period";
import { usageKinds } from "@/lib/usage/types";

/**
 * Where a trial begins: the first time a worker of an account becomes active.
 *
 * **Not signing up, and not drafting a worker.** An account that exists has
 * decided nothing, and a draft is a form somebody is still filling in; neither
 * is a use of Koqentra, and starting a fourteen-day clock on either would spend
 * somebody's trial while they were still reading. What a trial measures is
 * having something running, so it starts when something starts running.
 *
 * **It is one call inside somebody else's transaction, on purpose.** The
 * activation and the trial commit together or not at all — see
 * `startTrialOnFirstWorkerActivation` for why that is the whole design rather
 * than a detail of it.
 *
 * **Nothing here enforces anything.** The trial's limits are written down and
 * then read by nobody: no scheduler asks, no run is refused, no draft fails.
 * This phase makes the durable state correct so that the phase which acts on it
 * is a change to callers rather than a change to the truth.
 */

/** The plan a trial runs on. Its numbers live in `lib/plans.ts`. */
const TRIAL_PLAN = "trial" as const;

/** The state a running trial is stored in. See `lib/entitlements/states.ts`. */
const TRIAL_STATE = "trialing" as const;

/**
 * How this entitlement came about.
 *
 * **`"trial"`, because the schema already says so.** `Subscription.source` is
 * documented as "trial", "admin", or a provider's name, and two of those three
 * are already written by code. Inventing a fourth word for the one case the
 * vocabulary was designed around would leave the column meaning two things.
 */
const TRIAL_SOURCE = "trial" as const;

/** What an attempt to start a trial did, and why. */
export type TrialStartResult =
  /** A trial now exists. The instants are the ones written down. */
  | {
      readonly outcome: "started";
      readonly startedAt: Date;
      readonly endsAt: Date;
    }
  /**
   * The account already has a trial row.
   *
   * **Including one whose fourteen days have run out.** A trial that ended is
   * still the trial this account had, and the wall clock is not something an
   * activation may wind back. See `lib/entitlements/index.ts`, where an ended
   * trial is worked out rather than stored.
   */
  | { readonly outcome: "already-trialing" }
  /** Something else entitles the account, or its one trial is spent. */
  | { readonly outcome: "not-eligible" }
  /** A worker of this account was already active, so this is not the first. */
  | { readonly outcome: "not-first-activation" };

/** Which stored columns the eligibility rule is allowed to see. */
const RECORD_FIELDS = {
  plan: true,
  state: true,
  trialStartedAt: true,
  trialEndsAt: true,
  trialConsumedAt: true,
  trialForfeitedAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  notificationWorkerId: true,
  source: true,
  expiresAt: true,
} as const;

/** The one allowance an account can spend before it has a trial. */
const CARRIED_KIND = "aiProcessing" as const;

/**
 * How much AI processing this account has already done.
 *
 * **Counted from the product's own bookkeeping, not from the provider's.**
 * `UsageCounter` is what "AI processing" means as a thing an account spends;
 * `ProviderUsageEvent` is what a call to a model cost. The two happen to move
 * together today — one row each, from the same two functions — but that is a
 * property of where the recording sits rather than a promise. A feature that
 * one day makes two model calls for one unit of processing would break the
 * arithmetic silently, and the wrong number would be a quota somebody was given
 * or denied. So this reads the counters, and nothing here goes near the
 * telemetry.
 *
 * **Every counter the account has is pre-trial usage, and the reason is the
 * ordering.** A trial has no period until the lines below create one, so at the
 * moment this runs there is nothing to exclude: whatever `UsagePeriod` rows
 * exist were opened by observation before any trial began. It sums across all
 * of them on purpose — observation's fallback window is the calendar month, so
 * somebody who drafted in September and activated in October has two rows, and
 * reading only the current one would hand back the September usage as unspent.
 *
 * **Summed by PostgreSQL, not in JavaScript.** This runs inside a transaction
 * holding a lock on the account; pulling rows back to add them up would hold it
 * open for work the database does in the same round trip.
 *
 * **Exported so the screen and the write say the same number.** The form that
 * explains "this will carry into your trial" has to mean exactly what the
 * trial start will do, and two readings of "how much AI has this account
 * used" would eventually disagree — most likely at the moment somebody is
 * looking at one of them. There is one definition, and this is it.
 *
 * **Nothing is repaired.** A unit that observation failed to record is gone,
 * and reconstructing it from the provider's side would be answering a product
 * question with a cost measurement. What this returns is what was durably
 * observed, which is what the allowance is denominated in.
 */
export async function readPreTrialAiProcessing(
  client: DbClient,
  userId: string,
): Promise<number> {
  const { _sum } = await client.usageCounter.aggregate({
    _sum: { used: true },
    // Reached through the period because that is where the account is named —
    // a counter belongs to a period, and a period belongs to somebody.
    where: { kind: CARRIED_KIND, period: { userId } },
  });

  // Null rather than zero when no counter matched: the account has done nothing
  // observable, which is the ordinary case and not a missing answer.
  return _sum.used ?? 0;
}

/**
 * Starts the trial, if this activation is the one that should start it.
 *
 * **Call it inside the transaction that activates the worker, after the quota
 * claim.** Both of those are load-bearing:
 *
 * - *Inside the transaction*, because §7 of the contract is that a trial is
 *   spent by a successful activation rather than by an attempt. A trial written
 *   separately would survive an activation that then failed, and the account
 *   would have paid its one offer for a worker that does not exist. Sharing the
 *   transaction makes that unrepresentable instead of unlikely.
 * - *After the claim*, because `claimWorkerCreation` and `claimWorkerActivation`
 *   take the account's own row first — see `lockAccountForWorkerQuota`. That
 *   lock is what makes the count below a count nothing else can be changing,
 *   and it is the same lock, held by the same transaction, so this takes
 *   nothing new and waits for nobody.
 *
 * **And call it before the worker is written**, because "first" is read as
 * *no worker is active yet*. Asking afterwards would mean asking whether
 * exactly one is, which is the same question phrased so that inserting a second
 * call site gets it wrong.
 *
 * **Two concurrent first activations produce one trial, twice over.** Serialized
 * by the account lock, the second transaction counts the first one's worker and
 * answers `not-first-activation`. If it somehow ran without that lock, the
 * `@unique` on `Subscription.userId` refuses the second row and rolls its whole
 * transaction back — so the failure mode is a refused activation, never two
 * trials or a trial with two clocks.
 *
 * **No provider is called and nothing is sent.** No Stripe, no model, no email,
 * no notification: a transaction holding a lock on an account has no business
 * waiting on a network, and a trial is a fact about a row rather than an event
 * anybody needs to be told about yet.
 */
export async function startTrialOnFirstWorkerActivation(
  client: DbClient,
  userId: string,
  now: Date = new Date(),
): Promise<TrialStartResult> {
  // **Asked first, and it is the cheapest question.** Most activations are not
  // the first one, and those should not read an entitlement to find that out.
  const active = await client.routine.count({
    where: { userId, status: "active" },
  });

  if (active > 0) {
    return { outcome: "not-first-activation" };
  }

  const record: SubscriptionRecord | null =
    await client.subscription.findUnique({
      where: { userId },
      select: RECORD_FIELDS,
    });

  // **Before eligibility, so the answer says which thing happened.** An account
  // whose workers were all paused and one switched back on is not ineligible
  // for something — it is already having it. See §14: the clock is wall-clock
  // time from the first activation, and pausing does not stop it.
  if (record !== null && record.state === TRIAL_STATE) {
    return { outcome: "already-trialing" };
  }

  // The existing rule, unchanged and not restated. Admin beta is refused here
  // for the same reason it is refused everywhere — see `isAdminGrantedBeta`.
  if (!isTrialEligible(record, now)) {
    return { outcome: "not-eligible" };
  }

  // **Read before anything is written, and never caught.** A trial that began
  // with an assumed zero because this query failed would hand back an allowance
  // the account had already spent — so a failure here takes the activation down
  // with it, and the person retries against a database that is answering. See
  // the function's own note.
  const carriedIn = await readPreTrialAiProcessing(client, userId);

  const startedAt = now;
  const endsAt = computeTrialEnd(startedAt);

  // **`create`, not `upsert`.** An upsert would quietly accept a row this
  // account already had and write today's dates over it, which is exactly the
  // restart every rule above exists to prevent. A constraint failure here means
  // something raced past the lock, and rolling the activation back is the
  // honest outcome — the person retries, and the second attempt reads the row
  // that now exists.
  await client.subscription.create({
    data: {
      userId,
      plan: TRIAL_PLAN,
      state: TRIAL_STATE,
      source: TRIAL_SOURCE,
      trialStartedAt: startedAt,
      // **Written down rather than derived.** Changing how long a trial lasts
      // must not move an end date somebody has already been shown.
      trialEndsAt: endsAt,
      // **Set at the start, not at the end.** What is spent is the offer, and
      // it is spent the moment it is taken up; a column filled in when the
      // fourteen days ran out would need something to run to fill it in, and
      // would be wrong until it did.
      trialConsumedAt: startedAt,
      // A trial has no expiry of its own — `trialEndsAt` is when it ends, and a
      // second date saying the same thing is a second date that can disagree.
      expiresAt: null,
      // Nobody has bought anything, so there is no billing cycle and no
      // provider. These are null because they are unknown, not because they are
      // empty.
      currentPeriodStart: null,
      currentPeriodEnd: null,
      providerCustomerId: null,
      providerSubscriptionId: null,
      providerUpdatedAt: null,
    },
  });

  // **The trial's own fourteen days, not the calendar month.** A trial that
  // began on the twenty-eighth would otherwise be measured against three days
  // of one month and eleven of the next, and the allowance would reset in the
  // middle of it. See `resolveUsageWindow`, which sends the counting here.
  await client.usagePeriod.create({
    data: {
      userId,
      periodStart: startedAt,
      periodEnd: endsAt,
      planAtStart: TRIAL_PLAN,
      // **Stamped with the period's own start.** `createdAt` is otherwise a few
      // milliseconds later, and `partialPeriod` is derived from exactly that
      // comparison — a trial period opened at its own first instant would
      // report itself as covering only part of a window it covers all of.
      createdAt: startedAt,
      counters: {
        // Three, one per allowance, and no fourth. How many workers are active
        // is live state that goes up and down; a period does not accumulate
        // them, and a counter for it would be a number nothing could spend.
        create: usageKinds.map((kind) => ({
          kind,
          // **Only AI processing arrives already spent.** The other two are
          // things an active worker does, and an account with no active worker
          // has not done them — so there is nothing to carry and a number here
          // would be invented. See `readPreTrialAiProcessing`.
          used: kind === CARRIED_KIND ? carriedIn : 0,
          limit: planLimitFor(TRIAL_PLAN, kind),
        })),
      },
    },
  });

  return { outcome: "started", startedAt, endsAt };
}
