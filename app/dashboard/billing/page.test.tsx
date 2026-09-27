import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The plans page, which offers a purchase to one account and nobody else.
 *
 * **What is fixed here is who sees a live button.** The checkout is being proved
 * against a sandbox, so the page asks the server whether this account is in the
 * rollout and hands the answer down as a boolean; every other reader gets the
 * button they had before, disabled and saying so. This page still does not import
 * the action — the button does — and the gate here is not what enforces anything:
 * `actions.test.ts` covers the request that arrives anyway.
 *
 * **The guardrail wording is tested as wording.** An account running more
 * workers than a plan allows can still buy it, so what matters is that the page
 * says what keeps running before it says what is restricted.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getUserLanguage: vi.fn(),
  readPricingView: vi.fn(),
  mayOfferPurchase: vi.fn(),
  getDocumentLanguage: vi.fn(),
  isSandboxCheckoutEnabledForUser: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/i18n/server", () => ({
  getDocumentLanguage: mocks.getDocumentLanguage,
}));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/lib/billing/pricing", () => ({
  readPricingView: mocks.readPricingView,
  mayOfferPurchase: mocks.mayOfferPurchase,
}));
vi.mock("@/lib/billing/checkout-sandbox-server", () => ({
  isSandboxCheckoutEnabledForUser: mocks.isSandboxCheckoutEnabledForUser,
}));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));
// **Stood in for, because it is a client component that calls the action.**
// Importing the real one would pull the action into this test's module graph; what
// this file is about is which props it is handed, which is what the stand-in
// records. Its own behaviour is `components/checkout-plan-button.test.tsx`.
vi.mock("@/components/checkout-plan-button", () => ({
  CheckoutPlanButton: (props: Record<string, unknown>) => {
    buttonProps.push(props);

    return null;
  },
}));

const buttonProps: Record<string, unknown>[] = [];

const { default: BillingPage, generateMetadata } = await import(
  "@/app/dashboard/billing/page"
);

const USER = "116614511017733764020";

/** The catalogue's own numbers, as `readPricingView` hands them over. */
function pricedPlan(
  id: "lite" | "standard" | "pro",
  overrides: Record<string, unknown> = {},
) {
  const catalogue = {
    lite: {
      activeWorkerLimit: 2,
      aiProcessingLimit: 30,
      manualRunLimit: 20,
      discoveryLimit: 10,
      email: "one-worker",
      history: { kind: "days", days: 7 },
      monthlyYen: 780,
    },
    standard: {
      activeWorkerLimit: 8,
      aiProcessingLimit: 150,
      manualRunLimit: 100,
      discoveryLimit: 60,
      email: "all-workers",
      history: { kind: "days", days: 90 },
      monthlyYen: 1480,
    },
    pro: {
      activeWorkerLimit: 15,
      aiProcessingLimit: 300,
      manualRunLimit: 300,
      discoveryLimit: 150,
      email: "all-workers",
      history: { kind: "days", days: 365 },
      monthlyYen: 2480,
    },
  }[id];

  const { monthlyYen, ...definition } = catalogue;

  return {
    id,
    definition: { id, ...definition, trialDurationDays: null },
    monthlyYen,
    standing: "below-limit",
    ...overrides,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    activeWorkers: 1,
    checkoutInProgress: false,
    current: {
      kind: "on-plan",
      plan: "beta",
      state: "active",
      purchased: false,
      entitled: true,
    },
    plans: [pricedPlan("lite"), pricedPlan("standard"), pricedPlan("pro")],
    ...overrides,
  };
}

async function render(overrides: Record<string, unknown> = {}) {
  mocks.readPricingView.mockResolvedValue(view(overrides));
  return renderToStaticMarkup(await BillingPage());
}

beforeEach(() => {
  buttonProps.length = 0;
  mocks.isSandboxCheckoutEnabledForUser.mockReset().mockReturnValue(false);
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getDocumentLanguage.mockReset().mockResolvedValue("en");
  mocks.mayOfferPurchase.mockReset().mockReturnValue(true);
  mocks.readPricingView.mockReset().mockResolvedValue(view());
});

