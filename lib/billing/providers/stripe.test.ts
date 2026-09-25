import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  createStripeProviderReader,
  findCatalogueDefect,
  KOQENTRA_USER_ID_KEY,
  STRIPE_PROVIDER,
  type StripeAdapterConfig,
  translateStripeSubscription,
} from "@/lib/billing/providers/stripe";

/**
 * What Stripe's answer means, and what it is refused for.
 *
 * **No Stripe is reachable and no key is needed.** Every case is a fixture: the
 * adapter's whole job is translation, and the parts that talk to the network
 * are one function that can be handed a fake. That separation is what lets the
 * awkward cases — a second subscription item, a status nobody planned for, a
 * price that is not in the catalogue — be exercised at all, since none of them
 * can be produced on demand from a real account.
 *
 * **The refusals matter more than the successes here.** Getting `active` right
 * grants what somebody paid for; getting an unrecognised state wrong either
 * grants a plan nobody bought or withdraws one that is still owed.
 */

const PRICES = {
  lite: "price_lite_1",
  standard: "price_standard_1",
  pro: "price_pro_1",
};

const config: StripeAdapterConfig = { prices: PRICES };
const OBSERVED = new Date("2026-10-15T00:00:00.000Z");

const PERIOD_START = 1_759_276_800; // 2025-10-01T00:00:00Z
const PERIOD_END = 1_761_955_200; // 2025-11-01T00:00:00Z

