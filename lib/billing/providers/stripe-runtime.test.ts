import { describe, expect, it } from "vitest";
import {
  readStripeRuntime,
  resolveProviderReader,
  STRIPE_ENV,
} from "@/lib/billing/providers/stripe-runtime";

/**
 * Reading Stripe's configuration, and what happens when there is none.
 *
 * **The deployment this runs on has no Stripe variables at all.** So the
 * property that matters most is not that a configured deployment works — it is
 * that an unconfigured one still starts, still sweeps, and fails only the
 * subscriptions it cannot read. A module that validated its configuration when
 * it loaded would have turned a missing variable into a deployment that cannot
 * boot.
 */

const configured = {
  [STRIPE_ENV.secretKey]: "sk_test_not_a_real_key",
  [STRIPE_ENV.priceLite]: "price_lite",
  [STRIPE_ENV.priceStandard]: "price_standard",
  [STRIPE_ENV.pricePro]: "price_pro",
} as unknown as NodeJS.ProcessEnv;

describe("reading the configuration", () => {
  it("accepts a complete one", () => {
    const runtime = readStripeRuntime(configured);

    expect(runtime.ok).toBe(true);
    expect((runtime as { config: { prices: unknown } }).config.prices).toEqual({
      lite: "price_lite",
      standard: "price_standard",
      pro: "price_pro",
    });
  });

  it.each([
    ["nothing at all", {}],
    ["no key", { ...configured, [STRIPE_ENV.secretKey]: "" }],
    ["a blank key", { ...configured, [STRIPE_ENV.secretKey]: "   " }],
  ])("refuses %s", (_label, env) => {
    expect(readStripeRuntime(env as unknown as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: "no-secret-key",
    });
  });

  it.each([
    ["a missing price", { ...configured, [STRIPE_ENV.pricePro]: "" }],
    ["a blank price", { ...configured, [STRIPE_ENV.priceLite]: "  " }],
    [
      "one price used for two plans",
      { ...configured, [STRIPE_ENV.pricePro]: "price_standard" },
    ],
  ])("refuses %s", (_label, env) => {
    expect(readStripeRuntime(env as unknown as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: "no-price-catalogue",
    });
  });

  /** Unambiguous names, so nothing has to guess which price is which. */
  it("names its variables explicitly", () => {
    expect(Object.values(STRIPE_ENV)).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_PRICE_LITE",
      "STRIPE_PRICE_STANDARD",
      "STRIPE_PRICE_PRO",
    ]);
  });

  /** The key is read to be used, never to be reported. */
  it("never puts the key in what it returns", () => {
    const refused = JSON.stringify(readStripeRuntime({} as unknown as NodeJS.ProcessEnv));

    expect(refused).not.toContain("sk_");
  });
});

describe("choosing a reader for a provider", () => {
  it("gives a Stripe reader when Stripe is configured", () => {
    const resolved = resolveProviderReader(configured)("stripe");

    expect(typeof resolved).toBe("function");
  });

  /**
   * **Its own subscriptions only.** A sweep holding one Stripe subscription and
   * nine of somebody else's must still do the nine.
   */
  it.each([
    ["no configuration", {}, "no-secret-key"],
    [
      "half a catalogue",
      { ...configured, [STRIPE_ENV.priceStandard]: "" },
      "no-price-catalogue",
    ],
  ])("refuses Stripe with %s", (_label, env, reason) => {
    expect(resolveProviderReader(env as unknown as NodeJS.ProcessEnv)("stripe")).toEqual({
      unavailable: reason,
    });
  });

  /** Never another provider's reader: that would read the wrong service. */
  it.each(["app-store", "play", "some-future-provider"])(
    "refuses %s rather than handing it Stripe's",
    (provider) => {
      expect(resolveProviderReader(configured)(provider)).toEqual({
        unavailable: "unsupported-provider",
      });
    },
  );

  /** Nothing is built until a sweep actually finds work for this provider. */
  it("builds nothing when it is never asked", () => {
    const resolve = resolveProviderReader({} as unknown as NodeJS.ProcessEnv);

    expect(typeof resolve).toBe("function");
    expect(resolve("some-future-provider")).toEqual({
      unavailable: "unsupported-provider",
    });
  });
});

describe("what importing this must not do", () => {
  /**
   * **No client at module load.** Building one when the file is imported would
   * make importing a route enough to require a secret key — and this deployment
   * has none.
   */
  it("constructs no client until a reader is asked for", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "lib/billing/providers/stripe-runtime.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    const constructions = [...source.matchAll(/new Stripe\(/g)];

    expect(constructions).toHaveLength(1);
    // The one construction sits inside the resolver, after the configuration
    // has been read and found complete.
    expect(source.indexOf("new Stripe(")).toBeGreaterThan(
      source.indexOf("export function resolveProviderReader"),
    );
  });

  it("throws nothing at the top level", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "lib/billing/providers/stripe-runtime.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).not.toMatch(/^throw /m);
  });
});
