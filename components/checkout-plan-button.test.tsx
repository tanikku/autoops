import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The one control that starts a purchase.
 *
 * **There is no DOM in this project's tests, and that shaped the component.**
 * Nothing here can click anything, so the rules that matter — a second press is
 * ignored, an acknowledgement is only sent after somebody agreed to something, a
 * cancelled question sends nothing — are pure functions the component is a
 * wrapper around. They are tested as functions; the markup is tested as markup.
 *
 * **What is fixed here is mostly an absence.** A session id, an attempt id, a
 * price, a customer, a provider's own words: none of them may appear on a page,
 * and several of the tests below say so about the rendered HTML.
 */

vi.mock("@/app/dashboard/billing/actions", () => ({
  startCheckoutAction: vi.fn(),
}));

const {
  CheckoutPlanButton,
  PurchaseTerms,
  cancel,
  confirm,
  fail,
  press,
  proceed,
  receive,
} = await import("@/components/checkout-plan-button");

type Labels = Parameters<typeof CheckoutPlanButton>[0]["labels"];

const LABELS: Labels = {
  choose: "CHOOSE-LABEL",
  unavailable: "UNAVAILABLE-LABEL",
  pending: "PENDING-LABEL",
  confirmHeading: "CONFIRM-HEADING",
  confirmAccept: "CONFIRM-ACCEPT",
  confirmCancel: "CONFIRM-CANCEL",
  overLimit: [
    "{active} active, {limit} allowed.",
    "RESTRICTED-{limit}",
    "RECOVERY-{limit}",
  ],
  messages: {
    planSwitch: "PLAN-SWITCH-MESSAGE",
    billingManagement: "BILLING-MANAGEMENT-MESSAGE",
    paymentProcessing: "PAYMENT-PROCESSING-MESSAGE",
    providerUnavailable: "PROVIDER-UNAVAILABLE-MESSAGE",
    unavailable: "UNAVAILABLE-MESSAGE",
    invalidRequest: "INVALID-REQUEST-MESSAGE",
  },
  purchase: {
    heading: "TERMS-HEADING",
    items: [
      { term: "TERM-A", detail: "DETAIL-A" },
      { term: "TERM-B", detail: "DETAIL-B" },
    ],
    trialNotice: null,
    termsLink: { href: "/terms?lang=en", label: "TERMS-LINK" },
    legalLink: { href: "/legal?lang=en", label: "LEGAL-LINK" },
    proceed: "PROCEED-LABEL",
    back: "BACK-LABEL",
  },
};

const render = (enabled: boolean) =>
  renderToStaticMarkup(
    <CheckoutPlanButton plan="lite" enabled={enabled} labels={LABELS} />,
  );

describe("whether it can be pressed", () => {
  it("is disabled and says so when the purchase path is not open", () => {
    const html = render(false);

    // The attribute, not the `disabled:` variants in the class list.
    expect(html).toContain('disabled=""');
    expect(html).toContain("UNAVAILABLE-LABEL");
    expect(html).not.toContain("CHOOSE-LABEL");
  });

  it("offers the plan when it is", () => {
    const html = render(true);

    expect(html).toContain("CHOOSE-LABEL");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("UNAVAILABLE-LABEL");
  });

  /** Nothing is on screen until somebody presses it. */
  it("shows no question and no message to begin with", () => {
    const html = render(true);

    expect(html).not.toContain("CONFIRM-HEADING");
    expect(html).not.toContain("TERMS-HEADING");
    expect(html).not.toContain("PROCEED-LABEL");
    expect(html).not.toContain("MESSAGE");
    expect(html).not.toContain("PENDING-LABEL");
  });
});

/**
 * Pressing it.
 *
 * **A press asks the server nothing.** It opens the purchase terms; the request
 * is only sent from there, so no checkout is opened for somebody who has not
 * been shown what they are agreeing to.
 */
describe("the first press", () => {
  it("opens the purchase terms and sends nothing", () => {
    expect(press({ kind: "idle" })).toEqual({
      step: { kind: "terms" },
      request: null,
    });
  });

  it.each([
    { kind: "message", message: "unavailable" } as const,
    { kind: "over-limit", activeWorkers: 3, activeWorkerLimit: 2 } as const,
    { kind: "terms" } as const,
  ])("opens the terms again from %o without sending anything", (step) => {
    expect(press(step)).toEqual({ step: { kind: "terms" }, request: null });
  });
});

