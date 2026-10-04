import "server-only";

import { computeEntitlement, getEffectiveEntitlement } from "@/lib/entitlements/index";
import { InvalidSubscriptionError } from "@/lib/entitlements/states";
import { UnknownPlanError } from "@/lib/plans";
import { emailEntitlementOf } from "@/lib/notify/email-entitlement";
import type { EmailEntitlement } from "@/lib/plans";
import type { DbClient } from "@/lib/prisma";

/**
 * Which worker emails its owner, on a plan that allows one.
 *
 * **Decided where the worker is saved, inside the same transaction and behind
 * the same account lock as the save.** Two saves for one account therefore
 * happen one after the other, and the second sees what the first chose — so
 * there is never a moment with two chosen workers, or a chosen worker with its
 * email switched off.
 *
 * **That holds because every write of a worker's email switch is one of these
 * locked saves**: a hire, an edit that involves email, a switch, a delete. An
 * edit that leaves an off switch off does not write the switch at all (see
 * the edit action), so a form opened before another save chose this worker
 * cannot put its switch back off behind the lock's back.
 *
 * **Nothing here is chosen behind anybody's back.** The first worker switched
 * on becomes the chosen one when nobody is; moving the choice to another worker
 * needs the owner to say so; switching the chosen worker off, or deleting it,
 * leaves nobody chosen rather than picking a replacement.
 */

/** What the save should do about the account's choice, once the worker exists. */
export type EmailSelectionPlan =
  /** The plan lets every worker email, or none: the switch is saved as given. */
  | { readonly kind: "unrestricted" }
  /** This worker becomes, or stays, the chosen one; `previous` is switched off. */
  | { readonly kind: "select"; readonly previous: string | null }
  /** This worker was the chosen one and is being switched off. */
  | { readonly kind: "clear" }
  /** Nothing about the choice changes. */
  | { readonly kind: "keep" };

export type EmailSelectionDecision =
  | { readonly allowed: true; readonly plan: EmailSelectionPlan }
  /** Another worker is chosen, and the owner has not asked to switch. */
  | { readonly allowed: false; readonly currentWorkerName: string };

const SUBSCRIPTION_FIELDS = {
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

/**
 * The same row lock the worker quota takes, so saves and deletes for one
 * account queue. Taken before any worker row is touched, in every path, so the
 * order is the same everywhere.
 */
export async function lockAccountForEmailSelection(
  client: DbClient,
  userId: string,
): Promise<void> {
  await client.user.update({ where: { id: userId }, data: { id: userId } });
}

/**
 * Decides what saving this worker's email switch means for the account.
 *
 * `routineId` is null while the worker is still being created. A chosen worker
 * counts only when it still exists, belongs to this account and has its email
 * switched on; anything else is treated as nobody chosen, which is what a
 * deleted worker or a choice left over from another plan amounts to.
 */
export async function planEmailSelection(
  client: DbClient,
  input: {
    readonly userId: string;
    readonly routineId: string | null;
    readonly emailEnabled: boolean;
    readonly confirmSwitch: boolean;
    readonly now?: Date;
  },
): Promise<EmailSelectionDecision> {
  await lockAccountForEmailSelection(client, input.userId);

  const record = await client.subscription.findUnique({
    where: { userId: input.userId },
    select: SUBSCRIPTION_FIELDS,
  });

  let oneWorker: boolean;
  try {
    oneWorker =
      emailEntitlementOf(computeEntitlement(record, input.now ?? new Date())) ===
      "one-worker";
  } catch (error) {
    // **An unreadable plan does not stop a save.** Whether anything is sent is
    // decided again when there is something to send, and that check refuses
    // what it cannot read.
    if (error instanceof InvalidSubscriptionError || error instanceof UnknownPlanError) {
      return { allowed: true, plan: { kind: "unrestricted" } };
    }

    throw error;
  }

  if (!oneWorker || record === null) {
    return { allowed: true, plan: { kind: "unrestricted" } };
  }

  const chosen = record.notificationWorkerId;
  const isThisWorker = chosen !== null && chosen === input.routineId;

  if (!input.emailEnabled) {
    return { allowed: true, plan: isThisWorker ? { kind: "clear" } : { kind: "keep" } };
  }

  if (isThisWorker) {
    return { allowed: true, plan: { kind: "keep" } };
  }

  const current =
    chosen === null
      ? null
      : await client.routine.findFirst({
          where: { id: chosen, userId: input.userId, emailNotificationsEnabled: true },
          select: { id: true, name: true },
        });

  if (current !== null && !input.confirmSwitch) {
    return { allowed: false, currentWorkerName: current.name };
  }

  return { allowed: true, plan: { kind: "select", previous: current?.id ?? null } };
}

/**
 * Carries out a decided plan, in the same transaction as the save it belongs
 * to and after the worker exists.
 */
export async function applyEmailSelection(
  client: DbClient,
  input: {
    readonly userId: string;
    readonly routineId: string;
    readonly plan: EmailSelectionPlan;
  },
): Promise<void> {
  const { userId, routineId, plan } = input;

  if (plan.kind === "select") {
    if (plan.previous !== null) {
      await client.routine.updateMany({
        where: { id: plan.previous, userId },
        data: { emailNotificationsEnabled: false },
      });
    }

    await client.subscription.update({
      where: { userId },
      data: { notificationWorkerId: routineId },
    });
    return;
  }

  if (plan.kind === "clear") {
    await client.subscription.updateMany({
      where: { userId, notificationWorkerId: routineId },
      data: { notificationWorkerId: null },
    });
  }
}

/**
 * Forgets the choice when the chosen worker is deleted, in the delete's own
 * transaction and after `lockAccountForEmailSelection`. Nothing else is chosen
 * in its place, and a worker that was not the chosen one changes nothing.
 */
export async function releaseEmailSelection(
  client: DbClient,
  input: { readonly userId: string; readonly routineId: string },
): Promise<void> {
  await client.subscription.updateMany({
    where: { userId: input.userId, notificationWorkerId: input.routineId },
    data: { notificationWorkerId: null },
  });
}

/**
 * Which workers the account's plan lets email, for a form to explain.
 *
 * **Undefined when it cannot be read**, so the form says nothing rather than
 * the wrong thing; the save and the send each check for themselves.
 */
export async function readEmailEntitlement(
  userId: string,
): Promise<EmailEntitlement | undefined> {
  try {
    return emailEntitlementOf(await getEffectiveEntitlement(userId));
  } catch (error) {
    console.error("[worker] email entitlement could not be read for the form", error);
    return undefined;
  }
}
