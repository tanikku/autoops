import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What Stripe is asked for when a portal is opened.
 *
 * **Two parameters, and the absences are the contract.** No `configuration`, so
 * the account's default portal configuration applies; no `flow_data`, so
 * nothing deep-links into a cancellation or a plan change; and no call that
 * could change a subscription at all.
 */

const portalSessionsCreate = vi.fn();
const StripeConstructor = vi.fn();
/** Every other surface a portal must never touch. */
const subscriptionsUpdate = vi.fn();
const subscriptionsCancel = vi.fn();
const checkoutSessionsCreate = vi.fn();

vi.mock("stripe", () => ({
  default: class {
    billingPortal = { sessions: { create: portalSessionsCreate } };
    subscriptions = { update: subscriptionsUpdate, cancel: subscriptionsCancel };
    checkout = { sessions: { create: checkoutSessionsCreate } };
    constructor(...args: unknown[]) {
      StripeConstructor(...args);
    }
  },
}));

const { createStripeBillingPortalProvider } = await import(
  "@/lib/billing/providers/stripe-portal"
);

const configured = {
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
  STRIPE_PRICE_LITE: "price_lite",
  STRIPE_PRICE_STANDARD: "price_standard",
  STRIPE_PRICE_PRO: "price_pro",
} as unknown as NodeJS.ProcessEnv;

const REQUEST = {
  customerId: "cus_existing",
  returnUrl: "https://app.example.invalid/dashboard/billing",
};

function provider(env: NodeJS.ProcessEnv = configured) {
  const resolved = createStripeBillingPortalProvider(env);

  if ("unavailable" in resolved) {
    throw new Error(`unexpectedly unavailable: ${resolved.unavailable}`);
  }

  return resolved;
}

beforeEach(() => {
  StripeConstructor.mockReset();
  portalSessionsCreate
    .mockReset()
    .mockResolvedValue({ id: "bps_1", url: "https://billing.stripe.com/p/session/x" });
  subscriptionsUpdate.mockReset();
  subscriptionsCancel.mockReset();
  checkoutSessionsCreate.mockReset();
});

describe("when Stripe is not configured", () => {
  it.each([
    ["nothing at all", {}, "no-secret-key"],
    ["a blank key", { STRIPE_SECRET_KEY: "  " }, "no-secret-key"],
    ["a key and no prices", { STRIPE_SECRET_KEY: "sk_test_x" }, "no-price-catalogue"],
    [
      "a livemode flag that is neither",
      { ...configured, STRIPE_EXPECTED_LIVEMODE: "yes" },
      "bad-livemode-flag",
    ],
  ])("says so for %s", (_label, env, reason) => {
    expect(
      createStripeBillingPortalProvider(env as unknown as NodeJS.ProcessEnv),
    ).toEqual({ unavailable: reason });
    expect(StripeConstructor).not.toHaveBeenCalled();
  });
});

describe("what a portal session asks for", () => {
  it("builds one client, with the configured key", () => {
    provider();

    expect(StripeConstructor).toHaveBeenCalledTimes(1);
    expect(StripeConstructor.mock.calls[0][0]).toBe("sk_test_not_a_real_key");
  });

  it("sends exactly the customer and the return address", async () => {
    await provider().createPortalSession(REQUEST);

    expect(portalSessionsCreate).toHaveBeenCalledTimes(1);
    expect(portalSessionsCreate.mock.calls[0]).toEqual([
      {
        customer: "cus_existing",
        return_url: "https://app.example.invalid/dashboard/billing",
      },
    ]);
  });

  it("names no configuration and no flow", async () => {
    await provider().createPortalSession(REQUEST);

    const params = portalSessionsCreate.mock.calls[0][0];

    expect(params).not.toHaveProperty("configuration");
    expect(params).not.toHaveProperty("flow_data");
    expect(params).not.toHaveProperty("locale");
  });

  it("changes no subscription and starts no checkout", async () => {
    await provider().createPortalSession(REQUEST);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns the address and nothing else", async () => {
    expect(await provider().createPortalSession(REQUEST)).toEqual({
      url: "https://billing.stripe.com/p/session/x",
    });
  });

  it.each([null, undefined, 42])("answers a missing url (%j) with null", async (url) => {
    portalSessionsCreate.mockResolvedValue({ id: "bps_1", url });

    expect(await provider().createPortalSession(REQUEST)).toEqual({ url: null });
  });

  /** Normalising the error is the orchestration's job; this only lets it through. */
  it("lets Stripe's own failure reach the orchestration", async () => {
    portalSessionsCreate.mockRejectedValue(new Error("No such customer"));

    await expect(provider().createPortalSession(REQUEST)).rejects.toThrow();
  });
});

describe("the source itself", () => {
  it("calls no subscription or checkout operation", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe-portal.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "subscriptions.",
      "checkout.",
      "configuration",
      "flow_data",
      "idempotencyKey",
      "console.",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});
