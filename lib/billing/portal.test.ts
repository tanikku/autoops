import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may be sent to the provider's billing portal, and where.
 *
 * **No provider is involved.** The orchestration is handed one; every branch
 * below is a decision about Koqentra's own row, the deployment's origin, or what
 * the provider answered.
 */

const subscriptionFindUnique = vi.fn();
const clientStub = { subscription: { findUnique: subscriptionFindUnique } };

vi.mock("@/lib/prisma", () => ({ prisma: clientStub }));

const { isTrustedPortalUrl, mayOpenBillingPortal, openBillingPortal } =
  await import("@/lib/billing/portal");

const USER = "116614511017733764020";
const NOW = new Date("2026-09-27T09:00:00.000Z");
const PORTAL_URL = "https://billing.stripe.com/p/session/test_abc";

const createPortalSession = vi.fn();
const provider = { createPortalSession };

/** A subscription row, defaulting to the granted beta allowance. */
function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    plan: "beta",
    state: "active",
    source: "admin",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: new Date("2026-09-25T15:51:15.150Z"),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    notificationWorkerId: null,
    expiresAt: new Date("2026-12-31T23:59:59.000Z"),
    providerCustomerId: null,
    ...overrides,
  };
}

/** A paid row, as reconciliation writes one. */
function paidRow(overrides: Record<string, unknown> = {}) {
  return subscriptionRow({
    plan: "lite",
    state: "active",
    source: "stripe",
    currentPeriodStart: new Date("2026-09-25T16:31:48.000Z"),
    currentPeriodEnd: new Date("2026-10-25T16:31:48.000Z"),
    expiresAt: null,
    providerCustomerId: "cus_existing",
    ...overrides,
  });
}

function open(overrides: Record<string, unknown> = {}) {
  return openBillingPortal({
    userId: USER,
    provider,
    now: NOW,
    ...overrides,
  });
}

const originalAuthUrl = process.env.AUTH_URL;

beforeEach(() => {
  process.env.AUTH_URL = "https://app.koqentra.example";
  subscriptionFindUnique.mockReset().mockResolvedValue(paidRow());
  createPortalSession.mockReset().mockResolvedValue({ url: PORTAL_URL });
});

afterEach(() => {
  if (originalAuthUrl === undefined) {
    delete process.env.AUTH_URL;
  } else {
    process.env.AUTH_URL = originalAuthUrl;
  }
});

describe("a subscription somebody is paying for", () => {
  it.each([
    ["active", {}],
    ["grace", { state: "grace" }],
    ["canceled_active", { state: "canceled_active" }],
  ])("opens the portal in %s", async (_label, overrides) => {
    subscriptionFindUnique.mockResolvedValue(paidRow(overrides));

    expect(await open()).toEqual({ outcome: "portal-ready", url: PORTAL_URL });
  });

  it.each(["standard", "pro"])("opens it on %s too", async (plan) => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ plan }));

    expect((await open()).outcome).toBe("portal-ready");
  });

  it("reads the row of the account it was given and nobody else's", async () => {
    await open();

    expect(subscriptionFindUnique).toHaveBeenCalledTimes(1);
    expect(subscriptionFindUnique.mock.calls[0][0].where).toEqual({ userId: USER });
  });

  /** The customer is the row's, and nothing else goes to the provider. */
  it("asks the provider with the row's customer and the fixed return address", async () => {
    await open();

    expect(createPortalSession).toHaveBeenCalledTimes(1);
    expect(createPortalSession.mock.calls[0][0]).toEqual({
      customerId: "cus_existing",
      returnUrl: "https://app.koqentra.example/dashboard/billing",
    });
  });

  it("returns to the plans page whatever path AUTH_URL carries", async () => {
    process.env.AUTH_URL = "https://app.koqentra.example/somewhere/else?x=1";

    await open();

    expect(createPortalSession.mock.calls[0][0].returnUrl).toBe(
      "https://app.koqentra.example/dashboard/billing",
    );
  });
});

describe("accounts with nothing to manage", () => {
  it.each([
    ["no row", null],
    ["the granted beta allowance", subscriptionRow()],
    [
      "an admin grant that has expired",
      subscriptionRow({ expiresAt: new Date("2026-09-01T00:00:00.000Z") }),
    ],
    [
      "a trial",
      subscriptionRow({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-09-20T00:00:00.000Z"),
        trialEndsAt: new Date("2026-10-04T00:00:00.000Z"),
        trialConsumedAt: new Date("2026-09-20T00:00:00.000Z"),
        trialForfeitedAt: null,
        expiresAt: null,
      }),
    ],
    [
      "a trial that has run out",
      subscriptionRow({
        plan: "trial",
        state: "trialing",
        source: "trial",
        trialStartedAt: new Date("2026-09-01T00:00:00.000Z"),
        trialEndsAt: new Date("2026-09-15T00:00:00.000Z"),
        trialConsumedAt: new Date("2026-09-01T00:00:00.000Z"),
        trialForfeitedAt: null,
        expiresAt: null,
      }),
    ],
    ["a paid subscription that has ended", paidRow({ state: "inactive" })],
    [
      "a cancellation whose period has run out",
      paidRow({
        state: "canceled_active",
        currentPeriodEnd: new Date("2026-09-20T00:00:00.000Z"),
      }),
    ],
    ["a paid-looking row granted by an admin", paidRow({ source: "admin" })],
    ["a stripe row on a plan nobody sells", paidRow({ plan: "beta" })],
  ])("refuses %s", async (_label, row) => {
    subscriptionFindUnique.mockResolvedValue(row);

    expect(await open()).toEqual({ outcome: "not-eligible" });
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  /** A stored state this version cannot read is not guessed at. */
  it("refuses a row it cannot read", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ state: "frozen" }));

    expect(await open()).toEqual({ outcome: "not-eligible" });
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  /** Even an inactive row that still remembers its customer. */
  it("refuses an ended subscription that still carries its customer", async () => {
    subscriptionFindUnique.mockResolvedValue(
      paidRow({ state: "inactive", providerCustomerId: "cus_old" }),
    );

    expect(await open()).toEqual({ outcome: "not-eligible" });
    expect(createPortalSession).not.toHaveBeenCalled();
  });
});

