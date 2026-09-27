import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import {
  CheckoutReturnStatusPanel,
  type CheckoutReturnLabels,
} from "@/components/checkout-return-status";
import { planNameKey } from "@/lib/billing/plan-labels";
import { checkoutAttemptPlans } from "@/lib/billing/checkout-attempt";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";

/**
 * Where a payment page sends somebody back to.
 *
 * **It exists because arriving here is not the same as owning a plan.** The
 * provider redirects when the card clears; the entitlement is written afterwards
 * by a reconciliation run, which production measured at 52 seconds and which a
 * five-minute cron cadence bounds. Both return addresses used to be `/dashboard`,
 * so for the length of that window somebody who had just paid was shown a product
 * that knew nothing about it — and the plans page, correctly reading the row,
 * told them their subscription had ended. That is F-90, and this page is the part
 * of the fix that a person sees.
 *
 * **Nothing here reads the provider and nothing here writes.** `requireUserId`
 * authenticates without provisioning; the waiting is done against Koqentra's own
 * rows, by a server action that takes no arguments.
 *
 * **No purchase is offered on this page, in any state.** Somebody whose payment
 * has not appeared yet is the last person who should be shown a way to pay again.
 *
 * **The query string is not read.** The provider appends nothing this page needs
 * and `{CHECKOUT_SESSION_ID}` is deliberately not requested, so there is no
 * parameter here to trust or to mistrust.
 */
export async function generateMetadata(): Promise<Metadata> {
  const language = await getDocumentLanguage();

  return {
    title: t(language, "checkout.return.title"),
    description: t(language, "checkout.return.description"),
  };
}

/**
 * Every plan's own name, so a filled sentence never shows a stored id.
 *
 * Only the three that can be bought: this page is reached from a payment, and a
 * status naming `beta` or `trial` is not one it treats as a purchase landing.
 */
function planNames(language: string): Record<string, string> {
  const names: Record<string, string> = {};

  for (const plan of checkoutAttemptPlans) {
    const key = planNameKey(plan);

    if (key !== null) {
      names[plan] = t(language, key);
    }
  }

  return names;
}

function labelsFor(language: string): CheckoutReturnLabels {
  return {
    pendingHeading: t(language, "checkout.return.pending.heading"),
    pendingBody: t(language, "checkout.return.pending.body"),
    pendingPatience: t(language, "checkout.return.pending.patience"),
    activeHeading: t(language, "checkout.return.active.heading"),
    activeBody: t(language, "checkout.return.active.body"),
    notEntitledHeading: t(language, "checkout.return.notEntitled.heading"),
    notEntitledBody: t(language, "checkout.return.notEntitled.body"),
    timedOutHeading: t(language, "checkout.return.timedOut.heading"),
    timedOutBody: t(language, "checkout.return.timedOut.body"),
    goToPlans: t(language, "checkout.return.goToPlans"),
    planNames: planNames(language),
  };
}

export default async function BillingReturnPage() {
  const userId = await requireUserId();
  const language = await getUserLanguage(userId);

  return (
    <div className="flex min-h-dvh flex-col">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "checkout.return.title")}
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          {t(language, "checkout.return.description")}
        </p>

        <CheckoutReturnStatusPanel labels={labelsFor(language)} />
      </main>
    </div>
  );
}