/** A Stripe subscription, shaped as the SDK's type describes one. */
function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    livemode: false,
    metadata: { [KOQENTRA_USER_ID_KEY]: "google-sub-1" },
    items: {
      object: "list",
      has_more: false,
      url: "/v1/subscription_items",
      data: [item()],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function item(overrides: Record<string, unknown> = {}): Stripe.SubscriptionItem {
  return {
    id: "si_1",
    object: "subscription_item",
    quantity: 1,
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    price: { id: PRICES.standard, object: "price" },
    ...overrides,
  } as unknown as Stripe.SubscriptionItem;
}

const translate = (
  overrides: Record<string, unknown> = {},
  adapter: StripeAdapterConfig = config,
) => translateStripeSubscription(subscription(overrides), adapter, OBSERVED);

/** The snapshot of a successful translation, or a failure if it was refused. */
function snapshotOf(outcome: ReturnType<typeof translate>) {
  expect(outcome.kind, JSON.stringify(outcome)).toBe("observed");

  return (outcome as { observation: { snapshot: Record<string, unknown> } })
    .observation.snapshot;
}

describe("a subscription Koqentra can act on", () => {
  it("becomes a provider-neutral snapshot", () => {
    expect(snapshotOf(translate())).toEqual({
      provider: "stripe",
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      userId: "google-sub-1",
      plan: "standard",
      entitlement: "entitled",
      cancelAtPeriodEnd: false,
      periodStart: new Date(PERIOD_START * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
      observedAt: OBSERVED,
    });
  });

  it("names the provider from one constant", () => {
    expect(STRIPE_PROVIDER).toBe("stripe");
    expect(snapshotOf(translate()).provider).toBe(STRIPE_PROVIDER);
  });
});

describe("which account it belongs to", () => {
  it("reads the account from the subscription's own metadata", () => {
    expect(
      snapshotOf(
        translate({ metadata: { [KOQENTRA_USER_ID_KEY]: "  google-sub-2  " } }),
      ).userId,
    ).toBe("google-sub-2");
  });

  /**
   * **Never derived from anything else on the object.** An email can change
   * hands and a customer name is not an identity; the binding is an immutable
   * internal id or it is nothing.
   */
  it.each([
    ["no metadata at all", { metadata: {} }],
    ["metadata missing the key", { metadata: { plan: "standard" } }],
    ["a blank value", { metadata: { [KOQENTRA_USER_ID_KEY]: "   " } }],
  ])("refuses %s rather than guessing", (_label, overrides) => {
    expect(translate(overrides)).toEqual({
      kind: "refused",
      reason: "unknown-user",
    });
  });

  it("does not fall back to a customer email", () => {
    const outcome = translate({
      metadata: {},
      customer: { id: "cus_1", email: "someone@example.invalid" },
    });

    expect(outcome).toEqual({ kind: "refused", reason: "unknown-user" });
  });
});

describe("which customer it belongs to", () => {
  it("takes a plain id", () => {
    expect(snapshotOf(translate()).providerCustomerId).toBe("cus_1");
  });

  it("takes the id from an expanded customer", () => {
    expect(
      snapshotOf(translate({ customer: { id: "cus_9", object: "customer" } }))
        .providerCustomerId,
    ).toBe("cus_9");
  });

  /** A deleted customer still identifies the customer this belonged to. */
  it("takes the id from a deleted customer", () => {
    expect(
      snapshotOf(
        translate({ customer: { id: "cus_8", object: "customer", deleted: true } }),
      ).providerCustomerId,
    ).toBe("cus_8");
  });

  it.each([
    ["nothing", { customer: null }],
    ["an empty string", { customer: "  " }],
    ["an object with no id", { customer: { object: "customer" } }],
  ])("refuses %s", (_label, overrides) => {
    expect(translate(overrides)).toEqual({ kind: "refused", reason: "malformed" });
  });
});

describe("what is being billed", () => {
  it("accepts exactly one item", () => {
    expect(snapshotOf(translate()).plan).toBe("standard");
  });

  /**
   * **Several items are refused rather than narrowed to the first.** A second
   * item is somebody being charged for something this product does not sell,
   * and it would never appear anywhere downstream.
   */
  it.each([
    ["no items", { items: { object: "list", has_more: false, data: [] } }],
    [
      "two items",
      {
        items: {
          object: "list",
          has_more: false,
          data: [item(), item({ id: "si_2", price: { id: PRICES.pro } })],
        },
      },
    ],
    [
      "more than it was shown",
      { items: { object: "list", has_more: true, data: [item()] } },
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(translate(overrides)).toEqual({ kind: "refused", reason: "malformed" });
  });

  /** One subscription, one seat: there is no price for anything else. */
  it("refuses a quantity this product has no plan for", () => {
    expect(
      translate({
        items: { object: "list", has_more: false, data: [item({ quantity: 3 })] },
      }),
    ).toEqual({ kind: "refused", reason: "malformed" });
  });
});

describe("which plan it is", () => {
  it.each([
    ["lite", PRICES.lite],
    ["standard", PRICES.standard],
    ["pro", PRICES.pro],
  ])("maps the configured price for %s", (plan, priceId) => {
    const outcome = translate({
      items: {
        object: "list",
        has_more: false,
        data: [item({ price: { id: priceId } })],
      },
    });

    expect(snapshotOf(outcome).plan).toBe(plan);
  });

  /** No fallback: an unknown price is a plan nobody configured. */
  it.each([
    ["a price nobody configured", { id: "price_unknown" }],
    ["no price at all", undefined],
  ])("refuses %s", (_label, price) => {
    expect(
      translate({
        items: { object: "list", has_more: false, data: [item({ price })] },
      }),
    ).toEqual({ kind: "refused", reason: "unknown-plan" });
  });

  it("does not read the product's name", () => {
    const outcome = translate({
      items: {
        object: "list",
        has_more: false,
        data: [item({ price: { id: "price_unknown", nickname: "Pro" } })],
      },
    });

    expect(outcome).toEqual({ kind: "refused", reason: "unknown-plan" });
  });

  it("does not infer a plan from the amount", () => {
    const outcome = translate({
      items: {
        object: "list",
        has_more: false,
        data: [item({ price: { id: "price_unknown", unit_amount: 2480 } })],
      },
    });

    expect(outcome).toEqual({ kind: "refused", reason: "unknown-plan" });
  });
});

describe("the price catalogue itself", () => {
  it("accepts three distinct prices", () => {
    expect(findCatalogueDefect(PRICES)).toBeNull();
  });

  it.each([
    ["a blank id", { ...PRICES, lite: "  " }],
    ["a missing id", { ...PRICES, pro: "" }],
  ])("reports %s", (_label, prices) => {
    expect(findCatalogueDefect(prices)).not.toBeNull();
  });

  /** One price meaning two plans would make the mapping ambiguous. */
  it("reports the same price used twice", () => {
    expect(
      findCatalogueDefect({ ...PRICES, pro: PRICES.standard }),
    ).toContain("more than one plan");
  });

  it("refuses to translate anything against a broken catalogue", () => {
    expect(
      translate({}, { prices: { ...PRICES, pro: PRICES.lite } }),
    ).toEqual({ kind: "refused", reason: "malformed" });
  });
});

/**
 * The billing period.
 *
 * **Read from the subscription item, and provably not from the subscription.**
 * Stripe moved billing periods onto items; on the pinned API version the
 * top-level fields no longer exist at all, and this suite holds that line so
 * that a future reintroduction cannot be picked up silently.
 */
describe("the period being billed for", () => {
  it("converts the item's own seconds into instants", () => {
    const snapshot = snapshotOf(translate());

    expect(snapshot.periodStart).toEqual(new Date(PERIOD_START * 1000));
    expect(snapshot.periodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  /**
   * **The subscription's own period fields are ignored even when planted.** If
   * a future SDK put them back, this proves the adapter still reads the item.
   */
  it("ignores period fields planted on the subscription", () => {
    const snapshot = snapshotOf(
      translate({
        current_period_start: 1,
        current_period_end: 2,
      }),
    );

    expect(snapshot.periodStart).toEqual(new Date(PERIOD_START * 1000));
    expect(snapshot.periodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  it("names no top-level period field in its source", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).not.toMatch(/subscription\.current_period/);
  });

  it.each([
    ["no start", { current_period_start: undefined }],
    ["no end", { current_period_end: undefined }],
    ["a start that is not a number", { current_period_start: "soon" }],
    ["an infinite value", { current_period_end: Number.POSITIVE_INFINITY }],
    ["an end before the start", { current_period_end: PERIOD_START - 1 }],
    ["a zero-length period", { current_period_end: PERIOD_START }],
  ])("refuses %s", (_label, overrides) => {
    expect(
      translate({
        items: { object: "list", has_more: false, data: [item(overrides)] },
      }),
    ).toEqual({ kind: "refused", reason: "malformed" });
  });
});

describe("what the provider's status means", () => {
  const observe = (status: string) => translate({ status });

  it.each([
    ["active", "entitled", "none"],
    ["past_due", "grace", "none"],
    ["unpaid", "ended", "confirm-twice"],
    ["canceled", "ended", "immediate"],
  ])("maps %s", (status, entitlement, termination) => {
    const outcome = observe(status);

    expect(snapshotOf(outcome).entitlement).toBe(entitlement);
    expect(
      (outcome as { observation: { termination: string } }).observation
        .termination,
    ).toBe(termination);
  });

  /**
   * **The states this product never creates are refused, not mapped.**
   *
   * `incomplete` and `incomplete_expired` are a first payment that never
   * succeeded — Koqentra activates from a paid invoice, so there was never an
   * entitlement for these to end, and treating the expired one as terminal
   * would run a withdrawal path meant for something that was paid for.
   *
   * `trialing` and `paused` belong to Stripe's own trial, which this product
   * does not use; granting paid entitlement for either would grant something
   * nobody was charged for.
   */
  it.each(["incomplete", "incomplete_expired", "trialing", "paused"])(
    "refuses %s rather than guessing an entitlement",
    (status) => {
      expect(observe(status)).toEqual({
        kind: "refused",
        reason: "unsupported-state",
      });
    },
  );

  /**
   * **The SDK's own type admits strings it has not heard of**, so an
   * unrecognised status must land on a refusal rather than fall through to
   * anything that grants or withdraws.
   */
  it("refuses a status nobody has heard of", () => {
    expect(observe("some_future_status")).toEqual({
      kind: "refused",
      reason: "unsupported-state",
    });
  });
});

describe("a cancellation the provider has scheduled", () => {
  it.each([
    [false, false],
    [true, true],
  ])("carries cancel_at_period_end %s through", (value, expected) => {
    expect(snapshotOf(translate({ cancel_at_period_end: value })).cancelAtPeriodEnd).toBe(
      expected,
    );
  });

  /** The domain decides what that means; the adapter only reports it. */
  it("still reports the subscription as entitled", () => {
    expect(snapshotOf(translate({ cancel_at_period_end: true })).entitlement).toBe(
      "entitled",
    );
  });

  it.each(["cancel_at", "canceled_at"])(
    "does not infer a cancellation from %s",
    (field) => {
      const snapshot = snapshotOf(translate({ [field]: PERIOD_END }));

      expect(snapshot.cancelAtPeriodEnd).toBe(false);
    },
  );
});

describe("keeping test and live worlds apart", () => {
  it("accepts a subscription from the world it was configured for", () => {
    const outcome = translateStripeSubscription(
      subscription({ livemode: true }),
      { prices: PRICES, expectedLivemode: true },
      OBSERVED,
    );

    expect(outcome.kind).toBe("observed");
  });

  /** Test prices against live objects would reconcile against the wrong map. */
  it("refuses one from the other world", () => {
    const outcome = translateStripeSubscription(
      subscription({ livemode: true }),
      { prices: PRICES, expectedLivemode: false },
      OBSERVED,
    );

    expect(outcome).toEqual({ kind: "refused", reason: "malformed" });
  });

  it("checks nothing when no world was named", () => {
    expect(translate({ livemode: true }).kind).toBe("observed");
  });
});

describe("reading from the provider", () => {
  const retrieve = (subscriptionValue: unknown) =>
    vi.fn(async () => subscriptionValue as Stripe.Subscription);

  it("asks for the exact subscription, once", async () => {
    const fn = retrieve(subscription());
    const read = createStripeProviderReader(
      { subscriptions: { retrieve: fn } } as never,
      config,
      () => OBSERVED,
    );

    await read(STRIPE_PROVIDER, "sub_1");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("sub_1");
  });

  /** Searching or listing would return things the lease does not serialise. */
  it("never lists or searches", async () => {
    const list = vi.fn();
    const search = vi.fn();
    const read = createStripeProviderReader(
      { subscriptions: { retrieve: retrieve(subscription()), list, search } } as never,
      config,
      () => OBSERVED,
    );

    await read(STRIPE_PROVIDER, "sub_1");

    expect(list).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  /**
   * **The clock is read before the request, not after.** A timestamp taken once
   * the answer came back would claim the state was current at a moment the
   * reading cannot support.
   */
  it("timestamps the reading from before the request", async () => {
    const times: Date[] = [];
    const before = new Date("2026-10-15T00:00:00.000Z");
    const after = new Date("2026-10-15T00:00:05.000Z");
    let called = 0;

    const read = createStripeProviderReader(
      {
        subscriptions: {
          retrieve: vi.fn(async () => {
            called += 1;
            return subscription();
          }),
        },
      } as never,
      config,
      () => {
        const at = called === 0 ? before : after;
        times.push(at);
        return at;
      },
    );

    const outcome = await read(STRIPE_PROVIDER, "sub_1");

    expect(snapshotOf(outcome as never).observedAt).toEqual(before);
  });

  it("refuses a provider that is not this one", async () => {
    const fn = retrieve(subscription());
    const read = createStripeProviderReader(
      { subscriptions: { retrieve: fn } } as never,
      config,
    );

    expect(await read("app-store", "sub_1")).toEqual({
      kind: "refused",
      reason: "malformed",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("when the provider cannot be read", () => {
  const readWith = (error: unknown) =>
    createStripeProviderReader(
      {
        subscriptions: {
          retrieve: vi.fn(async () => {
            throw error;
          }),
        },
      } as never,
      config,
      () => OBSERVED,
    );

  it.each([
    ["a rate limit", { type: "StripeRateLimitError", statusCode: 429 }],
    ["one of their own failures", { type: "StripeAPIError", statusCode: 500 }],
    ["a connection problem", { type: "StripeConnectionError" }],
    ["something with no shape at all", new Error("socket hang up")],
  ])("leaves the work owing for %s", async (_label, error) => {
    const outcome = await readWith(error)(STRIPE_PROVIDER, "sub_1");

    expect(outcome.kind).toBe("unavailable");
  });

  /**
   * **A subscription that cannot be found is not a cancellation.** Stripe keeps
   * canceled subscriptions retrievable, so a missing one means the binding
   * points at nothing — and no amount of retrying will make it exist.
   */
  it("treats a missing subscription as permanent", async () => {
    const outcome = await readWith({
      type: "StripeInvalidRequestError",
      statusCode: 404,
    })(STRIPE_PROVIDER, "sub_1");

    expect(outcome).toEqual({ kind: "refused", reason: "malformed" });
  });

  it("treats a rejected request as permanent", async () => {
    const outcome = await readWith({ type: "StripeAuthError", statusCode: 401 })(
      STRIPE_PROVIDER,
      "sub_1",
    );

    expect(outcome).toEqual({ kind: "refused", reason: "malformed" });
  });

  /**
   * **Only the shape of the failure escapes.** A provider's error carries
   * amounts, names and sometimes an address, and none of it is needed to decide
   * whether to try again.
   */
  it("keeps nothing the error was carrying", async () => {
    const outcome = await readWith({
      type: "StripeAPIError",
      statusCode: 500,
      message: "card 4242 for alice@example.invalid was declined",
      raw: { customer_email: "alice@example.invalid" },
    })(STRIPE_PROVIDER, "sub_1");

    const reason = (outcome as { reason: string }).reason;

    expect(reason).toBe("StripeAPIError");
    expect(reason).not.toContain("4242");
    expect(reason).not.toContain("@");
  });
});

describe("where Stripe is allowed to be named", () => {
  /**
   * **One direction only.** The adapter knows about the neutral types; nothing
   * neutral knows about Stripe. A second provider is another file beside this
   * one and no change at all to the rest.
   */
  it.each([
    "lib/billing/reconcile.ts",
    "lib/billing/snapshot.ts",
    "lib/billing/subscription-writes.ts",
    "lib/billing/reconciliation-queue.ts",
    "lib/billing/orchestrate.ts",
  ])("%s does not mention Stripe", async (path) => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "stripe",
      "Stripe",
      "past_due",
      "incomplete_expired",
      "trialing",
    ]) {
      expect(source, `${path} mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("imports no provider-neutral module in the wrong direction", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/providers/stripe.ts", "utf8");

    // It may read the neutral contracts; it must never be read by them.
    expect(source).toContain('from "@/lib/billing/orchestrate"');
  });
});
