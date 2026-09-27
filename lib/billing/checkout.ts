import "server-only";

import {
  type CheckoutAttempt,
  type CheckoutAttemptPlan,
  beginCheckoutAttempt,
  closeCheckoutAttempt,
  markCheckoutAttemptOpen,
} from "@/lib/billing/checkout-attempt";
import { computeEntitlement } from "@/lib/entitlements/index";
import { getPlanDefinition } from "@/lib/plans";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Starting a subscription, and every reason not to.
 *
 * **Three questions in order, and the provider is asked last.** May this
 * account buy at all; does it understand what this plan allows; is it already
 * partway through buying something. Each is answered from Koqentra's own rows,
 * and only once all three are settled is a provider called — so a refusal costs
 * no network call and, in most cases, no write either.
 *
 * **It writes to one table.** `CheckoutAttempt`, through the coordination
 * module, and nothing else. What an account is entitled to is decided by
 * reconciliation reading the provider's current state; a checkout that wrote an
 * entitlement would be claiming a payment had cleared when all it knows is that
 * a payment page was opened. The webhook remains the only way a provider's
 * doing reaches this system.
 *
 * **The provider is an argument, not an import.** There is no Stripe here —
 * which is what lets every branch below be tested without one, and what keeps
 * the decision about who may buy separate from the decision about how a session
 * is made.
 */

/** What a checkout needs from a provider, and all it needs. */
export type CheckoutSessionRequest = {
  readonly attemptId: string;
  readonly userId: string;
  readonly plan: CheckoutAttemptPlan;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Derived from the attempt so a replay asks for the same thing. */
  readonly expiresAt: Date;
  /** Only when the account already has one. Never looked up by email. */
  readonly providerCustomerId: string | null;
};

/** What became of a session the provider already had. */
export type ProviderSessionState = {
  /** `payable`: still open. `paid`: money taken. `lapsed`: nobody can pay it. */
  readonly kind: "payable" | "paid" | "lapsed" | "unreadable";
  readonly url: string | null;
};

/** Whether a customer already has a subscription that stops another. */
export type ProviderSubscriptionPresence =
  | { readonly kind: "none" }
  | { readonly kind: "live"; readonly providerSubscriptionId: string };

export type CheckoutProvider = {
  createSession(
    request: CheckoutSessionRequest,
  ): Promise<{ readonly sessionId: string; readonly url: string | null }>;
  readSession(sessionId: string): Promise<ProviderSessionState>;
  findLiveSubscription(
    providerCustomerId: string,
  ): Promise<ProviderSubscriptionPresence>;
};

/** How an account's active workers compare with the plan it is buying. */
export type GuardrailStanding = "below-limit" | "at-limit" | "over-limit";

/**
 * What starting a checkout came to.
 *
 * **Answers rather than exceptions.** Every one of these is something a person
 * did or a deployment is, not a fault — so each is a value the caller renders,
 * and nothing about a provider's own error text travels in any of them.
 */
export type StartCheckoutResult =
  /** There is a session to send them to. */
  | {
      readonly outcome: "checkout-ready";
      readonly attemptId: string;
      readonly sessionId: string;
      readonly url: string | null;
      readonly standing: GuardrailStanding;
      /** Whether this session already existed. Nothing was created if so. */
      readonly resumed: boolean;
    }
  /**
   * More active workers than this plan allows, and nobody has said they
   * understand that yet.
   *
   * **Nothing was written and no provider was called.** The purchase is not
   * refused — it needs an acknowledgement, and taking a coordination slot for a
   * decision somebody has not made yet would hold it against them.
   */
  | {
      readonly outcome: "over-limit-confirmation-required";
      readonly activeWorkers: number;
      readonly activeWorkerLimit: number;
    }
  /** Partway through buying a different plan. Switching is its own flow. */
  | {
      readonly outcome: "plan-switch-required";
      readonly currentPlan: CheckoutAttemptPlan;
      readonly attemptId: string;
    }
  /** Paid already. Changing or cancelling belongs to the provider's portal. */
  | { readonly outcome: "billing-management-required"; readonly reason: BillingManagementReason }
  /**
   * They have already paid through this session and reconciliation has not
   * caught up. **Not a new session**, and not an entitlement either.
   */
  | { readonly outcome: "payment-processing"; readonly attemptId: string }
  /**
   * The provider could not be asked whether this account already has a
   * subscription. **Fails closed**: being unable to buy for a minute is a
   * smaller harm than being billed twice.
   */
  | { readonly outcome: "provider-verification-unavailable" }
  /** The provider cannot be reached or is not configured here. */
  | { readonly outcome: "unavailable"; readonly reason: string }
  /** Something stored or configured does not make sense. Nothing was created. */
  | { readonly outcome: "malformed-config"; readonly reason: MalformedReason };

