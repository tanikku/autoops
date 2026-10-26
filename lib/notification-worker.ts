import "server-only";

import { computeEntitlement, getEffectiveEntitlement } from "@/lib/entitlements/index";
import { InvalidSubscriptionError } from "@/lib/entitlements/states";
import { UnknownPlanError } from "@/lib/plans";
import { emailEntitlementOf } from "@/lib/notify/email-entitlement";
import type { EmailEntitlement } from "@/lib/plans";
import { type DbClient, prisma } from "@/lib/prisma";

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
 * locked saves**: a hire, an edit in which the owner moved the switch, a
 * switch, a delete. An edit that leaves the switch as the form showed it does
 * not write the switch at all (see the edit action), so a form opened before
 * another save changed this worker cannot put its switch back behind the
 * lock's back.
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

/** What repairing an account's choice came to. Categories only. */
export type NotificationWorkerRepair =
  /** Exactly one worker had its email on and nobody was chosen; it is now. */
  | "selected"
  /** Nobody chosen, and two or more workers have email on: the owner chooses. */
  | "ambiguous"
  /** Nobody chosen, and no worker has email on: nothing to choose. */
  | "none-enabled"
  /** Somebody is chosen already. Never replaced here. */
  | "already-selected"
  /** The plan lets every worker email, or none: there is no choice to make. */
  | "not-one-worker";

/**
 * Gives a one-worker plan its chosen worker when there is only one it could be.
 *
 * **Why this exists.** Every plan but Lite lets all workers email, so an owner
 * on a trial switches email on wherever they like and nothing is chosen —
 * there is nothing to choose. Buying Lite then leaves `notificationWorkerId`
 * null, which a one-worker plan reads as "nobody", and every email stops while
 * the switches still look on.
 *
 * **The one exception to choosing nothing behind anybody's back.** With exactly
 * one worker switched on there is no choice to make on the owner's behalf: it
 * is the only answer. With two or more nothing is chosen — the owner is asked
 * instead — and a choice already made is never replaced, which the condition
 * on the write enforces rather than a check beforehand.
 *
 * **Under the account's lock, like every save of a worker's switch**, so the
 * workers counted are the ones that exist when the choice is written: a worker
 * deleted, or a second one switched on, by a save that finished first is seen.
 * Its own transaction: this runs after a reconciliation has committed, and a
 * failure here must never undo an entitlement that was paid for.
 */
export async function repairNotificationWorkerSelection(
  client: DbClient,
  userId: string,
  now: Date = new Date(),
): Promise<NotificationWorkerRepair> {
  const run = async (tx: DbClient): Promise<NotificationWorkerRepair> => {
    await lockAccountForEmailSelection(tx, userId);

    const record = await tx.subscription.findUnique({
      where: { userId },
      select: SUBSCRIPTION_FIELDS,
    });

    if (record === null) {
      return "not-one-worker";
    }

    let oneWorker: boolean;
    try {
      oneWorker = emailEntitlementOf(computeEntitlement(record, now)) === "one-worker";
    } catch (error) {
      // A plan this version cannot read is not one to choose a worker for.
      if (error instanceof InvalidSubscriptionError || error instanceof UnknownPlanError) {
        return "not-one-worker";
      }

      throw error;
    }

    if (!oneWorker) {
      return "not-one-worker";
    }

    if (record.notificationWorkerId !== null) {
      return "already-selected";
    }

    // Two are enough to know it is not one.
    const enabled = await tx.routine.findMany({
      where: { userId, emailNotificationsEnabled: true },
      orderBy: { id: "asc" },
      take: 2,
      select: { id: true },
    });

    if (enabled.length === 0) {
      return "none-enabled";
    }

    if (enabled.length > 1) {
      return "ambiguous";
    }

    const { count } = await tx.subscription.updateMany({
      where: { userId, notificationWorkerId: null },
      data: { notificationWorkerId: enabled[0].id },
    });

    return count === 1 ? "selected" : "already-selected";
  };

  return "$transaction" in client && typeof client.$transaction === "function"
    ? await (client as typeof prisma).$transaction(run)
    : await run(client);
}

/** Which workers the plan lets email, and which one is chosen. For pages. */
export type EmailSelection = {
  readonly entitlement: EmailEntitlement;
  readonly notificationWorkerId: string | null;
};

/**
 * What a page needs to show a worker's email switch as it actually behaves.
 *
 * **Undefined when it cannot be read**, like `readEmailEntitlement`.
 */
export async function readEmailSelection(userId: string): Promise<EmailSelection | undefined> {
  try {
    const entitlement = await getEffectiveEntitlement(userId);

    return {
      entitlement: emailEntitlementOf(entitlement),
      notificationWorkerId: entitlement.notificationWorkerId,
    };
  } catch (error) {
    console.error("[worker] email selection could not be read for the page", error);
    return undefined;
  }
}

/**
 * Whether the owner has to choose which worker emails them.
 *
 * True only on a one-worker plan with nobody chosen and two or more workers
 * switched on — the one state no repair resolves, because choosing would be
 * deciding for them. False when it cannot be read: the page says nothing rather
 * than the wrong thing.
 */
export async function readEmailSelectionNeeded(
  userId: string,
  client: DbClient = prisma,
): Promise<boolean> {
  const selection = await readEmailSelection(userId);

  if (selection?.entitlement !== "one-worker" || selection.notificationWorkerId !== null) {
    return false;
  }

  try {
    const enabled = await client.routine.count({
      where: { userId, emailNotificationsEnabled: true },
    });

    return enabled >= 2;
  } catch (error) {
    console.error("[worker] email selection could not be counted for the page", error);
    return false;
  }
}
