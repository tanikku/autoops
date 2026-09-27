import "server-only";

import {
  type CheckoutAttemptPlan,
  checkoutAttemptPlans,
} from "@/lib/billing/checkout-attempt";
import { computeEntitlement } from "@/lib/entitlements/index";
import { type PlanDefinition, getPlanDefinition } from "@/lib/plans";
import { prisma } from "@/lib/prisma";

/**
 * What a pricing screen needs to know, read and never written.
 *
 * **A preview, and it says so.** The standing each plan gets here is worked out
 * from a count taken when the page rendered; by the time somebody presses Buy it
 * may have moved, and the answer that decides anything is the one
 * `startCheckout` takes for itself under the account's lock. Nothing on a page
 * may be trusted to gate a purchase, so nothing here pretends to.
 *
 * **Read-only, and structurally so.** There is no write in this file and no
 * import that could perform one on its behalf: what it does is two queries and
 * some arithmetic over the plan catalogue.
 */

/** How an account's active workers compare with a plan's allowance. */
export type PlanStanding = "below-limit" | "at-limit" | "over-limit";

/**
 * One plan as a pricing screen shows it.
 *
 * **The allowances are the catalogue's own object**, not a copy of its numbers.
 * A second table of limits would be a second thing to change when one moves.
 */
export type PricedPlan = {
  readonly id: CheckoutAttemptPlan;
  readonly definition: PlanDefinition;
  /** Monthly price in yen. */
  readonly monthlyYen: number;
  readonly standing: PlanStanding;
};

/**
 * What the account is on now, as far as a pricing screen needs it.
 *
 * **`state` comes from `computeEntitlement`**, so a cancellation still inside
 * the period it was paid for reads as such rather than as cancelled — and the
 * eight states are resolved in the one place that knows them.
 */
export type CurrentPlanView =
  /** Nothing bought and nothing granted. */
  | { readonly kind: "none" }
  /** On a plan, bought or granted. */
  | {
      readonly kind: "on-plan";
      readonly plan: string;
      readonly state: string;
      /** Whether this was bought from a provider rather than granted. */
      readonly purchased: boolean;
      /** Whether it entitles anything at this instant. */
      readonly entitled: boolean;
    }
  /** Stored in a shape this version cannot read. Shown as unavailable. */
  | { readonly kind: "unreadable" };

export type PricingView = {
  readonly activeWorkers: number;
  readonly current: CurrentPlanView;
  readonly plans: readonly PricedPlan[];
};

/**
 * What each plan costs a month, in yen.
 *
 * **Here rather than in `lib/plans.ts`, deliberately.** That catalogue says what
 * a plan *allows* and is read by the code that decides what an account may do;
 * its own note is explicit that prices stay out of it, so that a module asking
 * about an allowance does not also learn who charges for it. A price is a fact
 * about selling, and this file is the selling side.
 *
 * **Still one copy.** The screen reads it from here; nothing else needs it. If a
 * second place ever does, it reads it from here too.
 *
 * **Not marked tax-inclusive or exclusive**, because that has not been decided —
 * and a screen that guessed would be making a claim about somebody's invoice.
 */
const MONTHLY_YEN: Readonly<Record<CheckoutAttemptPlan, number>> = {
  lite: 780,
  standard: 1480,
  pro: 2480,
};

/** Which columns the current-plan view is worked out from. */
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
} as const;

function standingFor(activeWorkers: number, limit: number): PlanStanding {
  if (activeWorkers > limit) {
    return "over-limit";
  }

  return activeWorkers === limit ? "at-limit" : "below-limit";
}

/**
 * Reads everything a pricing screen renders.
 *
 * **The active count is the same question the quota asks**, down to the
 * condition: `status = "active"`, for this account. A screen that counted
 * differently from the thing that refuses an activation would explain a refusal
 * with a number that did not cause it.
 */
export async function readPricingView(userId: string): Promise<PricingView> {
  const [subscription, activeWorkers] = await Promise.all([
    prisma.subscription.findUnique({
      where: { userId },
      select: SUBSCRIPTION_FIELDS,
    }),
    prisma.routine.count({ where: { userId, status: "active" } }),
  ]);

  return {
    activeWorkers,
    current: readCurrent(subscription),
    plans: checkoutAttemptPlans.map((id) => {
      const definition = getPlanDefinition(id);

      return {
        id,
        definition,
        monthlyYen: MONTHLY_YEN[id],
        standing: standingFor(activeWorkers, definition.activeWorkerLimit),
      };
    }),
  };
}

function readCurrent(
  row: Parameters<typeof computeEntitlement>[0],
): CurrentPlanView {
  if (row === null) {
    return { kind: "none" };
  }

  try {
    const entitlement = computeEntitlement(row, new Date());

    // **A row with no plan is not a row to describe.** `computeEntitlement`
    // answers `null` for an account it has nothing to say about, and naming a
    // plan that is not there would be inventing one.
    if (entitlement.plan === null) {
      return { kind: "none" };
    }

    return {
      kind: "on-plan",
      plan: entitlement.plan,
      state: entitlement.state,
      // Read from `source` rather than from the plan: a granted allowance and a
      // bought one can name the same plan, and only one of them is managed by a
      // provider.
      purchased: row.source === "stripe",
      entitled: entitlement.entitled,
    };
  } catch {
    // A state this version does not know was written by one that knew more.
    // Describing it would be guessing at what somebody has.
    return { kind: "unreadable" };
  }
}

/**
 * Whether a pricing screen should offer to sell anything.
 *
 * **A paid entitlement is managed, not replaced.** Somebody who is already
 * paying, is behind on a payment, or has cancelled but not yet reached the end
 * of what they paid for does not need a plan to buy — they need the provider's
 * own portal, and offering a purchase would be offering them a second
 * subscription. The same three states `startCheckout` refuses.
 */
export function mayOfferPurchase(current: CurrentPlanView): boolean {
  if (current.kind === "unreadable") {
    return false;
  }

  if (current.kind === "none") {
    return true;
  }

  return !(
    current.purchased &&
    (current.state === "active" ||
      current.state === "grace" ||
      current.state === "canceled_active")
  );
}
