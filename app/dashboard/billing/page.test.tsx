import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The plans page, which sells nothing yet.
 *
 * **What is fixed here is that it cannot.** The checkout action exists on the
 * server and this page does not import it; the buttons are disabled; no provider
 * is reached and nothing is written. Several tests below assert an absence, which
 * is the point — a page that could start a purchase before the confirmation flow
 * exists would be a page that charged somebody without explaining what changes.
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
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));

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

describe("what the account is on now", () => {
  it("names the current plan", async () => {
    const html = await render();

    expect(html).toContain("You are on beta.");
  });

  it("says so when there is no plan", async () => {
    const html = await render({ current: { kind: "none" } });

    expect(html).toContain("You are not on a plan yet.");
  });

  it("says nothing it cannot read", async () => {
    const html = await render({ current: { kind: "unreadable" } });

    expect(html).toContain("cannot be shown right now");
  });

  /** The number every guardrail sentence refers to, said once at the top. */
  it("shows how many workers are active", async () => {
    const html = await render({ activeWorkers: 3 });

    expect(html).toContain("3 of your Workers are active.");
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
    expect(html).not.toContain("Not available yet");
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

describe("the buttons", () => {
  /** Disabled, and the label says why. Nothing is wired to a purchase. */
  it("are disabled and say they are not ready", async () => {
    const html = await render();

    expect(html).toContain("disabled");
    expect(html).toContain("Not available yet");
  });

  it("offer no acknowledgement to tick", async () => {
    const html = await render({
      activeWorkers: 3,
      plans: [pricedPlan("lite", { standing: "over-limit" })],
    });

    // A checkbox whose value nothing consumes is a promise the page cannot keep.
    expect(html).not.toContain('type="checkbox"');
  });

  /** Nothing submits: there is no form and no action attribute. */
  it("submit nothing", async () => {
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
      "@/lib/billing/pricing",
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
    const html = await render();

    expect(html.match(/Not available yet/g)).toHaveLength(3);
  });
});
