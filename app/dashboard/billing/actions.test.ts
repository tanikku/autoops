import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The doorway, and only the doorway.
 *
 * **What is fixed here is what a request may supply and what leaves.** Whether a
 * paid account may buy, how the guardrail counts, what a retry asks the provider
 * for — none of that is tested here, because none of it is decided here. It is
 * settled in `lib/billing/checkout.test.ts` against the orchestration itself.
 *
 * **The orchestration is stood in for, so the boundary can be read.** Every test
 * below either checks what was handed to it, or what came back out of the
 * action — which is the whole of what this file adds.
 */

const mocks = vi.hoisted(() => ({
  requireProvisionedUserId: vi.fn(),
  isUserProvisioningError: vi.fn(),
  startCheckout: vi.fn(),
  createStripeCheckoutProvider: vi.fn(),
}));

// **Stood in for whole**, the way every other action test does it: importing
// the real module would pull in the auth library and, with it, a server runtime
// a test has no business starting.
vi.mock("@/lib/session", () => ({
  requireProvisionedUserId: mocks.requireProvisionedUserId,
  isUserProvisioningError: mocks.isUserProvisioningError,
}));
vi.mock("@/lib/billing/checkout", () => ({ startCheckout: mocks.startCheckout }));
vi.mock("@/lib/billing/providers/stripe-checkout", () => ({
  createStripeCheckoutProvider: mocks.createStripeCheckoutProvider,
}));

const { startCheckoutAction } = await import("@/app/dashboard/billing/actions");

const USER = "116614511017733764020";
const PROVIDER = { createSession: vi.fn(), readSession: vi.fn(), findLiveSubscription: vi.fn() };

const logs: string[] = [];

beforeEach(() => {
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  // A rejection is a redirect unless a test says otherwise.
  mocks.isUserProvisioningError.mockReset().mockReturnValue(false);
  mocks.createStripeCheckoutProvider.mockReset().mockReturnValue(PROVIDER);
  mocks.startCheckout.mockReset().mockResolvedValue({
    outcome: "checkout-ready",
    attemptId: "attempt-1",
    sessionId: "cs_test_1",
    url: "https://pay.example.invalid/1",
    standing: "below-limit",
    resumed: false,
  });

  logs.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

describe("who the checkout is for", () => {
  /** The account comes from the session. A caller cannot name one. */
  it("passes the authenticated account to the orchestration", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.startCheckout.mock.calls[0][0].userId).toBe(USER);
  });

  /**
   * **The row is provisioned before a checkout is begun.** A `CheckoutAttempt`
   * carries a foreign key to `User`, so the row has to exist first.
   */
  it("provisions the account row", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.requireProvisionedUserId).toHaveBeenCalledTimes(1);
  });

  /**
   * **A redirect has to be allowed to leave.** It travels as a thrown error, and
   * swallowing it would show a signed-out visitor a message on a page they are
   * not signed in to — the same distinction `updateTimezoneAction` makes.
   */
  it("lets a signed-out visitor be redirected", async () => {
    mocks.requireProvisionedUserId.mockRejectedValue(
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT" }),
    );

    await expect(startCheckoutAction({ plan: "lite" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.createStripeCheckoutProvider).not.toHaveBeenCalled();
  });

  /** The row could not be written. Not an authentication failure, and not a
   * reason to describe the database to anybody. */
  it("answers safely when the account row cannot be written", async () => {
    mocks.requireProvisionedUserId.mockRejectedValue(
      Object.assign(new Error("could not provision"), {
        name: "UserProvisioningError",
      }),
    );
    mocks.isUserProvisioningError.mockReturnValue(true);

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "unavailable",
    });
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  /** A caller's own `userId` is not a parameter and cannot become one. */
  it("ignores an account id somebody tried to send", async () => {
    await startCheckoutAction({
      plan: "lite",
      userId: "somebody-else",
    } as unknown as Parameters<typeof startCheckoutAction>[0]);

    expect(mocks.startCheckout.mock.calls[0][0].userId).toBe(USER);
  });
});

