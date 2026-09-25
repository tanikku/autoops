import "server-only";

import { planLimitFor } from "@/lib/usage/period";
import { usageKinds } from "@/lib/usage/types";
import type { DbClient } from "@/lib/prisma";

/**
 * The writes a billing transition is made of.
 *
 * **Extracted rather than rewritten.** Every rule here was worked out, argued
 * over and tested somewhere else first — a granted beta's expiry has to be
 * cleared or the paid plan expires with it, an upgrade must not un-spend what
 * was used getting to it, a period that already exists must be read rather than
 * reset. Two callers now need those rules: the event-ordering layer that came
 * first, and reconciliation. Copying them would have given the second caller a
 * copy that drifts.
 *
 * **They take what they need, not an event.** The old signatures asked for a
 * provider event, which meant every caller had to have one — and reconciliation
 * does not: it looks at the provider's current state, and there is no single
 * delivery behind what it finds. Passing plain values also removes the trap
 * that came with the old shape, where a `changePlan` handed a subscription read
 * before a renewal would raise the limits of the period the renewal had just
 * closed.
 *
 * **Nothing here decides anything.** Which of these to call, in what order and
 * whether at all, is the caller's. These only carry it out.
 */

/** A provider's billing cycle, once both ends are known. */
export type PaidPeriod = {
  readonly start: Date;
  readonly end: Date;
};

/** The stored entitlement, as these writes need to see it. */
export const SUBSCRIPTION_FIELDS = {
  plan: true,
  state: true,
  source: true,
  expiresAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  trialForfeitedAt: true,
  providerCustomerId: true,
  providerSubscriptionId: true,
  providerUpdatedAt: true,
  providerSyncedAt: true,
} as const;

export type StoredSubscription = {
  plan: string;
  state: string;
  source: string;
  expiresAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialForfeitedAt: Date | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  providerUpdatedAt: Date | null;
  providerSyncedAt: Date | null;
};

/**
 * The columns that record where a write came from.
 *
 * **Two callers, two different answers, and neither may write the other's.**
 * The event layer stamps `providerUpdatedAt` with the provider's own timestamp,
 * which is what it judges order by. Reconciliation does not judge order by any
 * timestamp and has no provider instant to record, so it passes nothing here
 * and sets `providerSyncedAt` once, at the end, for the whole run. Leaving this
 * to each write would mean deciding it four times.
 */
export type ProvenanceStamp = {
  readonly providerUpdatedAt?: Date;
};

/** Reads the entitlement these writes operate on, or null when there is none. */
export async function readStoredSubscription(
  tx: DbClient,
  userId: string,
): Promise<StoredSubscription | null> {
  return tx.subscription.findUnique({
    where: { userId },
    select: SUBSCRIPTION_FIELDS,
  });
}

/**
 * A paid entitlement now exists.
 *
 * **`expiresAt` is cleared, and that line is load-bearing.** A granted beta row
 * carries an expiry, and entitlement resolution reads it before anything else —
 * so a beta account that bought a plan and kept its old expiry would have its
 * paid subscription resolve as expired on the last day of the year, for a
 * reason nobody looking at the paid plan would think to check.
 *
 * **The trial's own columns are never touched.** What an account did with its
 * trial is a fact about the past; buying something does not change it.
 *
 * **`trialForfeitedAt` is set only if it is empty.** A beta account already
 * carries the moment its offer went away, and overwriting it with today would
 * replace a true statement with a later one. An account that never had a trial
 * gets `forfeitTrialAt` — which is what closes the hole where somebody could
 * buy a plan, cancel it, and be offered a trial they were never owed.
 */
export async function activatePaidSubscription(
  tx: DbClient,
  input: {
    userId: string;
    plan: string;
    period: PaidPeriod;
    source: string;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    forfeitTrialAt: Date;
    existing: StoredSubscription | null;
    stamp?: ProvenanceStamp;
  },
): Promise<void> {
  const paid = {
    plan: input.plan,
    state: "active",
    source: input.source,
    currentPeriodStart: input.period.start,
    currentPeriodEnd: input.period.end,
    // See above: a grant's expiry must not outlive the grant.
    expiresAt: null,
    providerCustomerId: input.providerCustomerId,
    providerSubscriptionId: input.providerSubscriptionId,
    ...(input.stamp ?? {}),
  };

  if (input.existing === null) {
    await tx.subscription.create({
      data: {
        userId: input.userId,
        ...paid,
        // Nothing about a trial, because there was none — except that there
        // will not be one now either.
        trialForfeitedAt: input.forfeitTrialAt,
      },
    });
  } else {
    await tx.subscription.update({
      where: { userId: input.userId },
      data: {
        ...paid,
        ...(input.existing.trialForfeitedAt === null
          ? { trialForfeitedAt: input.forfeitTrialAt }
          : {}),
      },
    });
  }

  await openPaidPeriod(tx, input.userId, input.plan, input.period);
}

/**
 * The same subscription continues into a new provider period.
 *
 * **The new period is opened under the plan the caller names, not the stored
 * one.** A provider can advance the cycle and change the plan in one move, and
 * the window that opens then really does run under the new plan — recording the
 * old one in `planAtStart` would make a question about a charge unanswerable.
 * The caller passes whatever the provider says applies to this period.
 *
 * **`Subscription.plan` is left alone.** Moving it is a separate fact with its
 * own audit row; doing it here would hide a plan change inside a renewal.
 */
