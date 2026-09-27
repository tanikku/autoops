import "server-only";

import { isPaidPlan } from "@/lib/billing/events";
import type { CurrentPlanView } from "@/lib/billing/pricing";
import { computeEntitlement } from "@/lib/entitlements/index";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Sending somebody who pays to the provider's own page for managing that.
 *
 * **It writes nothing, anywhere.** A portal session is a short-lived address,
 * not a fact about the account: whatever the owner changes on the provider's
 * page comes back the way every provider change does — a delivery, a receipt,
 * a reconciliation that reads the provider's current state. A portal that wrote
 * an entitlement here would be a second route into `Subscription`, and it would
 * be claiming a change had happened when all it knows is that a page was opened.
 *
 * **What may be done on that page is the provider's configuration, not this
 * file's.** Nothing here asks for a plan change, a cancellation or a particular
 * flow. That is deliberate: reconciliation refuses a downgrade, so a portal that
 * offered plan switching would let the provider bill for one plan while this
 * system grants another. Keeping plan switching off is a setting on the
 * provider's side and is checked there before this is rolled out.
 *
 * **The provider is an argument, not an import**, the same shape as
 * `startCheckout` — so every branch below is testable without one.
 */

/** What a portal session needs from a provider, and all it needs. */
export type BillingPortalSessionRequest = {
  /** Read from the account's own row on the server. Never from a caller. */
  readonly customerId: string;
  readonly returnUrl: string;
};

export type BillingPortalProvider = {
  createPortalSession(
    request: BillingPortalSessionRequest,
  ): Promise<{ readonly url: string | null }>;
};

/** Why a portal could not be opened for an account that may have one. */
export type BillingPortalUnavailableReason =
  /** The provider is not configured on this deployment. */
  | "provider-unconfigured"
  /** No usable `AUTH_URL`, so there is nowhere to come back to. */
  | "no-return-url"
  /** A paid row with no customer to open a portal for. */
  | "no-customer"
  /** The provider could not be asked, or refused. */
  | "provider-failed"
  /** The provider answered without an address, or with one not its own. */
  | "untrusted-url";

/**
 * What opening a portal came to.
 *
 * **Answers rather than exceptions**, and none of them carries the provider's
 * own words or identifiers — the url in `portal-ready` is the only thing that
 * came from the provider, and only after it was checked.
 */
export type OpenBillingPortalResult =
  | { readonly outcome: "portal-ready"; readonly url: string }
  /** Nothing bought that is still being paid for. There is nothing to manage. */
  | { readonly outcome: "not-eligible" }
  | {
      readonly outcome: "unavailable";
      readonly reason: BillingPortalUnavailableReason;
    };

/**
 * The states in which a bought subscription is still somebody's to manage.
 *
 * **The same three `startCheckout` sends to billing management.** Paying,
 * behind on paying, and cancelled but still inside the period paid for. An
 * account whose subscription has ended is not here: buying again is the
 * checkout's job, and looking back through old invoices is a later phase's.
 */
const MANAGEABLE_STATES: readonly string[] = [
  "active",
  "grace",
  "canceled_active",
];

/** The one host a portal address may point at. */
const TRUSTED_PORTAL_HOST = "billing.stripe.com";

/** Where the provider sends somebody back to. Fixed, like checkout's. */
const PORTAL_RETURN_PATH = "/dashboard/billing";

/**
 * Whether a pricing screen should offer the portal, from what it already read.
 *
 * **A preview, like everything on that screen.** The answer that decides
 * anything is `openBillingPortal`'s, taken from the row when the button is
 * pressed. A missing customer is not visible from here and is refused there.
 */
export function mayOpenBillingPortal(current: CurrentPlanView): boolean {
  return (
    current.kind === "on-plan" &&
    current.purchased &&
    isPaidPlan(current.plan) &&
    MANAGEABLE_STATES.includes(current.state)
  );
}

/**
 * Whether an address the provider gave is one to send somebody to.
 *
 * **Checked even though the provider built it.** It is about to become a
 * navigation, and an address that did not point at the provider's own portal
 * would be this system sending somebody somewhere nobody chose.
 */
export function isTrustedPortalUrl(url: string | null): url is string {
  if (url === null) {
    return false;
  }

  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" && parsed.hostname === TRUSTED_PORTAL_HOST;
  } catch {
    return false;
  }
}

/**
 * Where the portal comes back to.
 *
 * **Built from the deployment's own origin, never from anything a caller
 * supplied**, for the same reason as checkout's return addresses: a return
 * address taken from input is an open redirect.
 */
function returnUrl(): string | null {
  const base = process.env.AUTH_URL?.trim();

  if (!base) {
    return null;
  }

  try {
    const url = new URL(PORTAL_RETURN_PATH, base);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

/** Which columns the decision reads. */
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
} as const;

export type OpenBillingPortalInput = {
  /** From the session. **Never from a caller's input.** */
  readonly userId: string;
  readonly provider:
    | BillingPortalProvider
    | { readonly unavailable: string };
  readonly client?: DbClient;
  readonly now?: Date;
};

/**
 * Opens a portal session for the signed-in account, or says why not.
 *
 * **Who, then where, then the provider.** Whether the account has something to
 * manage is answered from its own row first, so an account with nothing bought
 * never reaches a provider and learns nothing about the deployment's
 * configuration either.
 */
export async function openBillingPortal(
  input: OpenBillingPortalInput,
): Promise<OpenBillingPortalResult> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();

  const row = await client.subscription.findUnique({
    where: { userId: input.userId },
    select: SUBSCRIPTION_FIELDS,
  });

  if (row === null || row.source !== "stripe" || !isPaidPlan(row.plan)) {
    return { outcome: "not-eligible" };
  }

  let state: string;

  try {
    state = computeEntitlement(row, now).state;
  } catch {
    // A row this version cannot read is not one to open a payment page about.
    return { outcome: "not-eligible" };
  }

  if (!MANAGEABLE_STATES.includes(state)) {
    return { outcome: "not-eligible" };
  }

  const customerId = row.providerCustomerId?.trim();

  // **A paid row with no customer is refused, not repaired.** There is no
  // other way to find the customer that is not a guess, and a guess here opens
  // somebody else's billing.
  if (!customerId) {
    return { outcome: "unavailable", reason: "no-customer" };
  }

  if ("unavailable" in input.provider) {
    return { outcome: "unavailable", reason: "provider-unconfigured" };
  }

  const back = returnUrl();

  if (back === null) {
    return { outcome: "unavailable", reason: "no-return-url" };
  }

  let portalUrl: string | null;

  try {
    const created = await input.provider.createPortalSession({
      customerId,
      returnUrl: back,
    });

    portalUrl = typeof created?.url === "string" ? created.url : null;
  } catch {
    // **The category, never the cause.** A provider's error text quotes
    // identifiers; nothing about it helps the person who pressed the button.
    return { outcome: "unavailable", reason: "provider-failed" };
  }

  if (!isTrustedPortalUrl(portalUrl)) {
    return { outcome: "unavailable", reason: "untrusted-url" };
  }

  return { outcome: "portal-ready", url: portalUrl };
}
