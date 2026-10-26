import { describe, expect, it } from "vitest";
import { billingErrorCategory, describeBillingError } from "@/lib/billing/error-category";

/**
 * What a failure was, in words safe for a log — and nothing of what it said.
 */

const SECRETS = [
  "secret-token-123",
  "sk_live_abcdef",
  "https://api.stripe.com/v1/subscriptions/sub_123",
  "sub_123",
  "cus_456",
  "cs_test_789",
  "req_abc",
  "user-1",
  "alice@example.com",
  "postgresql://autoops:pw@db.internal",
  "at Object.<anonymous>",
];

/** None of what an error carried appears in what is written. */
function expectNothingLeaks(error: unknown) {
  const written = describeBillingError(error);
  for (const secret of SECRETS) {
    expect(written, `leaks ${secret}`).not.toContain(secret);
  }
  return written;
}

describe("what is never written", () => {
  it("drops the message of a plain error", () => {
    expect(expectNothingLeaks(new Error("secret-token-123"))).toBe("category=unknown-error");
  });

  it("drops a provider's body, URL, ids and request id", () => {
    const stripe = Object.assign(new Error("No such subscription: 'sub_123'"), {
      type: "StripeInvalidRequestError",
      statusCode: 404,
      requestId: "req_abc",
      raw: { message: "cus_456 alice@example.com", url: "https://api.stripe.com/v1/subscriptions/sub_123" },
      headers: { authorization: "Bearer sk_live_abcdef" },
    });

    expect(expectNothingLeaks(stripe)).toBe("category=provider-rejected");
  });

  it("drops a Prisma error's meta, target and query", () => {
    const prisma = Object.assign(new Error("Unique constraint failed on user-1 alice@example.com"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["email"], modelName: "User", value: "alice@example.com" },
      clientVersion: "7.9.0",
    });

    expect(expectNothingLeaks(prisma)).toBe("category=constraint-error code=P2002");
  });

  it("drops the stack", () => {
    const error = new Error("cs_test_789 at db.internal");
    expect(error.stack).toBeDefined();

    expect(expectNothingLeaks(error)).toBe("category=unknown-error");
  });

  /** A class name is chosen by whoever threw it; only known ones are named. */
  it("does not pass an unknown name through, however harmless it looks", () => {
    for (const name of ["sub_123", "user-1", "TypeError", "MyCustomError", "alice@example.com"]) {
      const error = Object.assign(new Error("x"), { name });
      expect(expectNothingLeaks(error)).toBe("category=unknown-error");
    }
  });

  it("does not pass a code through unless it has a Prisma code's shape", () => {
    const error = Object.assign(new Error("x"), {
      name: "PrismaClientKnownRequestError",
      code: "sub_123",
    });

    expect(expectNothingLeaks(error)).toBe("category=database-error");
  });

  it.each([undefined, null, "secret-token-123", 42, { message: "user-1" }])(
    "says unknown for %j",
    (value) => {
      expect(expectNothingLeaks(value)).toBe("category=unknown-error");
    },
  );
});

describe("what is written instead", () => {
  it.each([
    ["StripeConnectionError", "network-error"],
    ["StripeAPIError", "provider-unavailable"],
    ["StripeRateLimitError", "rate-limited"],
    ["StripeAuthenticationError", "provider-auth"],
    ["StripePermissionError", "provider-auth"],
    ["StripeInvalidRequestError", "provider-rejected"],
    ["StripeIdempotencyError", "provider-rejected"],
  ])("names %s as %s, by type or by name", (type, category) => {
    expect(billingErrorCategory(Object.assign(new Error("x"), { type })).category).toBe(category);
    expect(billingErrorCategory(Object.assign(new Error("x"), { name: type })).category).toBe(category);
  });

  it.each([
    ["P2002", "constraint-error"],
    ["P2003", "constraint-error"],
    ["P2025", "not-found"],
    ["P2024", "timeout"],
    ["P2028", "transaction-error"],
    ["P2034", "transaction-error"],
    ["P2039", "database-error"],
  ])("names Prisma %s as %s, keeping the code", (code, category) => {
    const error = Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code });

    expect(billingErrorCategory(error)).toEqual({ category, code });
  });

  it.each([
    ["PrismaClientInitializationError", {}, "category=database-unreachable"],
    ["PrismaClientInitializationError", { errorCode: "P1001" }, "category=database-unreachable code=P1001"],
    ["PrismaClientKnownRequestError", { code: "P1008" }, "category=timeout code=P1008"],
    ["PrismaClientValidationError", {}, "category=query-error"],
    ["PrismaClientUnknownRequestError", {}, "category=database-error"],
    ["PrismaClientRustPanicError", {}, "category=database-error"],
  ])("names %s %j", (name, fields, written) => {
    expect(describeBillingError(Object.assign(new Error("x"), { name, ...fields }))).toBe(written);
  });

  it.each([
    ["StripeLivemodeMismatchError", "livemode-mismatch"],
    ["CheckoutSessionConflict", "checkout-session-conflict"],
    ["UnreadableCheckoutAttempt", "unreadable-attempt"],
    ["UserProvisioningError", "provisioning-error"],
    ["InvalidSubscriptionError", "invalid-subscription"],
    ["UnknownPlanError", "unknown-plan"],
    ["BillingEventError", "billing-event-error"],
    ["AbortError", "timeout"],
    ["TimeoutError", "timeout"],
  ])("names this application's %s as %s", (name, category) => {
    expect(billingErrorCategory(Object.assign(new Error("x"), { name })).category).toBe(category);
  });
});