describe("what a request may say", () => {
  it.each(["lite", "standard", "pro"])("accepts %s", async (plan) => {
    const result = await startCheckoutAction({
      plan: plan as "lite" | "standard" | "pro",
    });

    expect(result).toMatchObject({ outcome: "checkout-ready" });
    expect(mocks.startCheckout.mock.calls[0][0].plan).toBe(plan);
  });

  /**
   * **`trial` and `beta` are plans an account can be on, not ones it can buy.**
   * One begins by activating a worker; the other is granted by an operator.
   */
  it.each(["trial", "beta", "enterprise", "", "LITE", null, undefined, 1, {}])(
    "refuses %p without provisioning or calling anything",
    async (plan) => {
      const result = await startCheckoutAction({
        plan,
      } as unknown as Parameters<typeof startCheckoutAction>[0]);

      expect(result).toEqual({ outcome: "invalid-request" });
      expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
      expect(mocks.startCheckout).not.toHaveBeenCalled();
      expect(mocks.createStripeCheckoutProvider).not.toHaveBeenCalled();
    },
  );

  it("accepts an acknowledgement that is absent", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.startCheckout.mock.calls[0][0].overLimitAcknowledged).toBe(false);
  });

  it.each([true, false])("accepts %p", async (value) => {
    await startCheckoutAction({ plan: "lite", overLimitAcknowledged: value });

    expect(mocks.startCheckout.mock.calls[0][0].overLimitAcknowledged).toBe(value);
  });

  /**
   * **Only an actual `true` acknowledges anything.** This is the flag between
   * somebody and a plan that allows fewer workers than they are running, so a
   * truthy string is refused rather than read as consent.
   */
  it.each(["true", "1", 1, {}, []])(
    "refuses an acknowledgement of %p",
    async (value) => {
      const result = await startCheckoutAction({
        plan: "lite",
        overLimitAcknowledged: value,
      } as unknown as Parameters<typeof startCheckoutAction>[0]);

      expect(result).toEqual({ outcome: "invalid-request" });
      expect(mocks.startCheckout).not.toHaveBeenCalled();
    },
  );

  /** Nothing about money, an address, or a provider object is a parameter. */
  it("hands the orchestration nothing a caller sent but the plan", async () => {
    await startCheckoutAction({
      plan: "lite",
      priceId: "price_someone_elses",
      customer: "cus_someone_elses",
      metadata: { koqentra_user_id: "somebody-else" },
      successUrl: "https://evil.example.invalid",
      cancelUrl: "https://evil.example.invalid",
      quantity: 99,
      amount: 1,
      currency: "usd",
      locale: "fr",
      provider: "not-stripe",
    } as unknown as Parameters<typeof startCheckoutAction>[0]);

    expect(Object.keys(mocks.startCheckout.mock.calls[0][0]).sort()).toEqual([
      "overLimitAcknowledged",
      "plan",
      "provider",
      "userId",
    ]);
    expect(mocks.startCheckout.mock.calls[0][0].provider).toBe(PROVIDER);
  });
});

