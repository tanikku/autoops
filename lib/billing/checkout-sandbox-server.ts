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