describe("what stops a portal for an account that may have one", () => {
  it.each([null, "", "   "])("has no customer (%j)", async (providerCustomerId) => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ providerCustomerId }));

    expect(await open()).toEqual({ outcome: "unavailable", reason: "no-customer" });
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("has no provider configured", async () => {
    expect(await open({ provider: { unavailable: "no-secret-key" } })).toEqual({
      outcome: "unavailable",
      reason: "provider-unconfigured",
    });
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
    ["not a url", "not a url"],
    ["not http", "ftp://app.koqentra.example"],
  ])("has an AUTH_URL that is %s", async (_label, value) => {
    if (value === undefined) {
      delete process.env.AUTH_URL;
    } else {
      process.env.AUTH_URL = value;
    }

    expect(await open()).toEqual({ outcome: "unavailable", reason: "no-return-url" });
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("says nothing of a provider's own failure", async () => {
    createPortalSession.mockRejectedValue(
      new Error("No such customer: 'cus_existing'; sk_test_secret"),
    );

    const result = await open();

    expect(result).toEqual({ outcome: "unavailable", reason: "provider-failed" });
    expect(JSON.stringify(result)).not.toContain("cus_");
    expect(JSON.stringify(result)).not.toContain("sk_");
  });

  it.each([
    ["no url", { url: null }],
    ["no answer", undefined],
    ["a url that is not a string", { url: 42 }],
    ["plain http", { url: "http://billing.stripe.com/p/session/x" }],
    ["another host", { url: "https://evil.example/p/session/x" }],
    ["a lookalike host", { url: "https://billing.stripe.com.evil.example/x" }],
    ["a subdomain", { url: "https://x.billing.stripe.com/x" }],
    ["credentials in front of another host", { url: "https://billing.stripe.com@evil.example/x" }],
    ["a script", { url: "javascript:alert(1)" }],
    ["something unparseable", { url: "not a url" }],
  ])("refuses a provider answer with %s", async (_label, answer) => {
    createPortalSession.mockResolvedValue(answer);

    expect(await open()).toEqual({ outcome: "unavailable", reason: "untrusted-url" });
  });
});

describe("what it never does", () => {
  it("writes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/portal.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const write of [".create(", ".update(", ".updateMany(", ".upsert(", ".delete(", "$transaction"]) {
      expect(source, `uses ${write}`).not.toContain(write);
    }
  });

  it("names no provider SDK and no subscription operation", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/portal.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      'from "stripe"',
      "new Stripe",
      "subscriptions.",
      "cancel_at",
      "flow_data",
      "configuration",
      "providerSubscriptionId",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("whether the pricing screen offers it", () => {
  const onPlan = (plan: string, state: string, purchased: boolean) => ({
    kind: "on-plan" as const,
    plan,
    state,
    purchased,
    entitled: true,
  });

  it.each(["active", "grace", "canceled_active"])("offers it for a bought plan in %s", (state) => {
    expect(mayOpenBillingPortal(onPlan("lite", state, true))).toBe(true);
  });

  it.each([
    ["no plan", { kind: "none" as const }],
    ["an unreadable row", { kind: "unreadable" as const }],
    ["the granted beta allowance", onPlan("beta", "active", false)],
    ["a trial", onPlan("trial", "trialing", false)],
    ["an expired trial", onPlan("trial", "trial_expired", false)],
    ["an ended subscription", onPlan("lite", "inactive", true)],
    ["an expired grant", onPlan("beta", "expired", false)],
    ["a granted lite allowance", onPlan("lite", "active", false)],
  ])("does not offer it for %s", (_label, current) => {
    expect(mayOpenBillingPortal(current)).toBe(false);
  });
});

describe("which portal addresses are trusted", () => {
  it("trusts the provider's own portal host over https", () => {
    expect(isTrustedPortalUrl(PORTAL_URL)).toBe(true);
  });

  it("trusts nothing else", () => {
    expect(isTrustedPortalUrl(null)).toBe(false);
    expect(isTrustedPortalUrl("https://checkout.stripe.com/c/pay/x")).toBe(false);
  });
});
