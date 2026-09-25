import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/**
 * The door Stripe knocks on.
 *
 * **The invariant these exist for is the order of two things**: the delivery is
 * recorded, and only then is success sent. Stripe stops retrying on a `2xx`, so
 * answering first and writing afterwards would lose a delivery to a process
 * that died a moment later, and nothing would ever ask again. Several of the
 * cases below do nothing but hold that line.
 *
 * **Real signatures throughout.** The SDK signs and verifies from a secret
 * string alone, so these exercise the verification a live delivery meets rather
 * than a stand-in for it.
 */

const recordProviderEventReceipt = vi.fn();

vi.mock("@/lib/billing/reconciliation-queue", () => ({
  recordProviderEventReceipt,
}));

const { POST } = await import("@/app/api/webhooks/stripe/route");

const SECRET = "whsec_test_only_not_a_real_secret";

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "customer.subscription.updated",
    created: 1_760_000_000,
    api_version: "2026-08-26.dahlia",
    data: { object: { id: "sub_1", object: "subscription", customer: "cus_1" } },
    ...overrides,
  });
}

function deliver(
  payload: string,
  signature: string | null = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: SECRET,
  }),
) {
  return POST(
    new Request("https://app.example.invalid/api/webhooks/stripe", {
      method: "POST",
      body: payload,
      headers: signature === null ? {} : { "stripe-signature": signature },
    }),
  );
}

const logs: string[] = [];

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  recordProviderEventReceipt
    .mockReset()
    .mockResolvedValue({ outcome: "recorded", receivedAt: new Date() });

  logs.length = 0;
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("a delivery that proves it is Stripe's", () => {
  it("is recorded and acknowledged", async () => {
    const response = await deliver(body());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, recorded: true });
    expect(recordProviderEventReceipt).toHaveBeenCalledTimes(1);
  });

  it("records the subscription the delivery names", async () => {
    await deliver(body());

    expect(recordProviderEventReceipt.mock.calls[0][0]).toMatchObject({
      provider: "stripe",
      providerEventId: "evt_1",
      providerEventType: "customer.subscription.updated",
      providerSubscriptionId: "sub_1",
    });
  });

  /**
   * **A redelivery is a success.** The first one is already recorded and the
   * subscription already owes a look; anything else would have Stripe retry
   * something that is done, for three days.
   */
  it("acknowledges a redelivery without recording a second", async () => {
    recordProviderEventReceipt.mockResolvedValue({ outcome: "duplicate" });

    const response = await deliver(body());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, recorded: false });
  });
});

describe("a delivery that does not prove it", () => {
  it.each([
    ["no signature", null],
    ["a signature that does not check out", "t=1,v1=deadbeef"],
  ])("is refused when it has %s", async (_label, signature) => {
    const response = await deliver(body(), signature);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Bad Request",
    });
    expect(recordProviderEventReceipt).not.toHaveBeenCalled();
  });

  it("is refused when the body was altered after signing", async () => {
    const payload = body();
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
    });

    const response = await deliver(`${payload} `, signature);

    expect(response.status).toBe(400);
    expect(recordProviderEventReceipt).not.toHaveBeenCalled();
  });

  /** A deployment with no secret is closed, not open. */
  it("is refused when this deployment has no secret to check it against", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const response = await deliver(body());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "Not Configured",
    });
    expect(recordProviderEventReceipt).not.toHaveBeenCalled();
  });
});

describe("a delivery about something else", () => {
  it.each(["invoice.paid", "checkout.session.completed", "customer.created"])(
    "is acknowledged and forgotten: %s",
    async (type) => {
      const response = await deliver(body({ type }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, recorded: false });
      expect(recordProviderEventReceipt).not.toHaveBeenCalled();
    },
  );

  /** Another attempt would reach the same conclusion. */
  it("is acknowledged when it names no subscription", async () => {
    const response = await deliver(body({ data: { object: { customer: "cus_1" } } }));

    expect(response.status).toBe(200);
    expect(recordProviderEventReceipt).not.toHaveBeenCalled();
  });
});

/**
 * Durability before acknowledgement.
 *
 * **The whole reason this route exists in this shape.** Stripe stops retrying
 * once it sees a `2xx`.
 */
describe("when the delivery cannot be recorded", () => {
  it("is not acknowledged", async () => {
    recordProviderEventReceipt.mockRejectedValue(new Error("database is down"));

    const response = await deliver(body());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: "Internal Server Error",
    });
  });

  it("says nothing of the cause to the caller", async () => {
    recordProviderEventReceipt.mockRejectedValue(
      new Error("connection to postgres://user:pw@host failed"),
    );

    const body_ = await (await deliver(body())).json();

    expect(JSON.stringify(body_)).not.toContain("postgres");
    expect(JSON.stringify(body_)).not.toContain("pw@");
  });

  /**
   * **The answer waits for the write.** If the response were produced first,
   * this would resolve before the recorder ever settled.
   */
  it("waits for the write before answering", async () => {
    let settled = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    recordProviderEventReceipt.mockImplementation(async () => {
      await held;
      settled = true;
      return { outcome: "recorded", receivedAt: new Date() };
    });

    const pending = deliver(body());
    let answered = false;

    void pending.then(() => {
      answered = true;
    });

    // Long enough for a route that answered early to have done so.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(answered).toBe(false);
    expect(settled).toBe(false);

    release();
    await pending;

    expect(settled).toBe(true);
  });
});

describe("what the route never does", () => {
  it("never reconciles and never reaches the provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/webhooks/stripe/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "runReconciliation",
      "reconcileProviderSubscription",
      "subscriptions.retrieve",
      "new Stripe(",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** The bytes must survive intact, so they are never parsed as JSON first. */
  it("never parses the body before verifying it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/webhooks/stripe/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).toContain("request.text()");
    expect(source).not.toContain("request.json()");
  });

  it("logs nothing of the payload or the secret", async () => {
    await deliver(body());
    await deliver(body({ type: "invoice.paid" }));
    await deliver(body(), "t=1,v1=deadbeef");

    const written = logs.join("\n");

    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("cus_1");
    expect(written).not.toContain("sub_1");
    expect(written).not.toContain("v1=");
  });

  /** Stripe's signature is the authentication; there is no session here. */
  it("asks for no session", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/webhooks/stripe/route.ts", "utf8");

    expect(source).not.toContain("auth(");
    expect(source).not.toContain("getServerSession");
  });

  it("runs on the Node runtime", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/webhooks/stripe/route.ts", "utf8");

    expect(source).toContain('export const runtime = "nodejs"');
  });
});