describe("the three plans", () => {
  it("shows all of them", async () => {
    const html = await render();

    expect(html).toContain("Lite");
    expect(html).toContain("Standard");
    expect(html).toContain("Pro");
  });

  /** The price shown is the one the read model carried, not one of the page's. */
  it("shows each price from the read model", async () => {
    const html = await render();

    expect(html).toContain("780");
    expect(html).toContain("1,480");
    expect(html).toContain("2,480");
  });

  it("shows each plan's allowances from the catalogue", async () => {
    const html = await render();

    // Lite
    expect(html).toContain("2 active Workers");
    expect(html).toContain("30 AI runs a month");
    expect(html).toContain("7 days of run history");
    expect(html).toContain("Email from one Worker");
    // Standard and Pro
    expect(html).toContain("8 active Workers");
    expect(html).toContain("15 active Workers");
    expect(html).toContain("Email from every Worker");
  });

  /** Only what the read model listed. A plan nobody sells is not rendered. */
  it("shows no plan the read model did not name", async () => {
    const html = await render({ plans: [pricedPlan("lite")] });

    expect(html).toContain("Lite");
    expect(html).not.toContain("Standard");
    expect(html).not.toContain("Pro");
  });

  it("says nothing about trials or the granted allowance as something to buy", async () => {
    const html = await render();

    expect(html).not.toContain("beta plan");
    expect(html).not.toContain("Trial plan");
  });
});

/** What the read model calls being on a plan, as the page has to say it. */
function onPlan(
  plan: string,
  state: string,
  purchased: boolean,
  entitled = true,
) {
  return { current: { kind: "on-plan", plan, state, purchased, entitled } };
}

/**
 * What the account has, said one state at a time.
 *
 * **The state decides the sentence.** The first version of this section read the
 * plan and nothing else, so an account whose Lite subscription had ended was told
 * it was on Lite — a plan it no longer had, named by its stored id. Every state
 * below therefore has its own assertion, and the ones that entitle nothing are
 * asserted to say so.
 */
