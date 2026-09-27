import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What Stripe is actually asked for.
 *
 * **The parameters are the contract.** An idempotency key reused with different
 * parameters is refused outright — measured against a sandbox, not assumed — so
 * what this file fixes is that the request is built from the attempt and from
 * nothing that moves. The decisions about *whether* to ask are
 * `lib/billing/checkout.ts`, and they are tested there without a provider.
 */

const sessionsCreate = vi.fn();
const sessionsRetrieve = vi.fn();
const subscriptionsList = vi.fn();
const StripeConstructor = vi.fn();

vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: { create: sessionsCreate, retrieve: sessionsRetrieve } };
    subscriptions = { list: subscriptionsList };
    constructor(...args: unknown[]) {
      StripeConstructor(...args);
    }
  },
}));

const {
  BLOCKING_SUBSCRIPTION_STATUSES,
  STRIPE_SESSION_LIFETIME_MS,
  createStripeCheckoutProvider,
} = await import("@/lib/billing/providers/stripe-checkout");

const configured = {
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
  STRIPE_PRICE_LITE: "price_lite",
  STRIPE_PRICE_STANDARD: "price_standard",
  STRIPE_PRICE_PRO: "price_pro",
} as unknown as NodeJS.ProcessEnv;

const EXPIRES_AT = new Date("2026-09-27T20:00:00.000Z");

function request(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    userId: "116614511017733764020",
    plan: "lite" as const,
    successUrl: "https://app.example.invalid/dashboard",
    cancelUrl: "https://app.example.invalid/dashboard",
    expiresAt: EXPIRES_AT,
    providerCustomerId: null,
    ...overrides,
  };
}

/** The provider, or a failure if the configuration refused. */
function provider(env: NodeJS.ProcessEnv = configured) {
  const resolved = createStripeCheckoutProvider(env);

  if ("unavailable" in resolved) {
    throw new Error(`unexpectedly unavailable: ${resolved.unavailable}`);
  }

  return resolved;
}

beforeEach(() => {
  StripeConstructor.mockReset();
  sessionsCreate
    .mockReset()
    .mockResolvedValue({ id: "cs_test_1", url: "https://pay.example.invalid/1" });
  sessionsRetrieve
    .mockReset()
    .mockResolvedValue({ status: "open", url: "https://pay.example.invalid/1" });
  subscriptionsList.mockReset().mockResolvedValue({ data: [] });
});

describe("when Stripe is not configured", () => {
  it.each([
    ["nothing at all", {}, "no-secret-key"],
    [
      "half a catalogue",
      { ...configured, STRIPE_PRICE_PRO: "" },
      "no-price-catalogue",
    ],
    [
      "a livemode flag that is neither",
      { ...configured, STRIPE_EXPECTED_LIVEMODE: "maybe" },
      "bad-livemode-flag",
    ],
  ])("reports %s", (_label, env, reason) => {
    expect(
      createStripeCheckoutProvider(env as unknown as NodeJS.ProcessEnv),
    ).toEqual({ unavailable: reason });
  });

  /** Nothing is built for a deployment that cannot use it. */
  it("constructs no client when the configuration is refused", () => {
    createStripeCheckoutProvider({} as unknown as NodeJS.ProcessEnv);

    expect(StripeConstructor).not.toHaveBeenCalled();
  });

  /** The key is used, never reported. */
  it("never puts the key in what it returns", () => {
    const refused = JSON.stringify(
      createStripeCheckoutProvider({} as unknown as NodeJS.ProcessEnv),
    );

    expect(refused).not.toContain("sk_");
  });
});

