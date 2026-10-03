"use client";

import { useState } from "react";
import {
  type StartCheckoutActionResult,
  startCheckoutAction,
} from "@/app/dashboard/billing/actions";
import type { CheckoutAttemptPlan } from "@/lib/billing/checkout-attempt";
import { Button } from "@/components/ui/button";

/**
 * The one control that starts a purchase.
 *
 * **A client component for one reason: pressing it has stages.** A press may be
 * answered with a question rather than an address, and until that question is
 * answered there is something on screen that the server did not render. The page
 * around it stays where it was — the plans, the prices, the guardrail and who is
 * allowed to buy are all still worked out on the server and handed over as
 * finished values.
 *
 * **The words arrive already translated**, the way `DashboardNavLinks` takes its
 * three labels. Handing over a language instead would make this call `t()`, and
 * that pulls both dictionaries — every string in the product — into the browser
 * bundle of a page that needs a dozen of them.
 *
 * **What crosses the boundary is a plan id and some sentences.** Not an account
 * id, not an address, not a price, not a customer, not anything the provider
 * gave us. The action takes the account from the session for itself, so there is
 * nothing this component could send that would make it act for somebody else.
 *
 * **The decisions are pure and exported**, which is what lets them be tested at
 * all: there is no DOM in this project's test environment, so a button whose
 * rules lived in its event handlers would have no way to prove that a second
 * click is ignored or that an acknowledgement is only ever sent after somebody
 * agreed to something. `press`, `proceed`, `confirm`, `cancel` and `receive` below are the
 * whole of the behaviour, and the component is a `useState` around them.
 */

/** Which sentence a refusal gets. One per outcome a browser may be told about. */
export type CheckoutMessage =
  | "planSwitch"
  | "billingManagement"
  | "paymentProcessing"
  | "providerUnavailable"
  | "unavailable"
  | "invalidRequest";

/**
 * What the button is doing.
 *
 * **`working` covers both waiting and leaving.** The action is in flight, or it
 * answered with an address and the browser is on its way there; in both cases
 * the one thing that must not happen is a second press, so they are one state
 * rather than two that need the same guard.
 */
export type CheckoutStep =
  | { readonly kind: "idle" }
  | { readonly kind: "terms" }
  | { readonly kind: "working" }
  | {
      readonly kind: "over-limit";
      readonly activeWorkers: number;
      readonly activeWorkerLimit: number;
    }
  | { readonly kind: "message"; readonly message: CheckoutMessage };

/**
 * What a press asks for, if anything.
 *
 * `request` is `null` when nothing should be sent — which is how a second click
 * and a cancelled confirmation are both expressed.
 */
export type CheckoutMove = {
  readonly step: CheckoutStep;
  readonly request: { readonly overLimitAcknowledged: boolean } | null;
};

const IDLE: CheckoutStep = { kind: "idle" };

/**
 * Pressing the button itself.
 *
 * **Asks the server nothing.** It opens the purchase terms; only `proceed`, from
 * those terms, sends a request — so no checkout is ever opened for somebody who
 * has not been shown what they are agreeing to.
 *
 * **A press while working is not a press.** The server's own coordination is
 * what actually stops two subscriptions — one `CheckoutAttempt` per account — but
 * a second request that the server then has to refuse is still a second request,
 * and the reader gets nothing out of making it.
 */
export function press(step: CheckoutStep): CheckoutMove {
  if (step.kind === "working") {
    return { step, request: null };
  }

  return { step: { kind: "terms" }, request: null };
}

/**
 * Continuing from the purchase terms.
 *
 * **Never acknowledges anything.** The first ask is always the unacknowledged
 * one: the flag exists to record that somebody was shown what a smaller
 * allowance would do and said yes anyway, and having read the purchase terms is
 * not that. Only `confirm` can send `true`.
 */
export function proceed(step: CheckoutStep): CheckoutMove {
  if (step.kind !== "terms") {
    return { step, request: null };
  }

  return { step: { kind: "working" }, request: { overLimitAcknowledged: false } };
}