describe("what the account is on now", () => {
  it("says so when there is no plan", async () => {
    const html = await render({ current: { kind: "none" } });

    expect(html).toContain("You are not on a plan yet.");
  });

  it("says a trial is running", async () => {
    const html = await render(onPlan("trial", "trialing", false));

    expect(html).toContain("Your trial is active.");
  });

  it("says a trial has ended", async () => {
    const html = await render(onPlan("trial", "trial_expired", false, false));

    expect(html).toContain("Your trial has ended.");
  });

  /**
   * **A grant is not a purchase.** Telling somebody on the Closed Beta allowance
   * that they are subscribed would be telling them they are being charged.
   */
  it("calls a granted allowance access rather than a subscription", async () => {
    const html = await render(onPlan("beta", "active", false));

    expect(html).toContain("Your Beta access is active.");
    expect(html).not.toContain("You are subscribed");
  });

  it("calls a bought plan a subscription", async () => {
    mocks.mayOfferPurchase.mockReturnValue(false);

    const html = await render(onPlan("lite", "active", true));

    expect(html).toContain("You are subscribed to Lite.");
    expect(html).not.toContain("access is active");
  });

  /** What needs doing, without naming a cause the page cannot see. */
  it("says a payment needs attention in grace", async () => {
    mocks.mayOfferPurchase.mockReturnValue(false);

    const html = await render(onPlan("lite", "grace", true));

    expect(html).toContain(
      "Your Lite subscription is active, but payment needs attention.",
    );
  });

  it("says a cancellation still has its period to run", async () => {
    mocks.mayOfferPurchase.mockReturnValue(false);

    const html = await render(onPlan("lite", "canceled_active", true));

    expect(html).toContain(
      "Your Lite subscription is cancelled but remains active until the end of the current billing period.",
    );
  });

  /**
   * **No date, deliberately.** The period end is not in the read model, and a
   * date invented on a page about somebody's billing would be worse than none.
   */
  it("names no date for a cancellation", async () => {
    mocks.mayOfferPurchase.mockReturnValue(false);

    const html = await render(onPlan("lite", "canceled_active", true));

    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toContain("until 2026");
  });

  /** The defect this section exists for: a plan that has ended says so first. */
  it("says a subscription that has ended is over", async () => {
    const html = await render(onPlan("lite", "inactive", true, false));

    expect(html).toContain("You are not on a plan.");
    expect(html).toContain("Your Lite subscription has ended.");
  });

  it("says a grant that has expired is over", async () => {
    const html = await render(onPlan("beta", "expired", false, false));

    expect(html).toContain("Your Beta access has ended.");
  });

  it("says nothing it cannot read", async () => {
    const html = await render({ current: { kind: "unreadable" } });

    expect(html).toContain("cannot be shown right now");
  });

  /** A state written by a version that knew more is not described. */
  it("says nothing about a state it does not know", async () => {
    const html = await render(onPlan("lite", "renegotiating", true));

    expect(html).toContain("cannot be shown right now");
  });

  /** Nor a plan it does not know: there is no name to read off an id. */
  it("says nothing about a plan it does not know", async () => {
    const html = await render(onPlan("enterprise", "active", true));

    expect(html).toContain("cannot be shown right now");
  });

  /** Every state this build knows has a sentence of its own. */
  it.each([
    ["trialing", "trial"],
    ["trial_expired", "trial"],
    ["active", "lite"],
    ["grace", "lite"],
    ["canceled_active", "lite"],
    ["inactive", "lite"],
    ["expired", "beta"],
  ])("has copy for %s", async (state, plan) => {
    mocks.mayOfferPurchase.mockReturnValue(false);

    const html = await render(onPlan(plan, state, true));

    expect(html).not.toContain("cannot be shown right now");
  });

  /** Never the stored id: the cards call the same plan Lite. */
  it.each(["active", "grace", "canceled_active", "inactive"])(
    "names the plan as a card writes it in %s",
    async (state) => {
      mocks.mayOfferPurchase.mockReturnValue(false);

      const html = await render(onPlan("lite", state, true));

      expect(html).toContain("Lite");
      expect(html).not.toContain("You are on lite");
    },
  );

  /** The old wording said one thing for eight different situations. */
  it("never says only which plan somebody is on", async () => {
    for (const current of [
      onPlan("beta", "active", false),
      onPlan("lite", "inactive", true, false),
      onPlan("trial", "trialing", false),
    ]) {
      expect(await render(current)).not.toContain("You are on ");
    }
  });

  /**
   * **The sentence and the offer are answered separately.** One is presentation
   * and the other is `mayOfferPurchase`; a heading with its own opinion about
   * what may be bought would be a second thing to keep in step.
   */
  it("says the same thing whether or not a purchase is offered", async () => {
    mocks.mayOfferPurchase.mockReturnValue(true);
    const offered = await render(onPlan("lite", "active", true));

    mocks.mayOfferPurchase.mockReturnValue(false);
    const managed = await render(onPlan("lite", "active", true));

    expect(offered).toContain("You are subscribed to Lite.");
    expect(managed).toContain("You are subscribed to Lite.");
  });

  /** The number every guardrail sentence refers to, said once at the top. */
  it("shows how many workers are active", async () => {
    const html = await render({ activeWorkers: 3 });

    expect(html).toContain("3 of your Workers are active.");
  });
});

/**
 * Saying that a payment may be on its way.
 *
 * **This is the part of F-90 the plans page carries.** A payment that has cleared
 * takes seconds to minutes to become an entitlement, and during that window the
 * sentence above is correct and alarming: an account that has just paid is told
 * its subscription has ended. The notice explains the gap.
 *
 * **It explains and does not block.** An unfinished checkout is as likely to be
 * one somebody abandoned at the payment page as one they paid for, and only the
 * provider can say which — `startCheckout` asks it. A page that disabled its
 * buttons on this alone would lock somebody who changed their mind out of trying
 * again for the eighteen hours of the attempt's TTL.
 */
