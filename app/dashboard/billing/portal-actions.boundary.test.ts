import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where checkout's rollout ends and billing management begins.
 *
 * **Real decisions, stand-in edges.** The session, the database and the
 * provider are replaced; `openBillingPortal`, `readPricingView`,
 * `mayOpenBillingPortal` and the real rollout list read from
 * `CHECKOUT_SANDBOX_USER_IDS` are not. That is what lets these cases say that
 * closing checkout leaves a paying account its portal, and that an account with
 * nothing to manage is refused on the server whatever the list says.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscription: { findUnique: mocks.subscriptionFindUnique },
    routine: { count: vi.fn(async () => 0) },
    checkoutAttempt: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/billing/providers/stripe-portal", () => ({
  createStripeBillingPortalProvider: () => ({
    createPortalSession: mocks.createPortalSession,
  }),
}));

const { openBillingPortalAction } = await import(
  "@/app/dashboard/billing/portal-actions"
);
const { isSandboxCheckoutEnabledForUser } = await import(
  "@/lib/billing/checkout-sandbox-server"
);
const { mayOpenBillingPortal } = await import("@/lib/billing/portal");
const { readPricingView } = await import("@/lib/billing/pricing");

const LISTED = "116614511017733764020";
const UNLISTED = "116614511017733764099";
const PORTAL_URL = "https://billing.stripe.com/p/session/test_abc";

/** A paid row as reconciliation writes one, with a period far from any clock. */
function paidRow(overrides: Record<string, unknown> = {}) {
  return {
    plan: "lite",
    state: "active",
    source: "stripe",
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    trialForfeitedAt: new Date("2026-09-25T15:51:15.150Z"),
    currentPeriodStart: new Date("2026-09-25T16:31:48.000Z"),
    currentPeriodEnd: new Date("2099-10-25T16:31:48.000Z"),
    notificationWorkerId: null,
    expiresAt: null,
    providerCustomerId: "cus_existing",
    ...overrides,
  };
}

const saved = {
  list: process.env.CHECKOUT_SANDBOX_USER_IDS,
  authUrl: process.env.AUTH_URL,
};

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  process.env.AUTH_URL = "https://app.koqentra.example";
  process.env.CHECKOUT_SANDBOX_USER_IDS = LISTED;
  mocks.requireUserId.mockReset();
  mocks.subscriptionFindUnique.mockReset().mockResolvedValue(paidRow());
  mocks.createPortalSession.mockReset().mockResolvedValue({ url: PORTAL_URL });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restore("CHECKOUT_SANDBOX_USER_IDS", saved.list);
  restore("AUTH_URL", saved.authUrl);
});

async function asUser(userId: string) {
  mocks.requireUserId.mockResolvedValue(userId);
  return openBillingPortalAction();
}

describe("the kill switch cases", () => {
  it("1: a listed account that pays may buy and may manage", async () => {
    expect(isSandboxCheckoutEnabledForUser(LISTED)).toBe(true);
    expect(await asUser(LISTED)).toEqual({ outcome: "portal-ready", url: PORTAL_URL });
  });

  it("2: an unlisted account that pays may not buy, and may still manage", async () => {
    expect(isSandboxCheckoutEnabledForUser(UNLISTED)).toBe(false);
    expect(await asUser(UNLISTED)).toEqual({ outcome: "portal-ready", url: PORTAL_URL });
  });

  it("3: an unlisted account with nothing bought may do neither", async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);

    expect(isSandboxCheckoutEnabledForUser(UNLISTED)).toBe(false);
    expect(await asUser(UNLISTED)).toEqual({ outcome: "not-eligible" });
    expect(mocks.createPortalSession).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("4: with checkout closed (%s), a paying account still manages", async (_label, list) => {
    restore("CHECKOUT_SANDBOX_USER_IDS", list);

    expect(isSandboxCheckoutEnabledForUser(LISTED)).toBe(false);
    expect(await asUser(LISTED)).toEqual({ outcome: "portal-ready", url: PORTAL_URL });
  });
});

describe("what still refuses, on the server", () => {
  it.each([
    ["a trial", paidRow({ plan: "trial", state: "trialing", source: "trial" })],
    ["the granted beta", paidRow({ plan: "beta", source: "admin", providerCustomerId: null })],
    ["a plan not bought through Stripe", paidRow({ source: "admin" })],
    ["an ended subscription", paidRow({ state: "inactive" })],
  ])("refuses %s, listed or not", async (_label, row) => {
    mocks.subscriptionFindUnique.mockResolvedValue(row);

    expect(await asUser(LISTED)).toEqual({ outcome: "not-eligible" });
    expect(await asUser(UNLISTED)).toEqual({ outcome: "not-eligible" });
    expect(mocks.createPortalSession).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("is unavailable without a customer (%j)", async (customer) => {
    mocks.subscriptionFindUnique.mockResolvedValue(paidRow({ providerCustomerId: customer }));

    expect(await asUser(UNLISTED)).toEqual({ outcome: "unavailable" });
    expect(mocks.createPortalSession).not.toHaveBeenCalled();
  });

  it.each([
    "http://billing.stripe.com/p/session/x",
    "https://billing.stripe.com.example/p/session/x",
    "https://evil.example/p/session/x",
  ])("keeps refusing an untrusted portal address (%s)", async (url) => {
    mocks.createPortalSession.mockResolvedValue({ url });

    expect(await asUser(UNLISTED)).toEqual({ outcome: "unavailable" });
  });

  it("is unavailable when the provider fails", async () => {
    mocks.createPortalSession.mockRejectedValue(new Error("boom"));

    expect(await asUser(UNLISTED)).toEqual({ outcome: "unavailable" });
  });

  it("asks the provider with the stored customer only", async () => {
    await asUser(UNLISTED);

    expect(mocks.subscriptionFindUnique.mock.calls[0][0].where).toEqual({ userId: UNLISTED });
    expect(mocks.createPortalSession).toHaveBeenCalledWith({
      customerId: "cus_existing",
      returnUrl: "https://app.koqentra.example/dashboard/billing",
    });
  });
});

/**
 * **The page and the action agree.** The page decides whether to show the
 * button from `readPricingView` and `mayOpenBillingPortal`; the action decides
 * from `openBillingPortal`. For rows where both can answer, the answers match —
 * and neither depends on the rollout list.
 */
describe("the page and the action", () => {
  it.each([
    ["paid active", paidRow(), true],
    ["paid grace", paidRow({ state: "grace" }), true],
    ["paid cancelling", paidRow({ state: "canceled_active" }), true],
    ["paid ended", paidRow({ state: "inactive" }), false],
    ["a trial", paidRow({ plan: "trial", state: "trialing", source: "trial" }), false],
    ["the granted beta", paidRow({ plan: "beta", source: "admin" }), false],
    ["no subscription", null, false],
  ])("agree for %s, whatever the list says", async (_label, row, offered) => {
    for (const list of [LISTED, undefined]) {
      restore("CHECKOUT_SANDBOX_USER_IDS", list);
      mocks.subscriptionFindUnique.mockResolvedValue(row);

      const view = await readPricingView(UNLISTED);
      const result = await asUser(UNLISTED);

      expect(mayOpenBillingPortal(view.current)).toBe(offered);
      expect(result.outcome === "portal-ready").toBe(offered);
    }
  });
});