/**
 * Agreeing to the over-limit explanation.
 *
 * **Only reachable from the state the server put us in.** `true` is sent when,
 * and only when, the orchestration asked for confirmation and the reader agreed —
 * so the flag cannot be produced by pressing the button twice, by a stale render,
 * or by anything a page decided for itself. From any other state this asks for
 * nothing.
 */
export function confirm(step: CheckoutStep): CheckoutMove {
  if (step.kind !== "over-limit") {
    return { step, request: null };
  }

  return { step: { kind: "working" }, request: { overLimitAcknowledged: true } };
}

/**
 * Declining it, or going back from the purchase terms.
 *
 * Nothing is sent and nothing is left on screen: no attempt was opened by the
 * question, so there is nothing to close.
 */
export function cancel(): CheckoutMove {
  return { step: IDLE, request: null };
}

/** Where the browser should go, if the action gave somewhere to go. */
export type CheckoutOutcome = {
  readonly step: CheckoutStep;
  readonly url: string | null;
};

/**
 * What an answer from the action means on screen.
 *
 * **The address is used and not inspected.** It is the one the action returned
 * for the session that asked, built on the server from the server's own
 * configuration; a component that re-derived what a valid checkout address looks
 * like would be a second opinion about it, and the wrong one the first time the
 * provider changed a host.
 *
 * **`checkout-ready` stays `working`.** The browser is leaving, and a button that
 * became pressable again in the meantime would be a button somebody could press
 * on the way out.
 */
export function receive(result: StartCheckoutActionResult): CheckoutOutcome {
  switch (result.outcome) {
    case "checkout-ready":
      return { step: { kind: "working" }, url: result.url };

    case "over-limit-confirmation-required":
      return {
        step: {
          kind: "over-limit",
          activeWorkers: result.activeWorkers,
          activeWorkerLimit: result.activeWorkerLimit,
        },
        url: null,
      };

    case "plan-switch-required":
      return { step: { kind: "message", message: "planSwitch" }, url: null };

    case "billing-management-required":
      // **One sentence for all four reasons.** Which of them it is says
      // something about the account's payments, and the answer for a reader is
      // the same either way: this screen cannot do it yet.
      return {
        step: { kind: "message", message: "billingManagement" },
        url: null,
      };

    case "payment-processing":
      return {
        step: { kind: "message", message: "paymentProcessing" },
        url: null,
      };

    case "provider-verification-unavailable":
      return {
        step: { kind: "message", message: "providerUnavailable" },
        url: null,
      };

    case "invalid-request":
      return { step: { kind: "message", message: "invalidRequest" }, url: null };

    default:
      return { step: { kind: "message", message: "unavailable" }, url: null };
  }
}

/** A call that did not come back at all: the same answer as one that failed. */
export function fail(): CheckoutStep {
  return { kind: "message", message: "unavailable" };
}

/** Every word this component may put on screen, already in the right language. */
export type CheckoutPlanLabels = {
  /** What the button says when it can be pressed. */
  readonly choose: string;
  /** What it says when the purchase path is not open to this account. */
  readonly unavailable: string;
  readonly pending: string;
  readonly confirmHeading: string;
  readonly confirmAccept: string;
  readonly confirmCancel: string;
  /**
   * The over-limit sentences, with `{active}` and `{limit}` still in them.
   *
   * Filled here because the numbers come from the server's answer rather than
   * from the count the page was rendered with — which is the point of asking the
   * server in the first place.
   */
  readonly overLimit: readonly string[];
  readonly messages: Readonly<Record<CheckoutMessage, string>>;
  readonly purchase: PurchaseTermsLabels;
};

type LabelledLink = { readonly href: string; readonly label: string };

/** The purchase terms, already in the right language, links included. */
export type PurchaseTermsLabels = {
  readonly heading: string;
  readonly items: readonly { readonly term: string; readonly detail: string }[];
  /** What buying does to a running trial; `null` when no trial is running. */
  readonly trialNotice: string | null;
  readonly termsLink: LabelledLink;
  readonly legalLink: LabelledLink;
  readonly proceed: string;
  readonly back: string;
};

