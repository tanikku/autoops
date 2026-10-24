import "server-only";

import Stripe from "stripe";
import {
  createStripeProviderReader,
  findCatalogueDefect,
  STRIPE_PROVIDER,
  type StripeAdapterConfig,
} from "@/lib/billing/providers/stripe";
import type { ProviderReaderResolver } from "@/lib/billing/sweeper";

/**
 * Where Stripe's configuration is read, and when.
 *
 * **Read on use, never on import.** Production runs today with no Stripe
 * variables at all, and importing a billing route must not change that: a
 * module that validated its configuration at load would turn a missing
 * variable into a deployment that cannot start, which is a worse failure than
 * the one it was guarding against. Nothing here runs until a sweep actually
 * finds Stripe work.
 *
 * **A missing key fails Stripe's subscriptions and nothing else.** The resolver
 * answers with a reason rather than throwing, so a sweep with one Stripe
 * subscription and nine of somebody else's still does the nine.
 */

/** The variable names, stated once so nothing has to guess at them. */
export const STRIPE_ENV = {
  secretKey: "STRIPE_SECRET_KEY",
  priceLite: "STRIPE_PRICE_LITE",
  priceStandard: "STRIPE_PRICE_STANDARD",
  pricePro: "STRIPE_PRICE_PRO",
  expectedLivemode: "STRIPE_EXPECTED_LIVEMODE",
} as const;

/** Stripe's configuration, or why there isn't any. */
export type StripeRuntime =
  | { readonly ok: true; readonly secretKey: string; readonly config: StripeAdapterConfig }
  | {
      readonly ok: false;
      readonly reason:
        | "no-secret-key"
        | "no-price-catalogue"
        | "no-livemode-flag"
        | "bad-livemode-flag"
        | "key-mode-mismatch";
    };

/**
 * Which Stripe world this deployment's keys and prices belong to.
 *
 * **Set it, and a subscription from the other world is refused.** The adapter
 * can already check this; what was missing was any way to say so from the
 * environment — so a sandbox key paired with sandbox prices had nothing
 * stopping it from reconciling a live subscription that happened to reach it.
 *
 * **Required wherever Stripe is used, with no default.** Unset used to mean
 * "check nothing", which let a deployment holding a complete set of the wrong
 * world's key, prices and webhook secret run without anything noticing.
 * Defaulting instead would be this file deciding something the deployment must
 * state — "test" would refuse every live subscription the day this points at
 * real money, "live" the reverse — so an unset flag fails Stripe closed, and so
 * does a value that is neither: a typo must not read as silence.
 *
 * **Exported for the webhook**, which needs the world but not a key, so that
 * every path reads the flag the same way.
 */
export function readExpectedLivemode(
  env: NodeJS.ProcessEnv = process.env,
):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly reason: "no-livemode-flag" | "bad-livemode-flag" } {
  const trimmed = env[STRIPE_ENV.expectedLivemode]?.trim();

  if (trimmed === undefined || trimmed === "") {
    return { ok: false, reason: "no-livemode-flag" };
  }

  if (trimmed === "true") {
    return { ok: true, value: true };
  }

  if (trimmed === "false") {
    return { ok: true, value: false };
  }

  return { ok: false, reason: "bad-livemode-flag" };
}

/**
 * Which world a key belongs to, read from its prefix, or null when the prefix
 * says nothing.
 *
 * **Stripe's documented prefixes, secret and restricted alike.** `sk_test_` and
 * `rk_test_` are sandbox keys, `sk_live_` and `rk_live_` live ones. Anything
 * else — a publishable key, a truncated paste — is not guessed at: it cannot
 * prove the world the flag names, so it is refused like a mismatch.
 */
function keyLivemode(secretKey: string): boolean | null {
  if (/^(sk|rk)_live_/.test(secretKey)) {
    return true;
  }

  if (/^(sk|rk)_test_/.test(secretKey)) {
    return false;
  }

  return null;
}

/**
 * Reads Stripe's configuration from the environment it is given.
 *
 * Takes the environment rather than reaching for it, so a test can describe a
 * half-configured deployment without setting anything globally.
 */
export function readStripeRuntime(
  env: NodeJS.ProcessEnv = process.env,
): StripeRuntime {
  const secretKey = env[STRIPE_ENV.secretKey]?.trim();

  if (secretKey === undefined || secretKey === "") {
    return { ok: false, reason: "no-secret-key" };
  }

  const prices = {
    lite: env[STRIPE_ENV.priceLite]?.trim() ?? "",
    standard: env[STRIPE_ENV.priceStandard]?.trim() ?? "",
    pro: env[STRIPE_ENV.pricePro]?.trim() ?? "",
  };

  // The same check the adapter uses: three plans, all present, none sharing a
  // price with another.
  if (findCatalogueDefect(prices) !== null) {
    return { ok: false, reason: "no-price-catalogue" };
  }

  const livemode = readExpectedLivemode(env);

  if (!livemode.ok) {
    return { ok: false, reason: livemode.reason };
  }

  // **Before any client exists**, so a key from the other world never reaches
  // Stripe at all. The responses are still checked afterwards: this proves
  // what the key claims to be, and they prove what Stripe actually answered.
  if (keyLivemode(secretKey) !== livemode.value) {
    return { ok: false, reason: "key-mode-mismatch" };
  }

  return {
    ok: true,
    secretKey,
    config: { prices, expectedLivemode: livemode.value },
  };
}

/**
 * Whether an object Stripe just returned belongs to the world this deployment
 * says it is in.
 *
 * **The same flag reconciliation already checks, asked earlier.** A checkout
 * made in the wrong world can still be paid; reconciliation would then refuse
 * the subscription it produced, and somebody would have paid for an entitlement
 * that never arrives. Asking here keeps that page from being handed out at all.
 *
 * A value that is not a boolean does not match either world, so an object whose
 * `livemode` is missing is refused.
 */
export function matchesExpectedLivemode(
  config: StripeAdapterConfig,
  livemode: unknown,
): boolean {
  return livemode === config.expectedLivemode;
}

/**
 * Thrown when Stripe answers from the other world.
 *
 * **A name and nothing else.** No session, no customer, no address: whoever
 * catches it decides what a person is told, and none of it identifies anybody.
 */
export class StripeLivemodeMismatchError extends Error {
  constructor() {
    super("Stripe answered from a different mode than this deployment expects");
    this.name = "StripeLivemodeMismatchError";
  }
}

/**
 * Which reader a sweep should use for a provider.
 *
 * **The client is built here and nowhere earlier.** Constructing one at module
 * load would make importing a route enough to require a secret key.
 */
export function resolveProviderReader(
  env: NodeJS.ProcessEnv = process.env,
): ProviderReaderResolver {
  return (provider) => {
    if (provider !== STRIPE_PROVIDER) {
      // Never another provider's reader: answering with Stripe's would
      // reconcile somebody's subscription against the wrong service entirely.
      return { unavailable: "unsupported-provider" };
    }

    const runtime = readStripeRuntime(env);

    if (!runtime.ok) {
      return { unavailable: runtime.reason };
    }

    return createStripeProviderReader(
      new Stripe(runtime.secretKey),
      runtime.config,
    );
  };
}