describe("the session it asks for", () => {
  it("is a subscription of exactly one", async () => {
    await provider().createSession(request());

    const params = sessionsCreate.mock.calls[0][0];

    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([{ price: "price_lite", quantity: 1 }]);
  });

  /** The price comes from the catalogue, never from a caller. */
  it.each([
    ["lite", "price_lite"],
    ["standard", "price_standard"],
    ["pro", "price_pro"],
  ])("resolves %s to its own price", async (plan, price) => {
    await provider().createSession(request({ plan }));

    expect(sessionsCreate.mock.calls[0][0].line_items[0].price).toBe(price);
  });

  /** Reconciliation reads this and nothing else to decide whose it is. */
  it("binds the subscription to the account by metadata", async () => {
    await provider().createSession(request());

    expect(sessionsCreate.mock.calls[0][0].subscription_data).toEqual({
      metadata: { koqentra_user_id: "116614511017733764020" },
    });
  });

  it("asks for no trial, no tax, no promotion codes and no tax id", async () => {
    await provider().createSession(request());

    const params = sessionsCreate.mock.calls[0][0];

    expect(params.automatic_tax).toEqual({ enabled: false });
    expect(params.allow_promotion_codes).toBe(false);
    expect(params.tax_id_collection).toEqual({ enabled: false });
    expect(params.subscription_data).not.toHaveProperty("trial_period_days");
    expect(params.subscription_data).not.toHaveProperty("trial_end");
    expect(JSON.stringify(params)).not.toContain("trial");
  });

  it("returns to the urls it was given", async () => {
    await provider().createSession(request());

    const params = sessionsCreate.mock.calls[0][0];

    expect(params.success_url).toBe("https://app.example.invalid/dashboard");
    expect(params.cancel_url).toBe("https://app.example.invalid/dashboard");
  });

  /** Seconds, because that is what the provider takes. */
  it("passes the expiry it was given rather than one of its own", async () => {
    await provider().createSession(request());

    expect(sessionsCreate.mock.calls[0][0].expires_at).toBe(
      Math.floor(EXPIRES_AT.getTime() / 1000),
    );
  });

  /** Twelve hours: shorter than the slot, shorter than the provider's day. */
  it("names a lifetime under the provider's maximum", () => {
    expect(STRIPE_SESSION_LIFETIME_MS).toBe(12 * 60 * 60 * 1000);
    expect(STRIPE_SESSION_LIFETIME_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });

  /** A locale would move when somebody changed their language setting. */
  it("names no locale", async () => {
    await provider().createSession(request());

    expect(sessionsCreate.mock.calls[0][0]).not.toHaveProperty("locale");
  });
});

describe("the customer it names", () => {
  it("leaves the customer out when the account has none", async () => {
    await provider().createSession(request());

    expect(sessionsCreate.mock.calls[0][0]).not.toHaveProperty("customer");
  });

  it("names the one the account already has", async () => {
    await provider().createSession(request({ providerCustomerId: "cus_existing" }));

    expect(sessionsCreate.mock.calls[0][0].customer).toBe("cus_existing");
  });

  /** A customer is never searched for by address. */
  it("never looks a customer up", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe-checkout.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "customers.list",
      "customers.search",
      "customer_email",
      "email",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the key it sends", () => {
  it("is the attempt's own id", async () => {
    await provider().createSession(request());

    expect(sessionsCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: "checkout:attempt-1",
    });
  });

  it("differs between attempts", async () => {
    await provider().createSession(request({ attemptId: "attempt-a" }));
    await provider().createSession(request({ attemptId: "attempt-b" }));

    expect(sessionsCreate.mock.calls[0][1].idempotencyKey).toBe("checkout:attempt-a");
    expect(sessionsCreate.mock.calls[1][1].idempotencyKey).toBe("checkout:attempt-b");
  });

  /** The same attempt asks for the same thing, byte for byte. */
  it("sends identical parameters for the same attempt", async () => {
    await provider().createSession(request());
    await provider().createSession(request());

    expect(JSON.stringify(sessionsCreate.mock.calls[1][0])).toBe(
      JSON.stringify(sessionsCreate.mock.calls[0][0]),
    );
  });
});

describe("reading a session back", () => {
  it.each([
    ["open", "payable"],
    ["complete", "paid"],
    ["expired", "lapsed"],
    ["something_new", "unreadable"],
    [null, "unreadable"],
  ])("reads %s as %s", async (status, kind) => {
    sessionsRetrieve.mockResolvedValue({ status, url: null });

    expect(await provider().readSession("cs_test_1")).toEqual({ kind, url: null });
  });

  it("carries the url back so a payer can be returned to it", async () => {
    sessionsRetrieve.mockResolvedValue({
      status: "open",
      url: "https://pay.example.invalid/1",
    });

    expect(await provider().readSession("cs_test_1")).toEqual({
      kind: "payable",
      url: "https://pay.example.invalid/1",
    });
  });
});

/**
 * Whether the customer already has one.
 *
 * **Not "any subscription exists".** An account that cancelled last year has a
 * `canceled` subscription and is entitled to buy again; refusing it would make
 * cancellation permanent.
 */
describe("looking for a subscription that stops another", () => {
  it("asks for every status, with the list api", async () => {
    await provider().findLiveSubscription("cus_1");

    expect(subscriptionsList).toHaveBeenCalledWith({
      customer: "cus_1",
      status: "all",
      limit: 100,
    });
  });

  /** Search is eventually consistent — up to an hour behind during an outage. */
  it("never uses search", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe-checkout.ts", "utf8");

    expect(source).not.toContain("subscriptions.search");
  });

  it.each([...BLOCKING_SUBSCRIPTION_STATUSES])(
    "treats %s as one that stops another",
    async (status) => {
      subscriptionsList.mockResolvedValue({ data: [{ id: "sub_1", status }] });

      expect(await provider().findLiveSubscription("cus_1")).toEqual({
        kind: "live",
        providerSubscriptionId: "sub_1",
      });
    },
  );

  it.each(["canceled", "incomplete_expired"])(
    "lets a %s subscription be replaced",
    async (status) => {
      subscriptionsList.mockResolvedValue({ data: [{ id: "sub_old", status }] });

      expect(await provider().findLiveSubscription("cus_1")).toEqual({ kind: "none" });
    },
  );

  it("finds the live one among the finished ones", async () => {
    subscriptionsList.mockResolvedValue({
      data: [
        { id: "sub_old", status: "canceled" },
        { id: "sub_older", status: "incomplete_expired" },
        { id: "sub_live", status: "past_due" },
      ],
    });

    expect(await provider().findLiveSubscription("cus_1")).toEqual({
      kind: "live",
      providerSubscriptionId: "sub_live",
    });
  });

  it("answers none when the customer has nothing at all", async () => {
    expect(await provider().findLiveSubscription("cus_1")).toEqual({ kind: "none" });
  });

  /** A status this version does not know is not assumed to be finished. */
  it("names the statuses it blocks on explicitly", () => {
    expect([...BLOCKING_SUBSCRIPTION_STATUSES]).toEqual([
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
      "paused",
    ]);
  });
});

describe("what importing this must not do", () => {
  /** A deployment with no Stripe configuration must still start. */
  it("constructs one client, and only once the configuration is whole", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe-checkout.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect([...source.matchAll(/new Stripe\(/g)]).toHaveLength(1);
    expect(source.indexOf("new Stripe(")).toBeGreaterThan(
      source.indexOf("if (!runtime.ok)"),
    );
  });

  it("throws nothing at the top level", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe-checkout.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).not.toMatch(/^throw /m);
  });

  /** Coordination and entitlement are somebody else's. */
  it("writes to no database table", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe-checkout.ts", "utf8");

    for (const forbidden of ["prisma", "checkoutAttempt", "subscription.update"]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");

    expect(
      readFileSync("lib/billing/providers/stripe-checkout.ts", "utf8"),
    ).toContain('import "server-only"');
  });
});