export type BillingManagementReason =
  /** A live paid subscription. */
  | "already-subscribed"
  /** Paid, and behind on payment. The portal is where a card is fixed. */
  | "payment-behind"
  /** Cancelled but still inside the period it was paid for. */
  | "cancelling"
  /** The provider says a subscription is live for this customer. */
  | "provider-subscription-live";

export type MalformedReason =
  /** A paid state with no provider subscription to point at. */
  | "inconsistent-subscription"
  /** A stored entitlement this version cannot read. */
  | "unreadable-entitlement"
  /** No usable `AUTH_URL`, so there is nowhere to return to. */
  | "no-return-url"
  /** An attempt stored in a shape this version cannot read. */
  | "unreadable-attempt";

/**
 * How long a provider session may be paid for, mirrored here so the expiry can
 * be derived without importing a provider.
 *
 * **Twelve hours, under the eighteen an attempt holds its slot.** If the
 * session outlived the slot, a second checkout could begin while the first was
 * still payable — which is the thing the slot exists to prevent.
 */
export const CHECKOUT_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * When the session for an attempt stops being payable.
 *
 * **Derived from the attempt's own instant, never from the clock.** The provider
 * refuses an idempotency key reused with different parameters — proven against
 * a sandbox — so a retry that recomputed "now plus twelve hours" would be asking
 * for something different with the same key and would fail. `createdAt` does not
 * move, so neither does this.
 *
 * **The same rule reaches past this function, into deployment.** Everything a
 * session request carries has to survive a retry unchanged, and two of those
 * things live in the environment rather than in the attempt: the price ids and
 * the origin the return urls are built from. Changing either while an attempt is
 * still `starting` means its retry asks for something different under a key the
 * provider has already answered — which fails closed rather than double-charging
 * anybody, but strands that one attempt until its slot lapses. **Nothing is
 * stored to prevent it**, deliberately: a snapshot of the request would be a
 * second copy of the configuration, and the configuration is not what this table
 * is for. What stands in for it is an operational habit — change prices or the
 * origin when no attempt is unfinished, which is a read anybody can do.
 */
export function sessionExpiresAt(attempt: CheckoutAttempt): Date {
  return new Date(attempt.createdAt.getTime() + CHECKOUT_SESSION_LIFETIME_MS);
}

/** Which columns the eligibility decision reads. */
const SUBSCRIPTION_FIELDS = {
  plan: true,
  state: true,
  source: true,
  trialStartedAt: true,
  trialEndsAt: true,
  trialConsumedAt: true,
  trialForfeitedAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  notificationWorkerId: true,
  expiresAt: true,
  providerCustomerId: true,
  providerSubscriptionId: true,
} as const;

type SubscriptionRow = {
  plan: string;
  state: string;
  source: string;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialConsumedAt: Date | null;
  trialForfeitedAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  notificationWorkerId: string | null;
  expiresAt: Date | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
};

/** What the account's own rows say about buying. */
type Eligibility =
  | {
      readonly kind: "may-buy";
      /** Non-null only for an account that has bought before. */
      readonly providerCustomerId: string | null;
      /** Whether the provider must be asked before a session is made. */
      readonly verifyWithProvider: boolean;
    }
  | { readonly kind: "manage"; readonly reason: BillingManagementReason }
  | { readonly kind: "malformed"; readonly reason: MalformedReason };

/** Paid states, by the provider — the ones a checkout must not add to. */
const ENTITLING_PAID_STATES: Record<string, BillingManagementReason> = {
  active: "already-subscribed",
  grace: "payment-behind",
  canceled_active: "cancelling",
};

/**
 * Whether this account may start a checkout, from its own rows alone.
 *
 * **No row is an ordinary answer.** Provisioning writes the `User` at the first
 * write path; a `Subscription` appears only when a trial starts or something is
 * granted, so an account that has never activated a worker reaches here with
 * none — and may buy.
 *
 * **A paid state is not read from `source` alone.** `computeEntitlement` already
 * resolves the eight states and their clocks; asking it rather than comparing
 * strings is what keeps a cancelled-but-still-inside-its-period account from
 * looking cancelled.
 */