/**
 * Continuing from the purchase terms: the only press that reaches the server
 * without an acknowledgement having been asked for.
 *
 * **It never acknowledges anything.** The flag records that somebody was shown
 * what a smaller allowance would do and said yes anyway; having read the
 * purchase terms is not that.
 */
describe("continuing from the terms", () => {
  it("asks for a checkout without acknowledging anything", () => {
    expect(proceed({ kind: "terms" })).toEqual({
      step: { kind: "working" },
      request: { overLimitAcknowledged: false },
    });
  });

  it.each([
    { kind: "idle" } as const,
    { kind: "working" } as const,
    { kind: "message", message: "unavailable" } as const,
    { kind: "over-limit", activeWorkers: 3, activeWorkerLimit: 2 } as const,
  ])("asks for nothing from %o", (step) => {
    expect(proceed(step)).toEqual({ step, request: null });
  });

  it("goes back to the plain button without sending anything", () => {
    expect(cancel()).toEqual({ step: { kind: "idle" }, request: null });
  });
});

/**
 * Whole purchases, step by step, as the component drives them: every request
 * that would reach `startCheckoutAction` is a `request` that is not `null`.
 */
describe("a purchase from start to finish", () => {
  const READY = {
    outcome: "checkout-ready",
    url: "https://pay.example.invalid/1",
    standing: "below-limit",
  } as const;

  it("goes terms, one request, then the address", () => {
    const pressed = press({ kind: "idle" });
    const continued = proceed(pressed.step);
    const answered = receive(READY);

    expect(pressed.request).toBeNull();
    expect(continued.request).toEqual({ overLimitAcknowledged: false });
    expect(answered.url).toBe("https://pay.example.invalid/1");
  });

  it("goes terms, the over-limit question, then one acknowledged request", () => {
    const pressed = press({ kind: "idle" });
    const continued = proceed(pressed.step);
    const asked = receive({
      outcome: "over-limit-confirmation-required",
      activeWorkers: 5,
      activeWorkerLimit: 2,
    });
    const confirmed = confirm(asked.step);
    const answered = receive({ ...READY, standing: "over-limit" });

    expect(pressed.request).toBeNull();
    expect(continued.request).toEqual({ overLimitAcknowledged: false });
    expect(asked).toEqual({
      step: { kind: "over-limit", activeWorkers: 5, activeWorkerLimit: 2 },
      url: null,
    });
    // **No second look at the terms.** They were read in this same purchase.
    expect(confirmed).toEqual({
      step: { kind: "working" },
      request: { overLimitAcknowledged: true },
    });
    expect(answered.url).toBe("https://pay.example.invalid/1");
  });

  it("sends nothing at all when somebody goes back from the terms", () => {
    const pressed = press({ kind: "idle" });
    const back = cancel();

    expect([pressed.request, back.request]).toEqual([null, null]);
    expect(proceed(back.step).request).toBeNull();
  });
});

/**
 * **A second press is not a second request.** The server's own coordination is
 * what actually stops two subscriptions; a request it then has to refuse is still
 * a request, and the reader gets nothing out of making it.
 */
describe("pressing it again while it works", () => {
  it("asks for nothing", () => {
    expect(press({ kind: "working" })).toEqual({
      step: { kind: "working" },
      request: null,
    });
  });

  it("leaves the state exactly as it was", () => {
    const working = { kind: "working" } as const;

    expect(press(working).step).toBe(working);
  });
});

/**
 * Agreeing to the over-limit explanation.
 *
 * **`true` is reachable from one state only.** It cannot be produced by pressing
 * the button twice, by a stale render, or by anything a page decided for itself.
 */