describe("while a checkout of theirs is unfinished", () => {
  it("says nothing when there is none", async () => {
    const html = await render();

    expect(html).not.toContain("A checkout of yours is still open");
  });

  it("says a payment may take a few minutes to appear", async () => {
    const html = await render({ checkoutInProgress: true });

    expect(html).toContain("A checkout of yours is still open");
    expect(html).toContain("can take a few minutes to appear");
  });

  it("says it in Japanese too", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render({ checkoutInProgress: true });

    expect(html).toContain("お支払い手続きが進行中です");
  });

  /** The buttons are exactly as they were: this is a sentence, not a gate. */
  it("leaves the purchase buttons as they were", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render({ checkoutInProgress: true });

    expect(buttonProps).toHaveLength(3);
    for (const props of buttonProps) {
      expect(props.enabled).toBe(true);
    }
  });

  it("leaves them disabled for an account outside the rollout", async () => {
    await render({ checkoutInProgress: true });

    expect(buttonProps.map((props) => props.enabled)).toEqual([
      false,
      false,
      false,
    ]);
  });

  /** It does not claim a payment succeeded, and it names nothing. */
  it("claims nothing about the payment and identifies nothing", async () => {
    const html = await render({ checkoutInProgress: true });

    expect(html).not.toContain("Your Lite plan is active");
    expect(html).not.toContain("You are subscribed");
    expect(html.toLowerCase()).not.toContain("stripe");
    expect(html).not.toContain(USER);
    expect(html).not.toMatch(/cs_test|price_|cus_|sub_/);
  });

  /** The sentence about what the account is on is unchanged by it. */
  it("does not change what the account is said to be on", async () => {
    const html = await render({
      checkoutInProgress: true,
      current: {
        kind: "on-plan",
        plan: "lite",
        state: "inactive",
        purchased: true,
        entitled: false,
      },
    });

    expect(html).toContain("Your Lite subscription has ended.");
    expect(html).toContain("A checkout of yours is still open");
  });
});

describe("the guardrail", () => {
  /** Nothing to say when the allowance is not smaller. */
  it("says nothing on a plan that fits", async () => {
    const html = await render();

    expect(html).not.toContain("would be at this plan");
    expect(html).not.toContain("allows fewer active Workers");
  });

  it("warns at the limit", async () => {
    const html = await render({
      activeWorkers: 2,
      plans: [pricedPlan("lite", { standing: "at-limit" })],
    });

    expect(html).toContain("You would be at this plan&#x27;s limit");
    expect(html).toContain("This is exactly what you use now");
  });

  /** At the limit, the thing a reader needs is that a paused one cannot return. */
  it("says a paused Worker cannot be resumed at the limit", async () => {
    const html = await render({
      activeWorkers: 2,
      plans: [pricedPlan("lite", { standing: "at-limit" })],
    });

    expect(html).toContain("They keep running");
    expect(html).toContain("including one that is paused");
    expect(html).toContain("would first have to pause one");
  });

  it("warns over the limit", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).toContain("This plan allows fewer active Workers");
    expect(html).toContain("Fewer active Workers than you run now");
  });

  /** First sentence: nothing of theirs stops. */
  it("says the running Workers keep running", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).toContain("The ones running now keep running");
  });

  /** And that Koqentra does not pick one to stop. */
  it("says nothing is stopped automatically", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).toContain("nothing is stopped");
    expect(html).toContain("never chooses a Worker to stop on your behalf");
  });

  /** Second sentence: what is restricted. */
  it("says what could not be done until a slot is free", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).toContain("could not make a new Worker active");
    expect(html).toContain("activate a draft");
    expect(html).toContain("resume a paused one");
  });

  /** Third sentence: how to lift it. */
  it("says how to free a slot", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).toContain("Pausing or deleting a Worker is always allowed");
    expect(html).toContain("you could add them again");
  });

  /** The same sentences serve a trial, a grant, and a plan being left. */
  it("never names the Closed Beta in its warnings", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).not.toContain("Closed Beta");
    expect(html).not.toContain("beta allowance");
  });
});

describe("who is not offered a plan", () => {
  it("offers management instead of a purchase", async () => {
    mocks.mayOfferPurchase.mockReturnValue(false);

    const html = await render({
      current: {
        kind: "on-plan",
        plan: "lite",
        state: "active",
        purchased: true,
        entitled: true,
      },
    });

    expect(html).toContain("Managing your subscription");
    expect(html).toContain("not available yet");
    // No plan cards at all: nothing that could look like a second subscription.
    expect(buttonProps).toHaveLength(0);
    expect(html).not.toContain("780");
  });

  it.each(["active", "grace", "canceled_active"])(
    "shows no purchase for a paid account in %s",
    async (state) => {
      mocks.mayOfferPurchase.mockReturnValue(false);

      const html = await render({
        current: {
          kind: "on-plan",
          plan: "lite",
          state,
          purchased: true,
          entitled: true,
        },
      });

      expect(html).toContain("Managing your subscription");
      expect(html).not.toContain("780");
    },
  );
});

