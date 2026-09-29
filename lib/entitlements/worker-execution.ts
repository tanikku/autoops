import "server-only";

import { getEffectiveEntitlement } from "@/lib/entitlements/index";
import { InvalidSubscriptionError } from "@/lib/entitlements/states";
import { UnknownPlanError } from "@/lib/plans";

/**
 * Whether an account may run a worker at this instant.
 *
 * **The rule is `entitled`, and nothing else.** `computeEntitlement` already
 * knows every state and every clock — a trial that has run out, a grant past its
 * expiry, a cancellation past the end of the period it was paid for — and what
 * it answers in `entitled` is exactly the question asked here. Reading a plan
 * name, a limit, or a state string instead would be a second opinion about the
 * same row, and the two would drift the day one of them changed.
 *
 * **An account with no row is refused.** It has not started a trial, and a
 * trial starts on the first successful worker activation — so running a worker
 * without one would be a way round the only door into it.
 *
 * **A row this version cannot read is refused too.** It was written by a
 * version that knew more; guessing would either run work nobody is entitled to
 * or refuse work somebody paid for, and only the first of those can be undone
 * by a later run.
 *
 * **Only the answer leaves.** No plan, no date, no identifier: whoever catches
 * the refusal decides what a person is told.
 *
 * **Worker execution only.** Creator and draft generation have rules of their
 * own and do not ask this.
 */

/** Thrown when a worker may not run because of the account's entitlement. */
export class ExecutionEntitlementBlockedError extends Error {
  constructor() {
    super("Worker execution is not available for the current entitlement.");
    this.name = "ExecutionEntitlementBlockedError";
  }
}

/** Whether a rejection means "not entitled to run" rather than "went wrong". */
export function isExecutionEntitlementBlocked(error: unknown): boolean {
  return error instanceof ExecutionEntitlementBlockedError;
}

/**
 * Refuses unless the account is entitled to run a worker now.
 *
 * **Only an unreadable row becomes a refusal.** A database that could not be
 * reached is not an answer about anybody's entitlement, so it travels on as the
 * ordinary failure it is.
 */
export async function requireWorkerExecutionEntitlement(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  let entitled: boolean;

  try {
    entitled = (await getEffectiveEntitlement(userId, now)).entitled;
  } catch (error) {
    if (
      error instanceof InvalidSubscriptionError ||
      error instanceof UnknownPlanError
    ) {
      throw new ExecutionEntitlementBlockedError();
    }

    throw error;
  }

  if (!entitled) {
    throw new ExecutionEntitlementBlockedError();
  }
}
