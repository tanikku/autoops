import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";

/**
 * Where a payment page sends somebody back to.
 *
 * **What is fixed here is what the page is and is not.** It authenticates
 * without provisioning, reads no provider, writes nothing, offers no purchase in
 * any state, and hands the waiting panel words rather than a language. The
 * waiting itself is `components/checkout-return-status.test.tsx`.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getUserLanguage: vi.fn(),
  getDocumentLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/lib/i18n/server", () => ({
  getDocumentLanguage: mocks.getDocumentLanguage,
}));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));
// Stood in for so the props it is handed can be read: what it does with them is
// its own test's business.
vi.mock("@/components/checkout-return-status", () => ({
  CheckoutReturnStatusPanel: (props: Record<string, unknown>) => {
    panelProps.push(props);

    return null;
  },
}));

const panelProps: Record<string, unknown>[] = [];

const { default: BillingReturnPage, generateMetadata } = await import(
  "@/app/dashboard/billing/return/page"
);

const USER = "116614511017733764020";

const render = async () => renderToStaticMarkup(await BillingReturnPage());

const labels = () => panelProps[0].labels as Record<string, unknown>;

beforeEach(() => {
  panelProps.length = 0;
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getDocumentLanguage.mockReset().mockResolvedValue("en");
});

describe("what the page says for itself", () => {
  it("names what it is about", async () => {
    const html = await render();

    expect(html).toContain(t("en", "checkout.return.title"));
    expect(html).toContain(t("en", "checkout.return.description"));
  });

  it("is titled in the language the page is in", async () => {
    mocks.getDocumentLanguage.mockResolvedValue("ja");

    expect((await generateMetadata()).title).toBe(
      t("ja", "checkout.return.title"),
    );
  });

  it("speaks the account's language", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "checkout.return.title"));
  });
});

/**
 * **Words, not a language.** Handing over a language would make the client call
 * `t()`, and that pulls both dictionaries into this page's bundle.
 */
describe("what the waiting panel is handed", () => {
  it("gets a sentence for every state it can show", async () => {
    await render();

    expect(Object.keys(panelProps[0])).toEqual(["labels"]);
    expect(Object.keys(labels()).sort()).toEqual([
      "activeBody",
      "activeHeading",
      "goToPlans",
      "notEntitledBody",
      "notEntitledHeading",
      "pendingBody",
      "pendingHeading",
      "pendingPatience",
      "planNames",
      "timedOutBody",
      "timedOutHeading",
    ]);
  });

  it.each(["en", "ja"] as const)("gets them in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);

    await render();

    expect(labels().pendingHeading).toBe(
      t(language, "checkout.return.pending.heading"),
    );
    expect(labels().timedOutBody).toBe(
      t(language, "checkout.return.timedOut.body"),
    );
  });

  /** A success sentence with `{plan}` still in it, filled from the answer. */
  it("gets the success heading with its placeholder intact", async () => {
    await render();

    expect(labels().activeHeading).toContain("{plan}");
  });

  /** Names, never stored ids: the plans page calls the same plan `Lite`. */
  it("gets the name of every plan that can be bought", async () => {
    await render();

    expect(labels().planNames).toEqual({
      lite: "Lite",
      standard: "Standard",
      pro: "Pro",
    });
  });

  it("gets no name for the plans nobody buys", async () => {
    await render();

    const names = labels().planNames as Record<string, string>;

    expect(names.beta).toBeUndefined();
    expect(names.trial).toBeUndefined();
  });

  it("is handed nothing that identifies anybody", async () => {
    await render();

    const serialised = JSON.stringify(panelProps);

    expect(serialised).not.toContain(USER);
    expect(serialised).not.toContain("@");
    expect(serialised).not.toMatch(/price_|cus_|sub_|cs_test|sk_/);
  });
});

describe("what the page does not do", () => {
  it("authenticates without provisioning a row", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  /** Somebody whose payment has not appeared is the last person to be sold to. */
  it("offers no purchase", async () => {
    const html = await render();

    expect(html).not.toContain("780");
    expect(html).not.toContain("Choose Lite");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="checkbox"');
  });

  it("does not import the plan cards or the checkout action", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "app/dashboard/billing/return/page.tsx",
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).toEqual([
      "next",
      "@/components/dashboard-nav",
      "@/components/checkout-return-status",
      "@/lib/billing/plan-labels",
      "@/lib/billing/checkout-attempt",
      "@/lib/i18n",
      "@/lib/i18n/server",
      "@/lib/session",
      "@/lib/users",
    ]);
  });

  /**
   * **The query string is not read.** `{CHECKOUT_SESSION_ID}` is deliberately not
   * requested, so there is no provider identifier here to trust or to mistrust.
   */
  it("reads no search parameters", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "app/dashboard/billing/return/page.tsx",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "searchParams",
      "CHECKOUT_SESSION_ID",
      "session_id",
      "checkout=",
    ]) {
      expect(source, `reads ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reaches no provider, starts nothing and writes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "app/dashboard/billing/return/page.tsx",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "startCheckout",
      "beginCheckoutAttempt",
      "closeCheckoutAttempt",
      "createStripeCheckoutProvider",
      "reconcileProviderSubscription",
      "new Stripe",
      "fetch(",
      "prisma",
      "requireProvisionedUserId",
      "subscription.update",
      "checkoutAttempt.update",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** A server component: the one part with stages of its own is the panel. */
  it("is not a client component", async () => {
    const { readFileSync } = await import("node:fs");

    expect(
      readFileSync("app/dashboard/billing/return/page.tsx", "utf8"),
    ).not.toContain('"use client"');
  });
});
