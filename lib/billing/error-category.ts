/**
 * What a failure was, in words that are safe to write to a log.
 *
 * **Never the error itself.** A Prisma error quotes the query and the values
 * that failed a constraint; a Stripe error carries the request's URL, its id,
 * and objects that name customers, subscriptions and sessions; an arbitrary
 * error's message is whatever its author put there. None of that may reach a
 * log line somebody reads while watching a tick. What a log needs is which kind
 * of thing went wrong — so that is all this returns.
 *
 * **A closed vocabulary, not a filter.** Only names this code recognises map to
 * a category; anything else, however harmless it looks, is `unknown-error`. A
 * class name is chosen by whoever threw it, and passing through "anything that
 * looks like an identifier" would pass through an identifier.
 */

export type BillingErrorCategory =
  | "timeout"
  | "network-error"
  | "provider-unavailable"
  | "provider-rejected"
  | "provider-auth"
  | "rate-limited"
  | "database-unreachable"
  | "database-error"
  | "constraint-error"
  | "transaction-error"
  | "not-found"
  | "query-error"
  | "livemode-mismatch"
  | "checkout-session-conflict"
  | "unreadable-attempt"
  | "provisioning-error"
  | "invalid-subscription"
  | "unknown-plan"
  | "billing-event-error"
  | "unknown-error";

/** Stripe's own error types, as the SDK names them. */
const PROVIDER: Readonly<Record<string, BillingErrorCategory>> = {
  StripeConnectionError: "network-error",
  StripeAPIError: "provider-unavailable",
  StripeRateLimitError: "rate-limited",
  StripeAuthenticationError: "provider-auth",
  StripePermissionError: "provider-auth",
  StripeInvalidRequestError: "provider-rejected",
  StripeIdempotencyError: "provider-rejected",
  StripeCardError: "provider-rejected",
  StripeSignatureVerificationError: "provider-rejected",
};

/** Errors this application throws on purpose, by class name. */
const APPLICATION: Readonly<Record<string, BillingErrorCategory>> = {
  StripeLivemodeMismatchError: "livemode-mismatch",
  CheckoutSessionConflict: "checkout-session-conflict",
  UnreadableCheckoutAttempt: "unreadable-attempt",
  UserProvisioningError: "provisioning-error",
  InvalidSubscriptionError: "invalid-subscription",
  UnknownPlanError: "unknown-plan",
  BillingEventError: "billing-event-error",
  AbortError: "timeout",
  TimeoutError: "timeout",
};

/** Prisma's request-error codes this code tells apart. Others are `database-error`. */
const PRISMA_CODE: Readonly<Record<string, BillingErrorCategory>> = {
  P2002: "constraint-error",
  P2003: "constraint-error",
  P2025: "not-found",
  P2024: "timeout",
  P2028: "transaction-error",
  P2034: "transaction-error",
};

/** A Prisma error code is four digits after a `P`, and nothing else is one. */
const PRISMA_CODE_SHAPE = /^P\d{4}$/;

function stringField(error: unknown, field: string): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * The category of a failure, and — for a database error — its Prisma code,
 * which names a kind of failure and nothing about the data.
 */
export function billingErrorCategory(error: unknown): {
  readonly category: BillingErrorCategory;
  readonly code?: string;
} {
  if (error === null || typeof error !== "object") {
    return { category: "unknown-error" };
  }

  const name = stringField(error, "name") ?? "";

  if (name.startsWith("PrismaClient")) {
    const raw = stringField(error, "code") ?? stringField(error, "errorCode");
    const code = raw !== undefined && PRISMA_CODE_SHAPE.test(raw) ? raw : undefined;

    if (name === "PrismaClientValidationError") {
      return { category: "query-error" };
    }

    if (name === "PrismaClientInitializationError" || code?.startsWith("P1")) {
      return code === undefined
        ? { category: "database-unreachable" }
        : { category: code === "P1008" ? "timeout" : "database-unreachable", code };
    }

    const category = (code !== undefined && PRISMA_CODE[code]) || "database-error";
    return code === undefined ? { category } : { category, code };
  }

  // Stripe puts its own class name in `type`; `name` is not always set to it.
  const type = stringField(error, "type");
  const provider = (type !== undefined && PROVIDER[type]) || PROVIDER[name];

  if (provider !== undefined) {
    return { category: provider };
  }

  return { category: APPLICATION[name] ?? "unknown-error" };
}

/** `category=<category>`, with ` code=<Pxxxx>` for a database error that has one. */
export function describeBillingError(error: unknown): string {
  const { category, code } = billingErrorCategory(error);
  return code === undefined ? `category=${category}` : `category=${category} code=${code}`;
}