describe("confirming", () => {
  it("acknowledges when the server asked for it", () => {
    expect(
      confirm({ kind: "over-limit", activeWorkers: 3, activeWorkerLimit: 2 }),
    ).toEqual({
      step: { kind: "working" },
      request: { overLimitAcknowledged: true },
    });
  });

  it.each([
    { kind: "idle" } as const,
    { kind: "terms" } as const,
    { kind: "working" } as const,
    { kind: "message", message: "unavailable" } as const,
  ])("acknowledges nothing from %o", (step) => {
    expect(confirm(step)).toEqual({ step, request: null });
  });

  /** The only acknowledging transition in the component. */
  it("is the only way an acknowledgement is produced", () => {
    const asks = [
      press({ kind: "idle" }),
      press({ kind: "working" }),
      press({ kind: "over-limit", activeWorkers: 3, activeWorkerLimit: 2 }),
      proceed({ kind: "terms" }),
      proceed({ kind: "over-limit", activeWorkers: 3, activeWorkerLimit: 2 }),
      cancel(),
      confirm({ kind: "idle" }),
      confirm({ kind: "terms" }),
    ];

    for (const ask of asks) {
      expect(ask.request?.overLimitAcknowledged ?? false).toBe(false);
    }
  });
});

describe("cancelling", () => {
  it("asks for nothing and clears the question", () => {
    expect(cancel()).toEqual({ step: { kind: "idle" }, request: null });
  });
});

/**
 * What an answer from the action means on screen.
 *
 * Each outcome the action can return gets exactly one of: somewhere to go, a
 * question, or a sentence. Nothing is left to a default that happened to be safe.
 */
describe("reading the answer", () => {
  it("takes the address it was given", () => {
    expect(
      receive({
        outcome: "checkout-ready",
        url: "https://pay.example.invalid/1",
        standing: "below-limit",
      }),
    ).toEqual({
      step: { kind: "working" },
      url: "https://pay.example.invalid/1",
    });
  });

  /** Still working: the browser is leaving, and a pressable button on the way
   * out is a button somebody can press. */
  it("stays busy while the browser leaves", () => {
    expect(
      receive({
        outcome: "checkout-ready",
        url: "https://pay.example.invalid/1",
        standing: "over-limit",
      }).step,
    ).toEqual({ kind: "working" });
  });

  it("turns the over-limit question into the question", () => {
    expect(
      receive({
        outcome: "over-limit-confirmation-required",
        activeWorkers: 5,
        activeWorkerLimit: 2,
      }),
    ).toEqual({
      step: { kind: "over-limit", activeWorkers: 5, activeWorkerLimit: 2 },
      url: null,
    });
  });

  it.each([
    [{ outcome: "plan-switch-required", currentPlan: "standard" }, "planSwitch"],
    [
      { outcome: "billing-management-required", reason: "already-subscribed" },
      "billingManagement",
    ],
    [
      { outcome: "billing-management-required", reason: "payment-behind" },
      "billingManagement",
    ],
    [
      { outcome: "billing-management-required", reason: "cancelling" },
      "billingManagement",
    ],
    [
      {
        outcome: "billing-management-required",
        reason: "provider-subscription-live",
      },
      "billingManagement",
    ],
    [{ outcome: "payment-processing" }, "paymentProcessing"],
    [{ outcome: "provider-verification-unavailable" }, "providerUnavailable"],
    [{ outcome: "unavailable" }, "unavailable"],
    [{ outcome: "invalid-request" }, "invalidRequest"],
  ] as const)("says %o as a sentence", (result, message) => {
    expect(receive(result)).toEqual({
      step: { kind: "message", message },
      url: null,
    });
  });

  /** No outcome sends anybody anywhere except the one that carries an address. */
  it("gives nowhere to go for anything but a ready checkout", () => {
    const results = [
      { outcome: "over-limit-confirmation-required", activeWorkers: 3, activeWorkerLimit: 2 },
      { outcome: "plan-switch-required", currentPlan: "pro" },
      { outcome: "billing-management-required", reason: "cancelling" },
      { outcome: "payment-processing" },
      { outcome: "provider-verification-unavailable" },
      { outcome: "unavailable" },
      { outcome: "invalid-request" },
    ] as const;

    for (const result of results) {
      expect(receive(result).url, result.outcome).toBeNull();
    }
  });

  /** A shape a newer server returned is not guessed at. */
  it("falls back to the generic sentence for an outcome it does not know", () => {
    expect(receive({ outcome: "something-new" } as never)).toEqual({
      step: { kind: "message", message: "unavailable" },
      url: null,
    });
  });

  it("says the same thing when the call did not come back at all", () => {
    expect(fail()).toEqual({ kind: "message", message: "unavailable" });
  });
});

