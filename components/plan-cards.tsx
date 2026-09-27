import { TriangleAlert } from "lucide-react";
import type { PricedPlan, PlanStanding } from "@/lib/billing/pricing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { t } from "@/lib/i18n";

/**
 * The three plans, and what a lower allowance would mean for workers already
 * running.
 *
 * **Nothing here can be bought.** The buttons are disabled and say so: a control
 * that looks pressable and does nothing is worse than one that is plainly not
 * ready. The purchase path exists on the server and is deliberately not wired to
 * anything yet.
 *
 * **A server component, because there is nothing to hold.** No selection, no
 * confirmation, no pending state — the whole screen is a reading of two numbers
 * and a catalogue. The acknowledgement a purchase will need is not here either:
 * a checkbox whose value nothing consumes is a promise the page cannot keep.
 *
 * **The guardrail is the point of the page as much as the prices are.** An
 * account running more workers than a plan allows can still buy it, and what
 * matters is that they know what does and does not happen — so the wording leads
 * with "nothing stops" and only then says what is restricted.
 */

/**
 * Which key names each plan.
 *
 * **Written out rather than built from the id.** `t` takes a key it can check at
 * compile time, and a template would defeat that — a plan added without a name
 * would then be a missing string on a screen instead of a build failure.
 */
const PLAN_NAME_KEYS = {
  lite: "pricing.plan.lite",
  standard: "pricing.plan.standard",
  pro: "pricing.plan.pro",
} as const;

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

export function PlanCards({
  plans,
  activeWorkers,
  language,
}: {
  plans: readonly PricedPlan[];
  activeWorkers: number;
  language: string;
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
                {t(language, PLAN_NAME_KEYS[plan.id])}
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

            {/* **Disabled, and the label says why.** Nothing is wired to a
                purchase; a button that looked ready would be the page claiming
                something the server has not been asked to do. */}
            <Button
              type="button"
              variant="outline"
              className="mt-5 w-full"
              disabled
            >
              {t(language, "pricing.cta.comingSoon")}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
