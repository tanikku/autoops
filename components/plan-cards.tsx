import { TriangleAlert } from "lucide-react";
import { planNameKeyFor } from "@/lib/billing/plan-labels";
import type { PricedPlan, PlanStanding } from "@/lib/billing/pricing";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  CheckoutPlanButton,
  type CheckoutPlanLabels,
} from "@/components/checkout-plan-button";
import { t } from "@/lib/i18n";

/**
 * The three plans, and what a lower allowance would mean for workers already
 * running.
 *
 * **Whether anything here can be bought is decided elsewhere and arrives as a
 * boolean.** While the purchase path is being proved against a sandbox it is open
 * to one account; every other reader gets the button they had before, disabled and
 * saying so, because a control that looks pressable and does nothing is worse than
 * one that is plainly not ready. The decision is the server's — see
 * `lib/billing/checkout-sandbox-server.ts` — and a page cannot enforce it anyway.
 *
 * **Still a server component.** The one part with stages of its own is the button,
 * which is its own client component; the cards, the prices, the allowances and the
 * guardrail are a reading of two numbers and a catalogue, and keeping them here is
 * what stops the dictionaries reaching the browser.
 *
 * **The guardrail is the point of the page as much as the prices are.** An
 * account running more workers than a plan allows can still buy it, and what
 * matters is that they know what does and does not happen — so the wording leads
 * with "nothing stops" and only then says what is restricted.
 */

/** One allowance line, as a plan card lists it. */
function allowanceLines(plan: PricedPlan, language: string): string[] {
  const { definition } = plan;
  const lines = [
    t(language, "pricing.allowance.activeWorkers", {
      limit: definition.activeWorkerLimit,
    }),
    t(language, "pricing.allowance.aiProcessing", {
      limit: definition.aiProcessingLimit,
    }),
    t(language, "pricing.allowance.manualRun", {
      limit: definition.manualRunLimit,
    }),
    t(language, "pricing.allowance.discovery", {
      limit: definition.discoveryLimit,
    }),
    t(
      language,
      definition.email === "one-worker"
        ? "pricing.allowance.emailOneWorker"
        : "pricing.allowance.emailAllWorkers",
    ),
  ];

  // **Only a plan measured in days says how many.** A trial's history is its own
  // length, and no plan sold here is a trial — but reading the shape rather than
  // assuming it is what keeps that true if one ever is.
  if (definition.history.kind === "days") {
    lines.push(
      t(language, "pricing.allowance.historyDays", {
        days: definition.history.days,
      }),
    );
  }

  return lines;
}

function standingBadge(standing: PlanStanding, language: string) {
  if (standing === "below-limit") {
    return null;
  }

  return (
    <Badge variant={standing === "over-limit" ? "destructive" : "outline"}>
      {t(
        language,
        standing === "over-limit"
          ? "pricing.standing.overLimit"
          : "pricing.standing.atLimit",
      )}
    </Badge>
  );
}

/**
 * What would happen to the workers this account already runs.
 *
 * **Nothing at all, on every plan whose allowance is not smaller.** The notice
 * appears only where there is something to say, so a reader who sees one knows
 * it concerns them.
 */
function guardrailNotice({
  plan,
  activeWorkers,
  language,
}: {
  plan: PricedPlan;
  activeWorkers: number;
  language: string;
}) {
  if (plan.standing === "below-limit") {
    return null;
  }

  const limit = plan.definition.activeWorkerLimit;

  if (plan.standing === "at-limit") {
    return (
      <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {t(language, "pricing.guardrail.atLimit.title")}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t(language, "pricing.guardrail.atLimit.body", {
            active: activeWorkers,
            limit,
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {t(language, "pricing.guardrail.overLimit.title")}
      </p>
      {/* **Three sentences in this order, deliberately.** What keeps running,
          then what is restricted, then how to lift it. A reader who stops after
          the first has the answer that matters most. */}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t(language, "pricing.guardrail.overLimit.keepsRunning", {
          active: activeWorkers,
          limit,
        })}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t(language, "pricing.guardrail.overLimit.restricted", { limit })}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t(language, "pricing.guardrail.overLimit.recovery", { limit })}
      </p>
    </div>
  );
}

/**
 * Every word the button may show, looked up here.
 *
 * **The over-limit sentences are the card's own three**, handed over with their
 * placeholders intact: the numbers that go in them come from the server's answer
 * to the press rather than from the count this page was rendered with, which may
 * have moved in between. Saying it twice in two wordings is what this avoids.
 */
function checkoutLabels(plan: PricedPlan, language: string): CheckoutPlanLabels {
  return {
    choose: t(language, "pricing.cta.choose", {
      plan: t(language, planNameKeyFor(plan.id)),
    }),
    unavailable: t(language, "pricing.cta.comingSoon"),
    pending: t(language, "checkout.pending"),
    confirmHeading: t(language, "checkout.confirm.heading"),
    confirmAccept: t(language, "checkout.confirm.accept"),
    confirmCancel: t(language, "checkout.confirm.cancel"),
    overLimit: [
      t(language, "pricing.guardrail.overLimit.keepsRunning"),
      t(language, "pricing.guardrail.overLimit.restricted"),
      t(language, "pricing.guardrail.overLimit.recovery"),
    ],
    messages: {
      planSwitch: t(language, "checkout.message.planSwitch"),
      billingManagement: t(language, "checkout.message.billingManagement"),
      paymentProcessing: t(language, "checkout.message.paymentProcessing"),
      providerUnavailable: t(language, "checkout.message.providerUnavailable"),
      unavailable: t(language, "checkout.message.unavailable"),
      invalidRequest: t(language, "checkout.message.invalidRequest"),
    },
  };
}

export function PlanCards({
  plans,
  activeWorkers,
  language,
  checkoutEnabled,
  purchasable = true,
}: {
  plans: readonly PricedPlan[];
  activeWorkers: number;
  language: string;
  /** Whether this account may start a checkout at all. Decided on the server. */
  checkoutEnabled: boolean;
  /**
   * Whether these plans are on sale to this account at all. When not, the
   * cards are a price list: no purchase button is rendered, not even a
   * disabled one.
   */
  purchasable?: boolean;
}) {
  return (
    /* Three across from `lg`, one column on a phone. The middle card carries a
       heavier border and nothing else: no claim about what is popular, because
       no number here supports one. */
    <div className="mt-6 grid gap-4 lg:grid-cols-3">
      {plans.map((plan) => (
        <Card
          key={plan.id}
          className={plan.id === "standard" ? "border-foreground/20" : undefined}
        >
          <CardContent>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-base font-semibold tracking-tight">
                {t(language, planNameKeyFor(plan.id))}
              </h3>
              {standingBadge(plan.standing, language)}
            </div>

            <p className="mt-2 text-xl font-semibold tracking-tight">
              {t(language, "pricing.price.monthly", {
                amount: plan.monthlyYen.toLocaleString("en-US"),
              })}
            </p>

            <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
              {allowanceLines(plan, language).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            {guardrailNotice({ plan, activeWorkers, language })}

            {/* **The plan id and some sentences, and nothing else.** No account,
                no price, no customer: the action takes who is asking from the
                session, so there is nothing here that could make it act for
                somebody else. */}
            {purchasable ? (
              <CheckoutPlanButton
                plan={plan.id}
                enabled={checkoutEnabled}
                labels={checkoutLabels(plan, language)}
              />
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