/**
 * The purchase terms, shown between choosing a plan and asking the server.
 *
 * **The links open beside the terms**, so reading them does not throw away the
 * step somebody is on.
 */
export function PurchaseTerms({
  labels,
  onProceed,
  onBack,
}: {
  readonly labels: PurchaseTermsLabels;
  readonly onProceed?: () => void;
  readonly onBack?: () => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
      <p className="text-xs font-medium">{labels.heading}</p>
      <dl className="mt-2 space-y-2 text-xs">
        {labels.items.map((item) => (
          <div key={item.term}>
            <dt className="font-medium">{item.term}</dt>
            <dd className="mt-0.5 text-muted-foreground">{item.detail}</dd>
          </div>
        ))}
      </dl>
      {labels.trialNotice !== null ? (
        <p className="mt-3 text-xs">{labels.trialNotice}</p>
      ) : null}
      <p className="mt-3 text-xs">
        {[labels.termsLink, labels.legalLink].map((link, index) => (
          <span key={link.href}>
            {index > 0 ? " · " : null}
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              {link.label}
            </a>
          </span>
        ))}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onProceed}>
          {labels.proceed}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          {labels.back}
        </Button>
      </div>
    </div>
  );
}

/**
 * Puts the server's numbers into a sentence the server wrote.
 *
 * **Not a second translator.** The dictionary decided where the numbers go and
 * what surrounds them; this only fills the holes, using the same `{name}`
 * convention `lib/i18n` uses. Importing that module's filler instead would import
 * the module, and with it both dictionaries.
 */
function fillLabel(
  template: string,
  values: Readonly<Record<string, number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in values ? String(values[name]) : placeholder,
  );
}

export function CheckoutPlanButton({
  plan,
  enabled,
  labels,
}: {
  readonly plan: CheckoutAttemptPlan;
  readonly enabled: boolean;
  readonly labels: CheckoutPlanLabels;
}) {
  const [step, setStep] = useState<CheckoutStep>(IDLE);

  async function send(move: CheckoutMove) {
    setStep(move.step);

    if (move.request === null) {
      return;
    }

    try {
      const outcome = receive(
        await startCheckoutAction({
          plan,
          overLimitAcknowledged: move.request.overLimitAcknowledged,
        }),
      );

      setStep(outcome.step);

      if (outcome.url !== null) {
        window.location.assign(outcome.url);
      }
    } catch {
      // **The category is the server's to log.** A rejection here is a request
      // that did not complete; there is nothing in it a reader could act on that
      // "not right now" does not already say.
      setStep(fail());
    }
  }

  const working = step.kind === "working";

  return (
    <div className="mt-5">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={!enabled || working}
        onClick={() => void send(press(step))}
      >
        {!enabled
          ? labels.unavailable
          : working
            ? labels.pending
            : labels.choose}
      </Button>

      {step.kind === "terms" ? (
        <PurchaseTerms
          labels={labels.purchase}
          onProceed={() => void send(proceed(step))}
          onBack={() => setStep(cancel().step)}
        />
      ) : null}

      {step.kind === "over-limit" ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-xs font-medium">{labels.confirmHeading}</p>
          {labels.overLimit.map((sentence) => {
            const text = fillLabel(sentence, {
              active: step.activeWorkers,
              limit: step.activeWorkerLimit,
            });

            return (
              <p key={sentence} className="mt-1.5 text-xs text-muted-foreground">
                {text}
              </p>
            );
          })}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void send(confirm(step))}
            >
              {labels.confirmAccept}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setStep(cancel().step)}
            >
              {labels.confirmCancel}
            </Button>
          </div>
        </div>
      ) : null}

      {step.kind === "message" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {labels.messages[step.message]}
        </p>
      ) : null}
    </div>
  );
}