/**
 * Who is offered a purchase, and how the answer travels.
 *
 * **One boolean crosses, and it is the server's.** The list it was decided from
 * lives in a variable on the deployment; what reaches a card is whether this
 * account is on it.
 */
describe("the buttons", () => {
  it("asks the server about the authenticated account", async () => {
    await render();

    expect(mocks.isSandboxCheckoutEnabledForUser).toHaveBeenCalledWith(USER);
  });

  it("offers no purchase to an account outside the rollout", async () => {
    await render();

    expect(buttonProps).toHaveLength(3);
    for (const props of buttonProps) {
      expect(props.enabled).toBe(false);
    }
  });

  it("offers one to the account inside it", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render();

    expect(buttonProps).toHaveLength(3);
    for (const props of buttonProps) {
      expect(props.enabled).toBe(true);
    }
  });

  /** An unset variable is what every account sees until one is set. */
  it("offers none when nothing decided otherwise", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(false);

    await render();

    expect(buttonProps.map((props) => props.enabled)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it.each([
    [0, "lite"],
    [1, "standard"],
    [2, "pro"],
  ])("gives card %i the plan %s", async (index, plan) => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render();

    expect(buttonProps[index].plan).toBe(plan);
  });

  /**
   * **Words, not a language.** Handing over a language would make the client call
   * `t()`, and that pulls both dictionaries into the browser bundle.
   */
  it("hands over sentences rather than the means to find them", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render();

    const labels = buttonProps[0].labels as Record<string, unknown>;

    expect(Object.keys(buttonProps[0]).sort()).toEqual([
      "enabled",
      "labels",
      "plan",
    ]);
    expect(labels.choose).toBe("Choose Lite");
    expect(labels.unavailable).toBe("Not available yet");
    expect(labels.pending).toBe("Opening checkout...");
  });

  /** The card's own three sentences, placeholders intact for the server's numbers. */
  it("hands over the guardrail sentences unfilled", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render();

    const labels = buttonProps[0].labels as { overLimit: string[] };

    expect(labels.overLimit).toHaveLength(3);
    expect(labels.overLimit[0]).toContain("{active}");
    expect(labels.overLimit[0]).toContain("{limit}");
  });

  it("hands over a sentence for every outcome a browser is told about", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render();

    const labels = buttonProps[0].labels as {
      messages: Record<string, string>;
    };

    expect(Object.keys(labels.messages).sort()).toEqual([
      "billingManagement",
      "invalidRequest",
      "paymentProcessing",
      "planSwitch",
      "providerUnavailable",
      "unavailable",
    ]);
    for (const sentence of Object.values(labels.messages)) {
      expect(sentence.length).toBeGreaterThan(0);
    }
  });

  /** Not an account, not a price, not a customer, not an address. */
  it("hands over nothing that identifies anybody", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    await render();

    const serialised = JSON.stringify(buttonProps);

    expect(serialised).not.toContain(USER);
    expect(serialised).not.toMatch(/price_|cus_|sub_|cs_test|sk_/);
    expect(serialised.toLowerCase()).not.toContain("sandbox");
    expect(serialised).not.toContain("@");
  });

  it("offers no acknowledgement to tick", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    // A checkbox whose value nothing consumes is a promise the page cannot keep.
    expect(html).not.toContain('type="checkbox"');
  });

  /** The action is called as a function; there is no form and nothing posts. */
  it("submits nothing", async () => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(true);

    const html = await render();

    expect(html).not.toContain("<form");
    expect(html).not.toContain("action=");
  });
});