function readEligibility(
  row: SubscriptionRow | null,
  now: Date,
): Eligibility {
  if (row === null) {
    return { kind: "may-buy", providerCustomerId: null, verifyWithProvider: false };
  }

  let state: string;
  try {
    state = computeEntitlement(row, now).state;
  } catch {
    // A stored entitlement this version cannot read was written by one that
    // knew more. Selling against it would be guessing at what somebody has.
    return { kind: "malformed", reason: "unreadable-entitlement" };
  }

  const boughtBefore = row.source === "stripe";

  // **A paid state with nothing to point at is refused, not repaired.** Either
  // the row or this reading of it is wrong, and creating a subscription on top
  // of a row nobody can explain is how an account ends up with two.
  if (boughtBefore && row.providerSubscriptionId === null) {
    return { kind: "malformed", reason: "inconsistent-subscription" };
  }

  const manage = ENTITLING_PAID_STATES[state];

  if (manage !== undefined && boughtBefore) {
    return { kind: "manage", reason: manage };
  }

  return {
    kind: "may-buy",
    providerCustomerId: row.providerCustomerId,
    // **Asked whenever the account has a customer.** Koqentra may say
    // `inactive` while the provider has a live subscription that reconciliation
    // has not read yet — which is exactly the window a duplicate is born in.
    verifyWithProvider: row.providerCustomerId !== null,
  };
}

/**
 * Where the provider sends somebody back to.
 *
 * **Written out here rather than at the call site** so the pages and the tests
 * name the same two strings: an address that only existed inside a URL
 * constructor would be one nothing could check against.
 */
const CHECKOUT_RETURN_PATH = "/dashboard/billing/return";
const CHECKOUT_CANCEL_PATH = "/dashboard/billing";

/**
 * Where a completed or abandoned checkout comes back to.
 *
 * **Built from the deployment's own origin, never from anything a caller
 * supplied.** A return address taken from input is an open redirect, and a
 * payment page is the last place to hand one out.
 *
 * **Success has a page of its own now.** Both of these used to be `/dashboard`,
 * which meant somebody who had just paid landed on a screen that knew nothing
 * about it: the entitlement is written by a reconciliation run seconds to minutes
 * later, so the dashboard — and the plans page they went to next — told them they
 * were not on a plan. The success address is a page whose whole job is to wait
 * for the entitlement and say so meanwhile.
 *
 * **Nothing about the account is in either address.** No id, no email, no price,
 * no customer, no session. The page reads who is asking from the session, which
 * is the only account it could answer for; a query parameter naming one would be
 * a parameter somebody could change.
 *
 * **`{CHECKOUT_SESSION_ID}` is deliberately not used.** The provider offers to
 * put the session's id in the address, and taking it would put a provider
 * identifier in a browser's history and give the page something to trust that a
 * caller can type. What the page needs to know is whether *this account's*
 * entitlement has landed, and Koqentra's own rows answer that.
 *
 * **Cancelling goes back to the plans page unchanged.** The session stays
 * payable and the attempt keeps its slot, so pressing the button again resumes
 * the same checkout — which is what somebody who changed their mind at the
 * payment page and then changed it back should get.
 */
function returnUrls(): { success: string; cancel: string } | null {
  const base = process.env.AUTH_URL?.trim();

  if (!base) {
    return null;
  }

  try {
    const success = new URL(CHECKOUT_RETURN_PATH, base);
    const cancel = new URL(CHECKOUT_CANCEL_PATH, base);

    if (success.protocol !== "https:" && success.protocol !== "http:") {
      return null;
    }

    return { success: success.toString(), cancel: cancel.toString() };
  } catch {
    return null;
  }
}

/** Everything the orchestration needs, so every branch can be tested. */
export type StartCheckoutInput = {
  /** From the session. **Never from a caller's input.** */
  readonly userId: string;
  readonly plan: CheckoutAttemptPlan;
  /** True only when somebody was shown the over-limit explanation and agreed. */
  readonly overLimitAcknowledged?: boolean;
  readonly provider: CheckoutProvider | { readonly unavailable: string };
  readonly client?: DbClient;
  readonly now?: Date;
};

