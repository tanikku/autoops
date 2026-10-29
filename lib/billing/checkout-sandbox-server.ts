import "server-only";

import {
  isSandboxCheckoutAllowed,
  parseSandboxCheckoutUserIds,
} from "@/lib/billing/checkout-sandbox";

/**
 * Where the sandbox rollout list is read, and when.
 *
 * **Server-only, because the list is the gate.** An account id in a browser
 * bundle would tell everybody who is allowed to buy, and a gate whose input
 * shipped to the client would be a gate anybody could read around. The decision
 * is made here and only a boolean leaves.
 *
 * **Read on use, never on import.** `auth.ts` reads its allowlist once at module
 * load, which is right for a list that changes when somebody is invited; this one
 * is a temporary switch on a payment path, and the thing that matters about it is
 * being able to *close* it. Reading per call means unsetting the variable takes
 * effect on the next request rather than on the next restart.
 */

/** The variable's name, stated once so nothing has to guess at it. */
export const SANDBOX_CHECKOUT_USER_IDS_ENV = "CHECKOUT_SANDBOX_USER_IDS";

/**
 * Whether this account may start a checkout yet.
 *
 * Takes the environment rather than reaching for it — the same shape as
 * `readStripeRuntime` — so a test can describe a deployment without setting
 * anything globally.
 *
 * @param userId the account id from the session, never from a request payload
 */
export function isSandboxCheckoutEnabledForUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSandboxCheckoutAllowed(
    userId,
    parseSandboxCheckoutUserIds(env[SANDBOX_CHECKOUT_USER_IDS_ENV]),
  );
}

/**
 * The second list: admin-granted beta accounts that may buy anyway.
 *
 * **An exception to a refusal, not a rollout.** The Closed Beta allowance is
 * never offered a purchase; this names the accounts an operator has decided to
 * take through a paid checkout regardless — one, for a live end-to-end check.
 * Unset, empty or nothing but separators, it names nobody, exactly like the
 * rollout list.
 */
export const BETA_PURCHASE_USER_IDS_ENV = "CHECKOUT_BETA_PURCHASE_USER_IDS";

/**
 * Whether this admin-granted beta account may buy despite being one.
 *
 * **Both lists, every time.** Being named here is not enough on its own: the
 * account must also be inside the checkout rollout, so this can never open the
 * purchase path to anybody the rollout keeps out. Read per call, for the same
 * reason as the rollout list — so emptying it closes the exception on the next
 * request.
 *
 * Which plan the exception covers is the caller's to enforce; see
 * `startCheckout`, which allows it for Lite and nothing else.
 *
 * @param userId the account id from the session, never from a request payload
 */
export function isBetaPurchaseEnabledForUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isSandboxCheckoutAllowed(
      userId,
      parseSandboxCheckoutUserIds(env[SANDBOX_CHECKOUT_USER_IDS_ENV]),
    ) &&
    isSandboxCheckoutAllowed(userId, parseSandboxCheckoutUserIds(env[BETA_PURCHASE_USER_IDS_ENV]))
  );
}