export async function renewPaidSubscription(
  tx: DbClient,
  input: {
    userId: string;
    plan: string;
    period: PaidPeriod;
    providerCustomerId?: string | null;
    providerSubscriptionId?: string | null;
    stamp?: ProvenanceStamp;
  },
): Promise<void> {
  await tx.subscription.update({
    where: { userId: input.userId },
    data: {
      state: "active",
      currentPeriodStart: input.period.start,
      currentPeriodEnd: input.period.end,
      ...(input.providerCustomerId == null
        ? {}
        : { providerCustomerId: input.providerCustomerId }),
      ...(input.providerSubscriptionId == null
        ? {}
        : { providerSubscriptionId: input.providerSubscriptionId }),
      ...(input.stamp ?? {}),
    },
  });

  await openPaidPeriod(tx, input.userId, input.plan, input.period);
}

/**
 * The plan moves, and the period it moves in gets more room.
 *
 * **`periodStart` is passed rather than read.** The period whose limits should
 * rise is the one in force *now* — and when a renewal has already run in the
 * same transaction, that is the period the renewal opened, not the one a
 * subscription read before it would name. Taking it as an argument is what
 * stops an upgrade raising the ceiling of a month that is already over.
 *
 * **`planAtStart` is not rewritten.** The period did open on whatever plan it
 * opened on, and that stays true; what changes is the ceiling, which is what
 * the counters' `limit` records.
 *
 * **The state is not touched.** An account in grace that upgrades is still an
 * account whose payment is in question.
 */
export async function changeSubscriptionPlan(
  tx: DbClient,
  input: {
    userId: string;
    plan: string;
    periodStart: Date | null;
    stamp?: ProvenanceStamp;
  },
): Promise<void> {
  await tx.subscription.update({
    where: { userId: input.userId },
    data: { plan: input.plan, ...(input.stamp ?? {}) },
  });

  await raiseCounterLimits(tx, input.userId, input.periodStart, input.plan);
}

/** A state change that touches nothing else. */
export async function setSubscriptionState(
  tx: DbClient,
  input: {
    userId: string;
    state: "active" | "grace" | "canceled_active" | "inactive";
    stamp?: ProvenanceStamp;
  },
): Promise<void> {
  await tx.subscription.update({
    where: { userId: input.userId },
    // **The plan, the period, the provider ids, the trial columns and every
    // counter are left exactly as they are.** What changed is whether the
    // entitlement is in force, and nothing about what it was.
    data: { state: input.state, ...(input.stamp ?? {}) },
  });
}

/**
 * Opens the period a paid plan is measured over, or uses the one already there.
 *
 * **A period that exists is read, never reset.** A redelivered activation or a
 * renewal that raced with itself must not zero counters somebody has spent
 * against, so the existing row is used as it stands.
 *
 * **An existing row that disagrees is an error rather than a correction.** If
 * the same start carries a different end or a different opening plan, something
 * has written a period this caller did not describe — and rewriting it would
 * destroy the record rather than repair it.
 *
 * **Trial and beta periods are untouched.** A paid period has its own start, so
 * it is its own row; nothing here reads or changes what came before.
 */
export async function openPaidPeriod(
  tx: DbClient,
  userId: string,
  plan: string,
  period: PaidPeriod,
): Promise<void> {
  const existing = await tx.usagePeriod.findUnique({
    where: { userId_periodStart: { userId, periodStart: period.start } },
    select: { periodEnd: true, planAtStart: true },
  });

  if (existing !== null) {
    const sameEnd = existing.periodEnd.getTime() === period.end.getTime();

    if (!sameEnd || existing.planAtStart !== plan) {
      throw new Error(
        "A usage period already exists for that start and describes something else",
      );
    }

    return;
  }

  try {
    await tx.usagePeriod.create({
      data: {
        userId,
        periodStart: period.start,
        periodEnd: period.end,
        planAtStart: plan,
        // Stamped with the period's own start, so `partialPeriod` does not
        // report a window it covers entirely as covering part of one.
        createdAt: period.start,
        counters: {
          // Three, one per allowance. How many workers are active is live
          // state that goes up and down; a period does not accumulate them.
          create: usageKinds.map((kind) => ({
            kind,
            // **A paid period starts empty.** What a trial or a grant used
            // belongs to the window it was used in; carrying it forward would
            // spend part of a month somebody has paid for on a month they had
            // not.
            used: 0,
            limit: planLimitFor(plan, kind),
          })),
        },
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    // Two writers reached the create together. The constraint refused the
    // second, which wanted the period rather than the creating of it — and
    // whatever the first wrote is what both of them meant.
  }
}

/**
 * Raises what a period allows, without touching what it has spent.
 *
 * **`used` is never written here.** An upgrade gives somebody more room; it
 * does not un-spend what they used getting to it.
 *
 * **Only the counters that exist are raised.** A period is opened with all
 * three at once, so a missing one means something else wrote the period —
 * reported by leaving it alone rather than repaired by inventing a row whose
 * limit nobody decided on.
 */
export async function raiseCounterLimits(
  tx: DbClient,
  userId: string,
  periodStart: Date | null,
  plan: string,
): Promise<void> {
  if (periodStart === null) {
    return;
  }

  const period = await tx.usagePeriod.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
    select: { id: true },
  });

  if (period === null) {
    return;
  }

  for (const kind of usageKinds) {
    await tx.usageCounter.updateMany({
      where: { periodId: period.id, kind },
      data: { limit: planLimitFor(plan, kind) },
    });
  }
}

/** Whether an error is PostgreSQL refusing a second row under a unique index. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
