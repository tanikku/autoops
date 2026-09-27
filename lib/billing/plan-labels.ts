import { type PlanId, isPlan } from "@/lib/plans";
import type { TranslationKey } from "@/lib/i18n/en";

/**
 * What each plan is called on a screen.
 *
 * **Shared rather than owned by one component.** The plans page names the
 * account's current plan and the cards name the ones for sale; when those two
 * read different tables, the same plan gets two names on one screen — which is
 * what happened when the mapping lived inside the cards and the heading fell
 * back to the stored id. One table, read by both.
 *
 * **Not server-only, deliberately.** It holds a lookup and no data access, so a
 * client component can render a plan name without a boundary being crossed for
 * nothing. `lib/billing/pricing.ts` is the server-only half and stays that way.
 *
 * **A mapping rather than a transformation.** Capitalising the stored id would
 * produce a name nobody chose and would silently invent one for a plan added
 * later; a key that does not exist is a build failure instead.
 */

/**
 * Every plan, including the two that cannot be bought.
 *
 * `trial` and `beta` are plans an account can be *on* — one begins by activating
 * a worker, the other is granted — so a screen describing what somebody has must
 * be able to name them. The three below them are the ones with a price.
 */
const PLAN_NAME_KEYS: Readonly<Record<PlanId, TranslationKey>> = {
  trial: "pricing.plan.trial",
  lite: "pricing.plan.lite",
  standard: "pricing.plan.standard",
  pro: "pricing.plan.pro",
  beta: "pricing.plan.beta",
};

/**
 * The key that names this plan, or nothing if this version does not know it.
 *
 * **Null rather than a guess.** A stored plan a newer version wrote is not a
 * plan to name from its id: the caller says "cannot be shown" instead, which is
 * the answer it already gives for a stored state it cannot read.
 */
export function planNameKey(plan: string): TranslationKey | null {
  return isPlan(plan) ? PLAN_NAME_KEYS[plan] : null;
}

/**
 * The key that names a plan this build already knows.
 *
 * **For a caller holding a plan id from the catalogue** rather than one read back
 * out of a row — the cards, listing what is for sale. There is nothing to fall
 * back to because there is nothing that could be missing.
 */
export function planNameKeyFor(plan: PlanId): TranslationKey {
  return PLAN_NAME_KEYS[plan];
}