describe("what the page does not do", () => {
  it("authenticates without provisioning a row", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  it("reads the account's plans once", async () => {
    await render();

    expect(mocks.readPricingView).toHaveBeenCalledWith(USER);
  });

  /** The action exists on the server and this page does not reach for it. */
  it("does not import the checkout action", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("app/dashboard/billing/page.tsx", "utf8");
    const imports = [...raw.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).toEqual([
      "next",
      "@/components/dashboard-nav",
      "@/components/plan-cards",
      "@/lib/billing/checkout-sandbox-server",
      "@/lib/billing/plan-labels",
      "@/lib/billing/pricing",
      "@/lib/entitlements/types",
      "@/lib/i18n",
      "@/lib/i18n/server",
      "@/lib/session",
      "@/lib/users",
    ]);

    // The comments say the action is deliberately not imported, so the check is
    // on the code rather than on the file.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).not.toContain("billing/actions");
    expect(source).not.toContain("startCheckoutAction");
  });

  it("reaches no provider and starts no checkout", async () => {
    const { readFileSync } = await import("node:fs");

    for (const file of [
      "app/dashboard/billing/page.tsx",
      "components/plan-cards.tsx",
      "lib/billing/plan-labels.ts",
      "lib/billing/pricing.ts",
    ]) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

      for (const forbidden of [
        "startCheckoutAction",
        "createStripeCheckoutProvider",
        "startCheckout",
        "beginCheckoutAttempt",
        "markCheckoutAttemptOpen",
        "closeCheckoutAttempt",
        "Stripe",
        "fetch(",
      ]) {
        expect(source, `${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("writes to no table", async () => {
    const { readFileSync } = await import("node:fs");

    for (const file of [
      "app/dashboard/billing/page.tsx",
      "components/plan-cards.tsx",
      "lib/billing/plan-labels.ts",
      "lib/billing/pricing.ts",
    ]) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");

      for (const model of [
        "subscription",
        "checkoutAttempt",
        "usagePeriod",
        "usageCounter",
        "billingEvent",
        "routine",
        "user",
      ]) {
        for (const write of ["create", "update", "updateMany", "upsert", "delete"]) {
          expect(source, `${file} writes ${model}.${write}`).not.toContain(
            `${model}.${write}`,
          );
        }
      }
    }
  });

  /** Nothing a browser holds names a price, a customer, or a provider object. */
  it("puts no provider identifier on the page", async () => {
    const html = await render();

    for (const forbidden of ["price_", "cus_", "sub_", "cs_test", "sk_", "stripe"]) {
      expect(html.toLowerCase(), `renders ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** A server component: no state to hold, so no boundary to cross. */
  it("is not a client component", async () => {
    const { readFileSync } = await import("node:fs");

    for (const file of [
      "app/dashboard/billing/page.tsx",
      "components/plan-cards.tsx",
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain('"use client"');
    }
  });
});

describe("the page's own title", () => {
  it("is in the language the page is in", async () => {
    mocks.getDocumentLanguage.mockResolvedValue("ja");

    const metadata = await generateMetadata();

    expect(metadata.title).toBe("プラン");
  });
});

describe("in Japanese", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("keeps the plans' own names", async () => {
    const html = await render();

    expect(html).toContain("Lite");
    expect(html).toContain("Standard");
    expect(html).toContain("Pro");
  });

  it("says the price in Japanese", async () => {
    const html = await render();

    expect(html).toContain("月額 780 円");
  });

  it("says what the account is on in Japanese", async () => {
    expect(await render(onPlan("beta", "active", false))).toContain(
      "Beta の利用枠が有効です。",
    );

    mocks.mayOfferPurchase.mockReturnValue(false);

    expect(await render(onPlan("lite", "active", true))).toContain(
      "Lite を契約中です。",
    );
    expect(await render(onPlan("lite", "inactive", true, false))).toContain(
      "Lite の契約は終了しています。",
    );
  });

  it("warns over the limit in Japanese", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    expect(html).toContain("このプランの上限は現在より少なくなります");
    expect(html).toContain("止まりません");
    expect(html).toContain("一時停止と削除はいつでもできます");
  });
});

/**
 * Three across on a desktop, one column on a phone.
 *
 * Asserted because the grid is the only layout decision on the page, and a
 * plan somebody cannot see is a plan they cannot choose.
 */
describe("the layout", () => {
  it("is a single column that becomes three", async () => {
    const html = await render();

    expect(html).toContain("grid");
    expect(html).toContain("lg:grid-cols-3");
  });

  it("renders one card per plan", async () => {
    await render();

    expect(buttonProps).toHaveLength(3);
  });
});
