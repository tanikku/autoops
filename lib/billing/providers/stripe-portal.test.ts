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

/**
 * Which Stripe world a portal session belongs to.
 *
 * **Asked before the address leaves**, with the same flag checkout and
 * reconciliation read. Unset, nothing is checked.
 */
describe("the world a portal session belongs to", () => {
  const withFlag = (flag: string | undefined) =>
    ({
      ...configured,
      ...(flag === undefined ? {} : { STRIPE_EXPECTED_LIVEMODE: flag }),
    }) as unknown as NodeJS.ProcessEnv;

  const created = (livemode: unknown) =>
    portalSessionsCreate.mockResolvedValue({
      id: "bps_1",
      url: "https://billing.stripe.com/p/session/x",
      livemode,
    });

  it.each([
    ["unset, a test session", undefined, false],
    ["unset, a live session", undefined, true],
    ["false, a test session", "false", false],
    ["true, a live session", "true", true],
  ])("hands out the session when the flag is %s", async (_label, flag, livemode) => {
    created(livemode);

    expect(await provider(withFlag(flag)).createPortalSession(REQUEST)).toEqual({
      url: "https://billing.stripe.com/p/session/x",
    });
  });

  it.each([
    ["false, and the session is live", "false", true],
    ["true, and the session is a test one", "true", false],
    ["true, and the session does not say", "true", undefined],
  ])("refuses when the flag is %s", async (_label, flag, livemode) => {
    created(livemode);

    await expect(
      provider(withFlag(flag)).createPortalSession(REQUEST),
    ).rejects.toMatchObject({ name: "StripeLivemodeMismatchError" });
  });

  it("carries no address and no identifier in the refusal", async () => {
    created(true);

    const error = await provider(withFlag("false"))
      .createPortalSession(REQUEST)
      .catch((caught: unknown) => caught);

    const said = `${(error as Error).name} ${(error as Error).message}`;

    for (const forbidden of ["bps_1", "billing.stripe.com", "cus_existing", "app.example"]) {
      expect(said, `says ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("asks Stripe for nothing more and changes no subscription", async () => {
    created(true);

    await provider(withFlag("false"))
      .createPortalSession(REQUEST)
      .catch(() => undefined);

    expect(portalSessionsCreate).toHaveBeenCalledTimes(1);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
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
