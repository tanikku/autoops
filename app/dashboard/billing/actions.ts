"use server";

import {
  type CheckoutAttemptPlan,
  isCheckoutAttemptPlan,
} from "@/lib/billing/checkout-attempt";
import { type StartCheckoutResult, startCheckout } from "@/lib/billing/checkout";
import { isSandboxCheckoutEnabledForUser } from "@/lib/billing/checkout-sandbox-server";
import { createStripeCheckoutProvider } from "@/lib/billing/providers/stripe-checkout";
import {
  isUserProvisioningError,
  requireProvisionedUserId,
  requireUserId,
} from "@/lib/session";

/**
 * The doorway between a page and starting a subscription.
 *
 * **Thin on purpose, and the thinness is the safety.** Who may buy, how many
 * workers a plan allows, whether the provider already has a subscription, which
 * coordination slot is held, what a retry asks for — none of that is decided
 * here. It all lives in `lib/billing/checkout.ts`, where it can be tested
 * without a request and where there is exactly one copy of it. What this file
 * adds is the two things only a request can supply: **who is asking**, and
 * **whether what they sent is something they are allowed to send**.
 *
 * **Two values arrive from the browser and nothing else does.** Not an account
 * id, not a price, not a customer, not a return address, not a currency. Each of
 * those would be a way to make this act for somebody else or charge something
 * other than what was shown — so none of them is a parameter, and no amount of
 * a caller's ingenuity can add one.
 *
 * **Nothing is navigated from here.** The outcome comes back as a value and the
 * page decides what to do with it: an over-limit needs a sentence and a
 * confirmation before anybody goes anywhere, and an action that redirected would
 * have nowhere to put that. It also means every branch below is a return value a
 * test can read.
 *
 * **One thing is decided here that the orchestration must not know about.**
 * While the checkout is being proved against a sandbox, only the account doing
 * the proving may reach it — see `lib/billing/checkout-sandbox-server.ts`. That
 * is a rollout switch rather than a rule about subscriptions, so it is asked
 * before the orchestration rather than inside it, and it will leave with the
 * rollout. A page with a disabled button is not what enforces it: a server
 * action is callable by anybody signed in, so the refusal has to live on this
 * side of the request.
 */

/** Everything a caller may send. */
export type StartCheckoutActionInput = {
  readonly plan: CheckoutAttemptPlan;
  /** True only when the over-limit explanation was shown and agreed to. */
  readonly overLimitAcknowledged?: boolean;
};

/**
 * What the page gets back.
 *
 * **The outcomes are the orchestration's own**, minus what a browser has no use
 * for. `checkout-ready` carries the address to send somebody to and not the
 * provider's identifier for it: the page navigates, it does not reconcile, and
 * an id in a client payload is an id in a browser history.
 *
 * **`invalid-request` is this file's alone.** It means the values that arrived
 * were not values this action accepts, which the orchestration never sees
 * because nothing gets that far.
 */
export type StartCheckoutActionResult =
  | {
      readonly outcome: "checkout-ready";
      readonly url: string;
      readonly standing: "below-limit" | "at-limit" | "over-limit";
    }
  | {
      readonly outcome: "over-limit-confirmation-required";
      readonly activeWorkers: number;
      readonly activeWorkerLimit: number;
    }
  | {
      readonly outcome: "plan-switch-required";
      readonly currentPlan: CheckoutAttemptPlan;
    }
  | {
      readonly outcome: "billing-management-required";
      readonly reason:
        | "already-subscribed"
        | "payment-behind"
        | "cancelling"
        | "provider-subscription-live";
    }
  | { readonly outcome: "payment-processing" }
  | { readonly outcome: "provider-verification-unavailable" }
  /** Not configured, not reachable, or something this version cannot read. */
  | { readonly outcome: "unavailable" }
  /** The request itself was not one this action accepts. */
  | { readonly outcome: "invalid-request" };

/**
 * Turns an orchestration outcome into one a browser may hold.
 *
 * **What is dropped is dropped for a reason, not for tidiness.** The attempt id
 * and the provider's session id are how this system talks to itself about a
 * purchase in progress; a page needs neither, and neither belongs in a payload
 * that travels to a browser and stays in its history. The reasons behind
 * `unavailable` and `malformed-config` are likewise the deployment's business —
 * a missing secret key is not something to explain to whoever clicked Buy, and
 * naming it would describe the configuration to anybody who asked.
 */
