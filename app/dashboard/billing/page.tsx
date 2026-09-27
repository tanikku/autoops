import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { PlanCards } from "@/components/plan-cards";
import { mayOfferPurchase, readPricingView } from "@/lib/billing/pricing";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";

/**
 * What each plan allows, and what a smaller allowance would mean.
 *
 * **Nothing on this page buys anything.** The server can start a checkout and
 * deliberately is not asked to: `app/dashboard/billing/actions.ts` is not
 * imported here, the buttons are disabled, and no provider is reached. What the
 * page is for is the part of buying that has to be understood before it happens
 * — how many workers a plan allows, and what becomes of the ones already
 * running.
 *
 * **A server component with no state.** There is no selection to hold and no
 * form to submit; the whole screen is two numbers and a catalogue. Making it a
 * client component would add a boundary for nothing to cross.
 *
 * **Read-only.** `requireUserId` authenticates without provisioning — a page
 * view must not write the account row, and nothing here needs it to exist.
 */
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
            {view.current.kind === "none"
              ? t(language, "pricing.current.none")
              : view.current.kind === "unreadable"
                ? t(language, "pricing.current.unreadable")
                : t(language, "pricing.current.onPlan", {
                    plan: view.current.plan,
                  })}
          </p>
          {/* The count every guardrail sentence below refers to, said once. */}
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t(language, "pricing.current.activeWorkers", {
              count: view.activeWorkers,
            })}
          </p>
        </section>

        {offerPurchase ? (
          <PlanCards
            plans={view.plans}
            activeWorkers={view.activeWorkers}
            language={language}
          />
        ) : (
          /* **Somebody already paying is not shown a plan to buy.** Offering one
             would be offering them a second subscription; what they need is a way
             to change or cancel the one they have, and that is not built yet — so
             the page says so rather than implying a control exists. */
          <section className="mt-10 border-t border-border pt-8">
            <h2 className="text-lg font-medium tracking-tight">
              {t(language, "pricing.managed.heading")}
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              {t(language, "pricing.managed.description")}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