/**
 * Starts a checkout, or says why not.
 *
 * The order is deliberate and each step is cheaper than the next:
 *
 * 1. **Eligibility**, from Koqentra's rows. A paid account never reaches a
 *    provider.
 * 2. **The guardrail**, counted fresh. An unacknowledged over-limit does not
 *    take a slot.
 * 3. **The attempt**, under the account's lock. This is the first write.
 * 4. **The provider**, outside any transaction. Reading an existing session
 *    before making a new one is what stops a second session for one attempt.
 */
export async function startCheckout(
  input: StartCheckoutInput,
): Promise<StartCheckoutResult> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();

  if ("unavailable" in input.provider) {
    return { outcome: "unavailable", reason: input.provider.unavailable };
  }

  const provider = input.provider;

  const urls = returnUrls();

  // Checked before anything is written: a session with nowhere to return to is
  // not one to create.
  if (urls === null) {
    return { outcome: "malformed-config", reason: "no-return-url" };
  }

  const subscription = await client.subscription.findUnique({
    where: { userId: input.userId },
    select: SUBSCRIPTION_FIELDS,
  });

  const eligibility = readEligibility(subscription, now);

  if (eligibility.kind === "manage") {
    return { outcome: "billing-management-required", reason: eligibility.reason };
  }

  if (eligibility.kind === "malformed") {
    return { outcome: "malformed-config", reason: eligibility.reason };
  }

  // **Counted here, not taken from the page that asked.** Between rendering a
  // price and pressing Buy, a worker can be activated in another tab.
  const activeWorkers = await client.routine.count({
    where: { userId: input.userId, status: "active" },
  });
  const activeWorkerLimit = getPlanDefinition(input.plan).activeWorkerLimit;
  const standing: GuardrailStanding =
    activeWorkers > activeWorkerLimit
      ? "over-limit"
      : activeWorkers === activeWorkerLimit
        ? "at-limit"
        : "below-limit";

  if (standing === "over-limit" && input.overLimitAcknowledged !== true) {
    return {
      outcome: "over-limit-confirmation-required",
      activeWorkers,
      activeWorkerLimit,
    };
  }

  // **The provider is asked before the slot is taken.** A customer with a live
  // subscription is going to be refused either way, and refusing without having
  // written anything leaves nothing behind to tidy.
  if (eligibility.verifyWithProvider && eligibility.providerCustomerId !== null) {
    let presence: ProviderSubscriptionPresence;

    try {
      presence = await provider.findLiveSubscription(
        eligibility.providerCustomerId,
      );
    } catch {
      // **Fails closed, and says nothing of the cause.** Not knowing whether
      // an account already pays is exactly when a second subscription gets
      // created, so the answer is "try again", not "go ahead".
      return { outcome: "provider-verification-unavailable" };
    }

    if (presence.kind === "live") {
      return {
        outcome: "billing-management-required",
        reason: "provider-subscription-live",
      };
    }
  }

  const begun = await beginCheckoutAttempt({
    userId: input.userId,
    plan: input.plan,
    now,
    client,
  });

  if (begun.outcome === "plan-switch-required") {
    return {
      outcome: "plan-switch-required",
      currentPlan: begun.attempt.plan,
      attemptId: begun.attempt.id,
    };
  }

  let attempt = begun.attempt;

  // **An attempt that already named a session is asked about before anything
  // is created.** The slot outlives the session by six hours, so between those
  // two an attempt is live and its session is not — and asking for a second
  // session under the same id would be asking the provider for something
  // different with a key it has already answered.
  if (attempt.providerCheckoutSessionId !== null) {
    let existing: ProviderSessionState;

    try {
      existing = await provider.readSession(attempt.providerCheckoutSessionId);
    } catch {
      // **Fails closed, and the attempt is left exactly as it was.** Not
      // knowing whether a session can still be paid is not a reason to make a
      // second one.
      return { outcome: "provider-verification-unavailable" };
    }

    switch (existing.kind) {
      case "payable":
        return {
          outcome: "checkout-ready",
          attemptId: attempt.id,
          sessionId: attempt.providerCheckoutSessionId,
          url: existing.url,
          standing,
          resumed: true,
        };
      case "paid":
        // Already paid for. Reconciliation will turn that into an entitlement;
        // nothing here may, and a second session would be a second charge. The
        // attempt keeps the slot, because the purchase it stands for happened.
        return { outcome: "payment-processing", attemptId: attempt.id };
      case "lapsed":
        break;
      default:
        return { outcome: "malformed-config", reason: "unreadable-attempt" };
    }

    // **A lapsed session is finished with, and the provider is the one saying
    // so.** That is what separates this from a plan switch: there, the account
    // may be looking at a payment page and only they can decide to abandon it;
    // here, nobody can pay through this session any more, whatever they decide.
    // So the slot is released and taken again in one go rather than held for the
    // six hours the attempt has left.
    //
    // **`expire` is not called.** The session is already expired; asking the
    // provider to expire it would be a write with nothing to change. The only
    // provider write this path makes is the new session.
    await closeCheckoutAttempt({ attemptId: attempt.id, client });

    const reopened = await beginCheckoutAttempt({
      userId: input.userId,
      plan: input.plan,
      now,
      client,
    });

    // The plan cannot have changed — it is the same argument — so a switch here
    // would mean something else replaced the attempt in between. That is
    // somebody else's purchase in progress, and this request does not disturb
    // it.
    if (reopened.outcome === "plan-switch-required") {
      return {
        outcome: "plan-switch-required",
        currentPlan: reopened.attempt.plan,
        attemptId: reopened.attempt.id,
      };
    }

    // **A concurrent recovery converges here.** Two requests that both saw the
    // lapse both close and both begin; the account's lock and the unique index
    // give them one row, so the second reads the first's attempt. If that
    // attempt already names a session, it is the one to use.
    if (reopened.attempt.providerCheckoutSessionId !== null) {
      return {
        outcome: "checkout-ready",
        attemptId: reopened.attempt.id,
        sessionId: reopened.attempt.providerCheckoutSessionId,
        url: null,
        standing,
        resumed: true,
      };
    }

    attempt = reopened.attempt;
  }

  return await createSessionForAttempt({
    attempt,
    userId: input.userId,
    urls,
    providerCustomerId: eligibility.providerCustomerId,
    provider,
    client,
    standing,
  });
}

