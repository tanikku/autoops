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
} as const;

/** Stripe's configuration, or why there isn't any. */
export type StripeRuntime =
  | { readonly ok: true; readonly secretKey: string; readonly config: StripeAdapterConfig }
  | { readonly ok: false; readonly reason: "no-secret-key" | "no-price-catalogue" };

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

  return { ok: true, secretKey, config: { prices } };
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