/**
 * The confirmation, as it renders.
 *
 * **The numbers are the server's.** The count the page was rendered with may have
 * moved by the time somebody pressed a button, so the sentence is filled from what
 * the action answered — which is the point of asking it.
 */
describe("the over-limit question on screen", () => {
  const withStep = (activeWorkers: number, activeWorkerLimit: number) =>
    receive({
      outcome: "over-limit-confirmation-required",
      activeWorkers,
      activeWorkerLimit,
    });

  it("carries the server's numbers rather than the page's", () => {
    expect(withStep(7, 2).step).toEqual({
      kind: "over-limit",
      activeWorkers: 7,
      activeWorkerLimit: 2,
    });
  });
});

describe("what never reaches the browser", () => {
  it.each([true, false])("renders no identifier when enabled is %s", (enabled) => {
    const html = render(enabled).toLowerCase();

    for (const forbidden of [
      "cs_test",
      "cs_live",
      "price_",
      "prod_",
      "cus_",
      "sub_",
      "sk_",
      "attempt",
      "stripe",
      "sandbox",
      "checkout_sandbox_user_ids",
    ]) {
      expect(html, `renders ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders no account details", () => {
    const html = render(true);

    expect(html).not.toContain("@");
    expect(html).not.toMatch(/\d{10,}/);
  });

  /** No form and no action attribute: the call is a function call. */
  it("submits no form", () => {
    expect(render(true)).not.toContain("<form");
    expect(render(true)).not.toContain("action=");
  });

  it("takes nothing from a caller but a plan, a boolean and some words", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-plan-button.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "userId",
      "email",
      "priceId",
      "customerId",
      "providerSubscriptionId",
      "successUrl",
      "cancelUrl",
      "metadata",
      "process.env",
      "sessionId",
      "attemptId",
    ]) {
      expect(source, `holds ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** The address comes from the action and is not built, parsed, or patched. */
  it("builds no address of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-plan-button.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "new URL",
      "https://",
      "searchParams",
      "encodeURI",
      "window.location.href =",
    ]) {
      expect(source, `builds ${forbidden}`).not.toContain(forbidden);
    }

    expect(source).toContain("window.location.assign(outcome.url)");
  });

  it("reaches no provider and no database", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-plan-button.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "prisma",
      "new Stripe",
      "fetch(",
      "startCheckout(",
      "beginCheckoutAttempt",
      "isSandboxCheckoutEnabledForUser",
    ]) {
      expect(source, `reaches ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/**
 * The purchase terms, as they render.
 *
 * **Two buttons, and neither says it charges anything.** The one that goes on
 * says it goes on; the provider's own page is where a payment is made.
 */
describe("the purchase terms on screen", () => {
  const renderTerms = (purchase = LABELS.purchase) =>
    renderToStaticMarkup(<PurchaseTerms labels={purchase} />);

  it("shows every item it was given, in order", () => {
    const html = renderTerms();

    expect(html).toContain("TERMS-HEADING");
    expect(html.indexOf("TERM-A")).toBeLessThan(html.indexOf("TERM-B"));
    expect(html).toContain("DETAIL-A");
    expect(html).toContain("DETAIL-B");
  });

  it("links to the terms and the legal notice, opening beside the step", () => {
    const html = renderTerms();

    expect(html).toContain('href="/terms?lang=en"');
    expect(html).toContain('href="/legal?lang=en"');
    expect(html).toContain("TERMS-LINK");
    expect(html).toContain("LEGAL-LINK");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("offers going on and going back, as buttons that submit nothing", () => {
    const html = renderTerms();

    expect(html).toContain("PROCEED-LABEL");
    expect(html).toContain("BACK-LABEL");
    expect(html.match(/type="button"/g)).toHaveLength(2);
    expect(html).not.toContain("<form");
  });

  it("says nothing about a trial unless one is running", () => {
    expect(renderTerms()).not.toContain("TRIAL-NOTICE");
    expect(
      renderTerms({ ...LABELS.purchase, trialNotice: "TRIAL-NOTICE" }),
    ).toContain("TRIAL-NOTICE");
  });
});