function toActionResult(
  result: StartCheckoutResult,
): StartCheckoutActionResult {
  switch (result.outcome) {
    case "checkout-ready":
      // **No url is the same answer as no session.** The provider gives one for
      // a session somebody can be sent to; without it there is nowhere to go,
      // and reporting success would be reporting a page that does not exist.
      return result.url === null
        ? { outcome: "unavailable" }
        : {
            outcome: "checkout-ready",
            url: result.url,
            standing: result.standing,
          };

    case "over-limit-confirmation-required":
      return {
        outcome: "over-limit-confirmation-required",
        activeWorkers: result.activeWorkers,
        activeWorkerLimit: result.activeWorkerLimit,
      };

    case "plan-switch-required":
      return {
        outcome: "plan-switch-required",
        currentPlan: result.currentPlan,
      };

    case "billing-management-required":
      return {
        outcome: "billing-management-required",
        reason: result.reason,
      };

    case "payment-processing":
      return { outcome: "payment-processing" };

    case "provider-verification-unavailable":
      return { outcome: "provider-verification-unavailable" };

    default:
      // `unavailable` and `malformed-config` both mean the same thing to a
      // browser: not now, and not because of anything you did.
      return { outcome: "unavailable" };
  }
}

/**
 * Starts a checkout for whoever is signed in.
 *
 * **The account comes from the session and the row is provisioned here.** A
 * checkout writes a `CheckoutAttempt` that carries a foreign key to `User`, so
 * the row has to exist first — which is what `requireProvisionedUserId` is for,
 * and which is only reached once the request has been found acceptable.
 *
 * **A rejected request provisions nothing.** Validation comes first, so
 * somebody probing this with a plan that does not exist does not cause a write.
 */
export async function startCheckoutAction(
  input: StartCheckoutActionInput,
): Promise<StartCheckoutActionResult> {
  // **Narrowed rather than trusted.** The type says which plans exist; a request
  // is not bound by a type, and `trial` and `beta` are plans an account can be
  // on that nobody may buy.
  if (!isCheckoutAttemptPlan(input.plan)) {
    return { outcome: "invalid-request" };
  }

  // **Only an actual `true` acknowledges anything.** A string, a `1`, or an
  // object would otherwise be truthy, and this is the flag that stands between
  // somebody and a plan that allows fewer workers than they are running.
  const acknowledged = input.overLimitAcknowledged;

  if (acknowledged !== undefined && typeof acknowledged !== "boolean") {
    return { outcome: "invalid-request" };
  }

  // **Authenticated before provisioned, so a refusal writes nothing.**
  // `requireUserId` reads the session and nothing else; the account row is only
  // worth creating once the request is going ahead, and somebody outside the
  // rollout is not going ahead. A redirect from here travels as a thrown error
  // and is left to travel.
  const authenticatedUserId = await requireUserId();

  if (!isSandboxCheckoutEnabledForUser(authenticatedUserId)) {
    // **The same answer as a deployment that cannot sell anything**, because
    // that is what this is: the purchase path is not open to this account yet.
    // Saying so in its own outcome would describe the rollout to whoever asked,
    // and nothing a caller can do with the distinction is worth telling them.
    return { outcome: "unavailable" };
  }

  let userId: string;

  try {
    userId = await requireProvisionedUserId();
  } catch (error) {
    // **A redirect travels as a thrown error too**, so a visitor with no session
    // has to be allowed to leave rather than be turned into an outcome — which
    // would show them a message on a page they are not signed in to. Only the
    // provisioning failure is answered here, and it is answered the same way
    // every other deployment problem is.
    if (!isUserProvisioningError(error)) {
      throw error;
    }

    console.error("[checkout] could not provision the account row", error);

    return { outcome: "unavailable" };
  }

  // **The account that passed the gate must be the account that buys.** Both
  // helpers read `session.user.id` from the same request, so these agree unless
  // something between them changed — and a checkout for an account that was
  // never authorised is the one outcome that must not be possible. Refusing
  // costs a comparison.
  if (userId !== authenticatedUserId) {
    console.error("[checkout] the session changed mid-request; refused");

    return { outcome: "unavailable" };
  }

  // **Built here, from the server's own environment.** A provider a caller could
  // name would be a caller choosing which service gets told about the payment.
  const provider = createStripeCheckoutProvider();

  try {
    const result = await startCheckout({
      userId,
      plan: input.plan,
      overLimitAcknowledged: acknowledged === true,
      provider,
    });

    return toActionResult(result);
  } catch (error) {
    // **The category, never the cause.** A provider's own error text quotes keys
    // and customer identifiers, and a `CheckoutSessionConflict` — one attempt
    // holding two sessions — is a safety failure rather than something a person
    // did. Both are worth reading in a log and neither is worth describing to a
    // browser, so the log gets the name and the caller gets "not now".
    console.error(
      "[checkout] could not start a checkout —",
      error instanceof Error ? error.name : "an unexpected failure",
    );

    return { outcome: "unavailable" };
  }
}