describe("where the provider comes from", () => {
  /** A provider a caller could name would be a caller choosing who is told. */
  it("builds it on the server", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.createStripeCheckoutProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createStripeCheckoutProvider).toHaveBeenCalledWith();
  });

  it("passes on its own unavailability without describing it", async () => {
    mocks.createStripeCheckoutProvider.mockReturnValue({
      unavailable: "no-secret-key",
    });
    mocks.startCheckout.mockResolvedValue({
      outcome: "unavailable",
      reason: "no-secret-key",
    });

    const result = await startCheckoutAction({ plan: "lite" });

    // The deployment's configuration is not something to explain to a browser.
    expect(result).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("what comes back", () => {
  it("returns the address to send somebody to", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({
      outcome: "checkout-ready",
      url: "https://pay.example.invalid/1",
      standing: "below-limit",
    });
  });

  /**
   * **The session id stays on the server.** A page navigates; it does not
   * reconcile — and an id in a client payload is an id in a browser history.
   */
  it("keeps the provider's identifiers to itself", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("attemptId");
    expect(result).not.toHaveProperty("resumed");
    expect(JSON.stringify(result)).not.toContain("cs_test_1");
    expect(JSON.stringify(result)).not.toContain("attempt-1");
  });

  /** A session with nowhere to go is not a session to report success for. */
  it("reports unavailable when the provider gave no address", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "checkout-ready",
      attemptId: "attempt-1",
      sessionId: "cs_test_1",
      url: null,
      standing: "below-limit",
      resumed: false,
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "unavailable",
    });
  });

  it("carries the standing through, so a page can say what it means", async () => {
    for (const standing of ["below-limit", "at-limit", "over-limit"] as const) {
      mocks.startCheckout.mockResolvedValue({
        outcome: "checkout-ready",
        attemptId: "a",
        sessionId: "s",
        url: "https://pay.example.invalid/1",
        standing,
        resumed: false,
      });

      expect(await startCheckoutAction({ plan: "lite" })).toMatchObject({ standing });
    }
  });

  it("passes the over-limit question through with its numbers", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "over-limit-confirmation-required",
      activeWorkers: 3,
      activeWorkerLimit: 2,
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "over-limit-confirmation-required",
      activeWorkers: 3,
      activeWorkerLimit: 2,
    });
  });

  it("passes a plan switch through with the plan in the way", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "plan-switch-required",
      currentPlan: "pro",
      attemptId: "attempt-1",
    });

    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({ outcome: "plan-switch-required", currentPlan: "pro" });
    expect(result).not.toHaveProperty("attemptId");
  });

  it.each([
    "already-subscribed",
    "payment-behind",
    "cancelling",
    "provider-subscription-live",
  ])("passes billing management through for %s", async (reason) => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "billing-management-required",
      reason,
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "billing-management-required",
      reason,
    });
  });

  it("passes payment-processing through without an attempt id", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "payment-processing",
      attemptId: "attempt-1",
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "payment-processing",
    });
  });

  it("passes provider-verification-unavailable through", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "provider-verification-unavailable",
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "provider-verification-unavailable",
    });
  });

  /** A deployment's own problem is not a sentence for whoever clicked Buy. */
  it.each([
    "inconsistent-subscription",
    "unreadable-entitlement",
    "no-return-url",
    "unreadable-attempt",
  ])("reduces malformed-config (%s) to unavailable", async (reason) => {
    mocks.startCheckout.mockResolvedValue({ outcome: "malformed-config", reason });

    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(reason);
  });

  /** Everything returned has to survive being sent to a browser. */
  it("returns something serialisable", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("when something unexpected goes wrong", () => {
  it("answers safely", async () => {
    mocks.startCheckout.mockRejectedValue(new Error("everything broke"));

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "unavailable",
    });
  });

  it("says nothing of the cause to the caller", async () => {
    mocks.startCheckout.mockRejectedValue(
      new Error("Invalid API Key provided: sk_test_abc for cus_secret"),
    );

    const body = JSON.stringify(await startCheckoutAction({ plan: "lite" }));

    expect(body).not.toContain("sk_test");
    expect(body).not.toContain("cus_secret");
    expect(body).not.toContain("API Key");
  });

  /**
   * **A safety failure is logged by name and answered generically.** One attempt
   * holding two sessions is not something a person did, and not something a
   * browser can act on — but it is something somebody reading a log needs to
   * see.
   */
  it("logs the category and not the message", async () => {
    const conflict = Object.assign(new Error("cs_test_a vs cs_test_b"), {
      name: "CheckoutSessionConflict",
    });
    mocks.startCheckout.mockRejectedValue(conflict);

    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({ outcome: "unavailable" });

    const written = logs.join("\n");

    expect(written).toContain("CheckoutSessionConflict");
    expect(written).not.toContain("cs_test_a");
  });
});

describe("what this file is not", () => {
  it("is a server action", async () => {
    const { readFileSync } = await import("node:fs");

    expect(readFileSync("app/dashboard/billing/actions.ts", "utf8")).toMatch(
      /^"use server";/,
    );
  });

  /**
   * **No business logic, and the imports are how that is enforced.** Anything
   * that could decide who may buy would have to be imported to be used.
   */
  it("imports only a boundary's worth of things", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).toEqual([
      "@/lib/billing/checkout-attempt",
      "@/lib/billing/checkout",
      "@/lib/billing/providers/stripe-checkout",
      "@/lib/session",
    ]);
  });

  /** Every one of these lives in the orchestration, in one copy. */
  it("decides nothing the orchestration decides", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "getPlanDefinition",
      "routine.count",
      "computeEntitlement",
      "subscription.findUnique",
      "beginCheckoutAttempt",
      "markCheckoutAttemptOpen",
      "closeCheckoutAttempt",
      "findLiveSubscription",
      "createSession",
      "idempotencyKey",
      "expires_at",
      "AUTH_URL",
      "prisma",
    ]) {
      expect(source, `decides ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("writes to no table", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const model of [
      "subscription",
      "checkoutAttempt",
      "usagePeriod",
      "billingEvent",
      "routine",
      "user",
    ]) {
      for (const write of ["create", "update", "updateMany", "delete"]) {
        expect(source, `writes ${model}.${write}`).not.toContain(`${model}.${write}`);
      }
    }
  });

  it("does not reconcile, sweep, or navigate", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "sweepBillingReconciliations",
      "runReconciliation",
      "recordProviderEventReceipt",
      "redirect(",
      "revalidatePath",
      "new Stripe",
      "stripe.checkout",
      "subscriptions.list",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** Nothing renders this yet, and nothing may until the UI slice. */
  it("is called from no page or component", async () => {
    const { execSync } = await import("node:child_process");

    const found = execSync(
      'git ls-files "app/**/*.tsx" "components/**/*.tsx" "app/**/page.ts*" || true',
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    const { readFileSync } = await import("node:fs");
    const callers = found.filter((file) =>
      readFileSync(file, "utf8").includes("billing/actions"),
    );

    expect(callers).toEqual([]);
  });
});