/**
 * Asks the provider for the session this attempt stands for, and records it.
 *
 * **Every parameter comes from the attempt or from the deployment**, never from
 * the clock and never from the account's own settings: the provider refuses an
 * idempotency key reused with different parameters, so a retry has to ask for
 * exactly what the first try asked for.
 */
async function createSessionForAttempt(input: {
  readonly attempt: CheckoutAttempt;
  readonly userId: string;
  readonly urls: { success: string; cancel: string };
  readonly providerCustomerId: string | null;
  readonly provider: CheckoutProvider;
  readonly client: DbClient;
  readonly standing: GuardrailStanding;
}): Promise<StartCheckoutResult> {
  const request: CheckoutSessionRequest = {
    attemptId: input.attempt.id,
    userId: input.userId,
    plan: input.attempt.plan,
    successUrl: input.urls.success,
    cancelUrl: input.urls.cancel,
    // From the attempt, so a retry asks for the same instant.
    expiresAt: sessionExpiresAt(input.attempt),
    providerCustomerId: input.providerCustomerId,
  };

  let created: { sessionId: string; url: string | null };

  try {
    created = await input.provider.createSession(request);
  } catch {
    // **The attempt is left `starting`.** Its id is the idempotency key, so the
    // next try asks the provider for the same session rather than a second one
    // — including when this failure was a timeout and the session exists.
    return { outcome: "provider-verification-unavailable" };
  }

  const marked = await markCheckoutAttemptOpen({
    attemptId: input.attempt.id,
    providerCheckoutSessionId: created.sessionId,
    client: input.client,
  });

  // `opened` and `already-open` are both the state this wanted. `not-found`
  // means the attempt was replaced while the provider was being called — the
  // session exists and nothing points at it, which the next attempt's own
  // session supersedes. A different session on the same attempt throws out of
  // `markCheckoutAttemptOpen`, deliberately: it is not something to choose
  // between.
  if (marked.outcome === "not-found") {
    return { outcome: "payment-processing", attemptId: input.attempt.id };
  }

  return {
    outcome: "checkout-ready",
    attemptId: input.attempt.id,
    sessionId: created.sessionId,
    url: created.url,
    standing: input.standing,
    resumed: false,
  };
}
