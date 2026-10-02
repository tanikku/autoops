import type { Metadata } from "next";
import { BillingPortalButton } from "@/components/billing-portal-button";
import { DashboardNav } from "@/components/dashboard-nav";
import { PlanCards } from "@/components/plan-cards";
import { isSandboxCheckoutEnabledForUser } from "@/lib/billing/checkout-sandbox-server";
import { planNameKey } from "@/lib/billing/plan-labels";
import { mayOpenBillingPortal } from "@/lib/billing/portal";
import {
  type CurrentPlanView,
  mayOfferPurchase,
  readPricingView,
} from "@/lib/billing/pricing";
import type { EntitlementState } from "@/lib/entitlements/types";
import { type TranslationKey, t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";

/**
 * What each plan allows, and what a smaller allowance would mean.
 *
 * **This page starts nothing itself.** It does not import the checkout action:
 * the one control that calls it is `components/checkout-plan-button.tsx`, and
 * what this page contributes is the two questions only the server can answer —
 * what the account is on, and whether the purchase path is open to it yet.
 *
 * **Who may buy is decided here and enforced again in the action.** While the
 * checkout is being proved against a sandbox it is open to one account; asking
 * here is what keeps a live-looking button away from everybody else, and asking
 * again in the action is what makes it true, because a server action is callable
 * by anybody signed in whatever a page rendered.
 *
 * **Still a server component.** There is no selection to hold and no form to
 * submit; the whole screen is two numbers and a catalogue, and the part with
 * stages of its own is one button inside the cards.
 *
 * **Read-only.** `requireUserId` authenticates without provisioning — a page
 * view must not write the account row, and nothing here needs it to exist.
 */

/**
 * Which sentence describes each state, and the one state that needs two.
 *
 * **Keyed by every state so a new one cannot be forgotten.** The record is typed
 * over `EntitlementState`, so adding a ninth state to `lib/entitlements` fails
 * this file to compile rather than quietly falling through to "cannot be shown".
 *
 * **`active` is two different facts.** A grant and a purchase both read as
 * active, and telling somebody on the Closed Beta allowance that they are
 * subscribed would be telling them they are being charged.
 */
type StateCopy =
  | TranslationKey
  | { readonly granted: TranslationKey; readonly purchased: TranslationKey };

const STATE_COPY: Readonly<Record<EntitlementState, StateCopy>> = {
  none: "pricing.current.none",
  trialing: "pricing.current.trialing",
  trial_expired: "pricing.current.trialExpired",
  active: {
    granted: "pricing.current.activeGranted",
    purchased: "pricing.current.activePurchased",
  },
  grace: "pricing.current.grace",
  canceled_active: "pricing.current.cancelledActive",
  inactive: "pricing.current.inactive",
  expired: "pricing.current.expired",
};

/** The four allowances on every card, in the order the cards list them. */
const ALLOWANCE_GUIDE = [
  {
    title: "pricing.allowanceGuide.activeWorkers.title",
    body: "pricing.allowanceGuide.activeWorkers.body",
  },
  {
    title: "pricing.allowanceGuide.aiProcessing.title",
    body: "pricing.allowanceGuide.aiProcessing.body",
  },
  {
    title: "pricing.allowanceGuide.manualRun.title",
    body: "pricing.allowanceGuide.manualRun.body",
  },
  {
    title: "pricing.allowanceGuide.discovery.title",
    body: "pricing.allowanceGuide.discovery.body",
  },
] as const satisfies readonly { title: TranslationKey; body: TranslationKey }[];

/**
 * One sentence saying what the account has.
 *
 * **The state decides the sentence; the plan only fills in a name.** Reading the
 * plan alone is what put "You are on lite" on the screen of an account whose
 * Lite subscription had ended — a plan says what was bought, and only a state
 * says whether it still gives anything.
 *
 * **Presentation only.** Nothing here decides what may be bought: that is
 * `mayOfferPurchase`, asked once and separately, and a second opinion about it
 * living in a heading would be a second thing to keep in step.
 *
 * **A stored value this build cannot read is not guessed at**, whether it is the
 * state or the plan. Either way the answer is the one the page already gives for
 * an unreadable row.
 */
function currentPlanSentence(
  current: CurrentPlanView,
  language: string,
): string {
  if (current.kind === "none") {
    return t(language, "pricing.current.none");
  }

  if (current.kind === "unreadable") {
    return t(language, "pricing.current.unreadable");
  }

  // Widened at the lookup, not at the declaration: the record is exhaustive over
  // the states this build knows, and a row may hold one it does not.
  const copy: StateCopy | undefined = (
    STATE_COPY as Readonly<Record<string, StateCopy | undefined>>
  )[current.state];
  const nameKey = planNameKey(current.plan);

  if (copy === undefined || nameKey === null) {
    return t(language, "pricing.current.unreadable");
  }

  return t(
    language,
    typeof copy === "string"
      ? copy
      : current.purchased
        ? copy.purchased
        : copy.granted,
    // Named, never the stored id: the cards below call the same plan `Lite`.
    { plan: t(language, nameKey) },
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const language = await getDocumentLanguage();

  return {
    title: t(language, "pricing.title"),
    description: t(language, "pricing.description"),
  };
}

export default async function BillingPage() {
  const userId = await requireUserId();
  const [language, view] = await Promise.all([
    getUserLanguage(userId),
    readPricingView(userId),
  ]);

  const offerPurchase = mayOfferPurchase(view.current);
  // **The authenticated id, never anything a request supplied.** What crosses
  // into the browser from this is one boolean; the list it was decided from stays
  // in the environment of the server that read it.
  const checkoutEnabled = isSandboxCheckoutEnabledForUser(userId);
  // **The Closed Beta allowance sees the plans but is offered none of them.**
  // `mayOfferPurchase` already answers no for it, and the action refuses it
  // too; the cards stay so the prices and allowances can still be read.
  const showPlans =
    offerPurchase ||
    (view.current.kind === "on-plan" && view.current.adminGrantedBeta);
  // **The same rollout switch opens the portal.** The accounts that have bought
  // anything while checkout is proved are the accounts on that list; everybody
  // else who has something to manage keeps the sentence they had, with the
  // button beside it disabled the way an unopened checkout button is.
  const portalOffered = mayOpenBillingPortal(view.current);
  const portalEnabled = portalOffered && checkoutEnabled;
  // **Only where a purchase would end a running trial, and only where one can be
  // started.** An ended trial has nothing left to lose, and an account the
  // rollout has not reached is shown no new sentence about a button it cannot
  // press.
  const trialPurchaseNotice =
    offerPurchase &&
    checkoutEnabled &&
    view.current.kind === "on-plan" &&
    view.current.state === "trialing";

  return (
    <div className="flex min-h-dvh flex-col">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "pricing.title")}
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          {t(language, "pricing.description")}
        </p>

        <section className="mt-10 border-t border-border pt-8">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "pricing.current.heading")}
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            {currentPlanSentence(view.current, language)}
          </p>
          {/* The count every guardrail sentence below refers to, said once. */}
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t(language, "pricing.current.activeWorkers", {
              count: view.activeWorkers,
            })}
          </p>
          {/* **Said while a checkout of theirs is unfinished, and it explains
              rather than blocks.** A payment that has cleared takes seconds to
              minutes to become an entitlement, and during that window the
              sentence above is correct and alarming. The buttons stay as they
              were: whether this checkout may be replaced is the orchestration's
              question, asked under the account's lock with the provider's answer
              in hand, and a page that guessed at it would lock somebody who
              abandoned a payment page out of trying again. */}
          {view.checkoutInProgress ? (
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              {t(language, "pricing.checkoutInProgress")}
            </p>
          ) : null}
        </section>

        {showPlans ? (
          <>
            {trialPurchaseNotice ? (
              <p className="mt-10 max-w-2xl rounded-md border border-border px-4 py-3 text-sm">
                {t(language, "pricing.trialPurchaseNotice")}
              </p>
            ) : null}
            <PlanCards
              plans={view.plans}
              activeWorkers={view.activeWorkers}
              language={language}
              checkoutEnabled={checkoutEnabled}
              purchasable={offerPurchase}
            />
            {/* What each line on the cards counts, said once beneath them. */}
            <section className="mt-10 border-t border-border pt-8">
              <h2 className="text-lg font-medium tracking-tight">
                {t(language, "pricing.allowanceGuide.heading")}
              </h2>
              <dl className="mt-4 max-w-2xl space-y-4 text-sm">
                {ALLOWANCE_GUIDE.map((entry) => (
                  <div key={entry.title}>
                    <dt className="font-medium">{t(language, entry.title)}</dt>
                    <dd className="mt-1 text-muted-foreground">
                      {t(language, entry.body)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        ) : (
          /* **Somebody already paying is not shown a plan to buy.** Offering one
             would be offering them a second subscription; what they need is the
             provider's own page for the one they have. Where that is not open to
             them yet, the page says so rather than implying a control exists.
             **The portal sentence names no operation.** What can be done there
             is the provider's configuration, and a sentence promising a plan
             change or a cancellation would be a claim this page cannot check. */
          <section className="mt-10 border-t border-border pt-8">
            <h2 className="text-lg font-medium tracking-tight">
              {t(language, "pricing.managed.heading")}
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              {t(
                language,
                portalEnabled
                  ? "pricing.managed.portalDescription"
                  : "pricing.managed.description",
              )}
            </p>
            {portalOffered ? (
              <BillingPortalButton
                enabled={portalEnabled}
                labels={{
                  manage: t(language, "pricing.portal.manage"),
                  unavailable: t(language, "pricing.cta.comingSoon"),
                  pending: t(language, "pricing.portal.pending"),
                  messages: {
                    notEligible: t(language, "pricing.portal.message.notEligible"),
                    unavailable: t(language, "pricing.portal.message.unavailable"),
                  },
                }}
              />
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
