import type { EffectiveEntitlement } from "@/lib/entitlements/types";
import type { EmailEntitlement } from "@/lib/plans";
import type { RunNotificationKind } from "@/lib/notify/run-notification";

/**
 * Which of an account's workers its plan lets email it.
 *
 * **An account the plan does not currently cover sends nothing.** An ended
 * trial, an expired plan or no plan at all is `none`, whatever the plan row
 * would allow if it were live.
 */
export function emailEntitlementOf(entitlement: EffectiveEntitlement): EmailEntitlement {
  return entitlement.entitled && entitlement.limits !== null
    ? entitlement.limits.email
    : "none";
}

/**
 * Whether the plan lets this one worker email its owner.
 *
 * **One worker means the chosen one, and only it.** `notificationWorkerId` is
 * the account's own choice; null is "nobody chosen yet", never "anybody".
 */
export function entitlementAllowsEmail(
  entitlement: EffectiveEntitlement,
  routineId: string,
): boolean {
  switch (emailEntitlementOf(entitlement)) {
    case "all-workers":
      return true;
    case "one-worker":
      return entitlement.notificationWorkerId === routineId;
    default:
      return false;
  }
}

/**
 * The one rule every worker email passes through, whatever the worker does.
 *
 * Three independent questions, kept apart: whether the run produced anything
 * to tell (decided by the run), whether the owner asked to be told (the
 * worker's own switch), and whether the plan allows this worker to tell them.
 */
export function shouldSendRunEmail(input: {
  readonly notification: RunNotificationKind | null;
  readonly emailNotificationsEnabled: boolean;
  readonly entitlementAllows: boolean;
}): boolean {
  return (
    input.notification !== null &&
    input.emailNotificationsEnabled &&
    input.entitlementAllows
  );
}
