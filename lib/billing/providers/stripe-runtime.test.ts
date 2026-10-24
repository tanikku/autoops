import { describe, expect, it } from "vitest";
import {
  matchesExpectedLivemode,
  readStripeRuntime,
  resolveProviderReader,
  STRIPE_ENV,
  StripeLivemodeMismatchError,
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
  [STRIPE_ENV.expectedLivemode]: "false",
} as unknown as NodeJS.ProcessEnv;

/** The same configuration with a given key and world. */
function withKey(key: string, flag: string) {
  return {
    ...configured,
    [STRIPE_ENV.secretKey]: key,
    [STRIPE_ENV.expectedLivemode]: flag,
  } as unknown as NodeJS.ProcessEnv;
}

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
      "STRIPE_EXPECTED_LIVEMODE",
    ]);
  });

  /** The key is read to be used, never to be reported. */
  it("never puts the key in what it returns", () => {
    const refused = JSON.stringify(readStripeRuntime({} as unknown as NodeJS.ProcessEnv));

    expect(refused).not.toContain("sk_");
  });
});

/**
 * Which Stripe world this deployment belongs to.
 *
 * **The guard the adapter always had and the environment could not reach.** A
 * sandbox key paired with sandbox prices had nothing stopping it reconciling a
 * live subscription that happened to arrive — the check existed, but no
 * deployment could ask for it.
 */
describe("saying which Stripe world the configuration is for", () => {
  it.each([
    ["false", false],
    ["true", true],
    ["  false  ", false],
  ])("reads %s", (raw, expected) => {
    const runtime = readStripeRuntime(
      withKey(expected ? "sk_live_not_a_real_key" : "sk_test_not_a_real_key", raw),
    );

    expect(runtime.ok).toBe(true);
    expect(
      (runtime as { config: { expectedLivemode?: boolean } }).config
        .expectedLivemode,
    ).toBe(expected);
  });

  /**
   * **Unset fails Stripe closed.** It used to mean "check nothing"; defaulting
   * either way would instead decide something the deployment must state.
   */
  it.each([undefined, "", "   "])("refuses the configuration when it is %j", (raw) => {
    const env = { ...configured } as Record<string, string | undefined>;

    if (raw === undefined) delete env[STRIPE_ENV.expectedLivemode];
    else env[STRIPE_ENV.expectedLivemode] = raw;

    expect(readStripeRuntime(env as unknown as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: "no-livemode-flag",
    });
  });

  it("fails Stripe closed without a flag, for the sweep too", () => {
    const env = { ...configured } as Record<string, string | undefined>;
    delete env[STRIPE_ENV.expectedLivemode];

    expect(resolveProviderReader(env as unknown as NodeJS.ProcessEnv)("stripe")).toEqual({
      unavailable: "no-livemode-flag",
    });
  });

  /** A deployment with no Stripe at all is still just "no key", flag or not. */
  it("still calls a deployment with no Stripe at all keyless", () => {
    expect(readStripeRuntime({} as unknown as NodeJS.ProcessEnv)).toEqual({
      ok: false,
      reason: "no-secret-key",
    });
  });

  /** A typo must not read as silence. */
  it.each(["no", "0", "FALSE", "sandbox", "off"])(
    "refuses the configuration when it says %s",
    (raw) => {
      expect(
        readStripeRuntime({
          ...configured,
          [STRIPE_ENV.expectedLivemode]: raw,
        } as unknown as NodeJS.ProcessEnv),
      ).toEqual({ ok: false, reason: "bad-livemode-flag" });
    },
  );

  it("fails Stripe closed rather than reading it without a world", () => {
    expect(
      resolveProviderReader({
        ...configured,
        [STRIPE_ENV.expectedLivemode]: "maybe",
      } as unknown as NodeJS.ProcessEnv)("stripe"),
    ).toEqual({ unavailable: "bad-livemode-flag" });
  });
});

/**
 * Whether the key belongs to the world the flag names, decided from its prefix
 * before any client exists — so a key from the other world never reaches
 * Stripe. Secret and restricted keys alike.
 */
describe("checking the key's world before Stripe is asked anything", () => {
  it.each([
    ["sk_test_x", "false"],
    ["rk_test_x", "false"],
    ["sk_live_x", "true"],
    ["rk_live_x", "true"],
  ])("accepts %s when the flag is %s", (key, flag) => {
    const runtime = readStripeRuntime(withKey(key, flag));

    expect(runtime.ok).toBe(true);
    expect(
      (runtime as { config: { expectedLivemode: boolean } }).config.expectedLivemode,
    ).toBe(flag === "true");
  });

  it.each([
    ["sk_live_x", "false"],
    ["rk_live_x", "false"],
    ["sk_test_x", "true"],
    ["rk_test_x", "true"],
  ])("refuses %s when the flag is %s", (key, flag) => {
    expect(readStripeRuntime(withKey(key, flag))).toEqual({
      ok: false,
      reason: "key-mode-mismatch",
    });
  });

  /** A prefix that proves neither world is not guessed at. */
  it.each([
    ["pk_test_x", "false"],
    ["pk_live_x", "true"],
    ["sk_x", "false"],
    ["whsec_x", "true"],
    ["SK_TEST_x", "false"],
    ["not-a-key", "true"],
  ])("refuses %s, whose world cannot be told, when the flag is %s", (key, flag) => {
    expect(readStripeRuntime(withKey(key, flag))).toEqual({
      ok: false,
      reason: "key-mode-mismatch",
    });
  });

  it("refuses the sweep its reader when the key is from the other world", () => {
    expect(resolveProviderReader(withKey("rk_live_x", "false"))("stripe")).toEqual({
      unavailable: "key-mode-mismatch",
    });
  });

  it("never puts the key in a refusal", () => {
    const refused = JSON.stringify(readStripeRuntime(withKey("sk_live_secret_value", "false")));

    expect(refused).not.toContain("sk_live_secret_value");
  });
});

/**
 * Whether something Stripe returned is from the world the flag names.
 *
 * **One comparison, shared by checkout and the portal**, so the two cannot come
 * to read the same flag differently.
 */
describe("matching an object to the expected world", () => {
  const prices = {
    lite: "price_lite",
    standard: "price_standard",
    pro: "price_pro",
  };

  it.each([
    [true, true, true],
    [true, false, false],
    [false, false, true],
    [false, true, false],
    [true, undefined, false],
    [false, undefined, false],
    [false, null, false],
    [true, "true", false],
  ])("expects %j, given %j → %j", (expected, livemode, matches) => {
    expect(
      matchesExpectedLivemode({ prices, expectedLivemode: expected }, livemode),
    ).toBe(matches);
  });

  it("names its refusal and nothing else", () => {
    const error = new StripeLivemodeMismatchError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StripeLivemodeMismatchError");
    expect(error.message).not.toMatch(/cs_|bps_|cus_|sub_|https?:/);
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
