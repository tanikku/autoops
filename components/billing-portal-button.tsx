"use client";

import { useRef, useState } from "react";
import {
  type OpenBillingPortalActionResult,
  openBillingPortalAction,
} from "@/app/dashboard/billing/portal-actions";
import { Button } from "@/components/ui/button";

/**
 * The one control that opens the provider's billing portal.
 *
 * **The same shape as `CheckoutPlanButton`**: the rules are pure functions this
 * component is a `useState` around, because there is no DOM in this project's
 * tests to click with. The words arrive already translated, and nothing crosses
 * from the page but a boolean and those words.
 */

export type PortalMessage = "notEligible" | "unavailable";

/** `working` covers both waiting and leaving, as it does for checkout. */
export type PortalStep =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "message"; readonly message: PortalMessage };

const IDLE: PortalStep = { kind: "idle" };

/**
 * Pressing the button. **A press while working is not a press**, which is what
 * keeps a double click from asking the provider for two sessions.
 */
export function press(step: PortalStep): {
  readonly step: PortalStep;
  readonly send: boolean;
} {
  if (step.kind === "working") {
    return { step, send: false };
  }

  return { step: { kind: "working" }, send: true };
}

/**
 * What an answer means on screen. **The address is used and not inspected**:
 * the server checked it before handing it over.
 */
export function receive(result: OpenBillingPortalActionResult): {
  readonly step: PortalStep;
  readonly url: string | null;
} {
  switch (result.outcome) {
    case "portal-ready":
      return { step: { kind: "working" }, url: result.url };
    case "not-eligible":
      return { step: { kind: "message", message: "notEligible" }, url: null };
    default:
      return { step: { kind: "message", message: "unavailable" }, url: null };
  }
}

/** A call that did not come back at all: the same answer as one that failed. */
export function fail(): PortalStep {
  return { kind: "message", message: "unavailable" };
}

export type BillingPortalLabels = {
  readonly manage: string;
  /** What it says when the portal is not open to this account yet. */
  readonly unavailable: string;
  readonly pending: string;
  readonly messages: Readonly<Record<PortalMessage, string>>;
};

export function BillingPortalButton({
  enabled,
  labels,
}: {
  readonly enabled: boolean;
  readonly labels: BillingPortalLabels;
}) {
  const [step, setStep] = useState<PortalStep>(IDLE);
  // Two clicks inside one frame both see the `idle` they were rendered with;
  // this is what stops the second of them before the button has re-rendered.
  const inFlight = useRef(false);

  async function open() {
    const move = press(inFlight.current ? { kind: "working" } : step);

    setStep(move.step);

    if (!move.send) {
      return;
    }

    inFlight.current = true;

    try {
      const outcome = receive(await openBillingPortalAction());

      setStep(outcome.step);

      if (outcome.url !== null) {
        // Left set: the browser is leaving, and a press on the way out is not one.
        window.location.assign(outcome.url);
        return;
      }
    } catch {
      setStep(fail());
    }

    inFlight.current = false;
  }

  const working = step.kind === "working";

  return (
    <div className="mt-5">
      <Button
        type="button"
        variant="outline"
        disabled={!enabled || working}
        onClick={() => void open()}
      >
        {!enabled ? labels.unavailable : working ? labels.pending : labels.manage}
      </Button>

      {step.kind === "message" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {labels.messages[step.message]}
        </p>
      ) : null}
    </div>
  );
}
