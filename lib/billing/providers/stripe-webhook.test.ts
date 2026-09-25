import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  isWakingEvent,
  readStripeDelivery,
  verifyStripeDelivery,
  WOKEN_BY,
} from "@/lib/billing/providers/stripe-webhook";

/**
 * Proving a delivery is Stripe's, and working out what it asks for.
 *
 * **Real signatures, no network and no real secret.** The SDK can both sign and
 * verify from a secret string alone, so these exercise the same code a live
 * delivery would rather than a stand-in for it — which matters, because the one
 * thing that must never be relaxed to make a test pass is the verification.
 */

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

/** A delivery signed the way Stripe signs one. */
function signed(payload: string, secret = SECRET) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

function verifiedEvent(payload: string): Stripe.Event {
  const result = verifyStripeDelivery(payload, signed(payload), SECRET);

  expect(result.ok).toBe(true);

  return (result as { event: Stripe.Event }).event;
}

describe("proving a delivery came from the provider", () => {
  it("accepts one signed with the endpoint's secret", () => {
    const payload = body();

    expect(verifyStripeDelivery(payload, signed(payload), SECRET).ok).toBe(true);
  });

  it("refuses one with no signature at all", () => {
    expect(verifyStripeDelivery(body(), null, SECRET)).toEqual({
      ok: false,
      failure: "unsigned",
    });
    expect(verifyStripeDelivery(body(), "   ", SECRET)).toEqual({
      ok: false,
      failure: "unsigned",
    });
  });

  it("refuses one whose signature does not check out", () => {
    expect(verifyStripeDelivery(body(), "t=1,v1=deadbeef", SECRET)).toEqual({
      ok: false,
      failure: "invalid",
    });
  });

  it("refuses one signed with somebody else's secret", () => {
    const payload = body();

    expect(
      verifyStripeDelivery(payload, signed(payload, "whsec_someone_else"), SECRET),
    ).toEqual({ ok: false, failure: "invalid" });
  });

  /**
   * **The signature covers the exact bytes.** Parsing the body and serialising
   * it again changes whitespace and key order, and the signature stops
   * matching — which is why nothing may read the body as JSON first.
   */
  it("refuses a body that was re-serialised on the way in", () => {
    const payload = body();
    const signature = signed(payload);
    const reSerialised = JSON.stringify(JSON.parse(payload));

    // Re-serialising is enough to break it even when nothing was changed.
    const reordered = JSON.stringify({
      data: JSON.parse(payload).data,
      id: "evt_1",
      type: "customer.subscription.updated",
    });

    expect(verifyStripeDelivery(reordered, signature, SECRET).ok).toBe(false);
    expect(reSerialised.length).toBeGreaterThan(0);
  });

  it("refuses a body with so much as a space added", () => {
    const payload = body();

    expect(verifyStripeDelivery(`${payload} `, signed(payload), SECRET).ok).toBe(
      false,
    );
  });

  /** A deployment with no secret is closed, not open. */
  it.each([undefined, "", "   "])("refuses everything when the secret is %s", (secret) => {
    const payload = body();

    expect(verifyStripeDelivery(payload, signed(payload), secret)).toEqual({
      ok: false,
      failure: "not-configured",
    });
  });

  /** Nothing about an unverified payload escapes into the answer. */
  it("says only which check failed", () => {
    const result = verifyStripeDelivery(
      body(),
      "t=1,v1=deadbeef",
      SECRET,
    ) as { failure: string };

    expect(["not-configured", "unsigned", "invalid"]).toContain(result.failure);
    expect(JSON.stringify(result)).not.toContain("sub_1");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("which deliveries are worth waking for", () => {
  it("wakes for the subscription's own lifecycle", () => {
    expect([...WOKEN_BY]).toEqual([
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]);

    for (const type of WOKEN_BY) {
      expect(isWakingEvent(type)).toBe(true);
    }
  });

  it.each([
    "invoice.paid",
    "invoice.payment_failed",
    "checkout.session.completed",
    "payment_intent.succeeded",
    "customer.created",
  ])("ignores %s", (type) => {
    const delivery = readStripeDelivery(verifiedEvent(body({ type })));

    expect(delivery).toEqual({ kind: "ignored", eventType: type });
  });

  it.each(WOKEN_BY)("records %s", (type) => {
    const delivery = readStripeDelivery(verifiedEvent(body({ type })));

    expect(delivery.kind).toBe("wake");
  });
});

describe("what gets recorded", () => {
  const receiptFor = (overrides: Record<string, unknown> = {}) => {
    const delivery = readStripeDelivery(verifiedEvent(body(overrides)));

    expect(delivery.kind).toBe("wake");

    return (delivery as { receipt: Record<string, unknown> }).receipt;
  };

  it("carries the delivery's own identity and the subscription it names", () => {
    expect(receiptFor()).toEqual({
      provider: "stripe",
      providerEventId: "evt_1",
      providerEventType: "customer.subscription.updated",
      providerSubscriptionId: "sub_1",
      providerCustomerId: "cus_1",
      providerOccurredAt: new Date(1_760_000_000 * 1000),
      providerApiVersion: "2026-08-26.dahlia",
    });
  });

  it("takes the customer from an expanded object too", () => {
    expect(
      receiptFor({
        data: { object: { id: "sub_1", customer: { id: "cus_9" } } },
      }).providerCustomerId,
    ).toBe("cus_9");
  });

  it("records nothing for a customer it cannot read", () => {
    expect(
      receiptFor({ data: { object: { id: "sub_1", customer: null } } })
        .providerCustomerId,
    ).toBeNull();
  });

  /**
   * **Never looked up.** Finding the subscription by customer would mean
   * choosing between subscriptions, and choosing is what this must not do.
   */
  it.each([
    ["no id", { id: undefined }],
    ["a blank id", { id: "   " }],
    ["an id that is not a string", { id: 12 }],
  ])("refuses a delivery naming %s", (_label, object) => {
    const delivery = readStripeDelivery(
      verifiedEvent(body({ data: { object: { ...object, customer: "cus_1" } } })),
    );

    expect(delivery.kind).toBe("unusable");
  });

  /**
   * **Kept for reading, never for ordering.** Stripe records this in whole
   * seconds and says plainly it must not be used to order events.
   */
  it("keeps the provider's own timestamp as a record only", () => {
    expect(receiptFor().providerOccurredAt).toEqual(
      new Date(1_760_000_000 * 1000),
    );
  });

  it("stores no payload", () => {
    const keys = Object.keys(receiptFor());

    for (const forbidden of ["payload", "body", "raw", "data", "object"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("names no entitlement or state", () => {
    const serialised = JSON.stringify(receiptFor());

    for (const decision of ["entitled", "grace", "ended", "active", "canceled"]) {
      expect(serialised).not.toContain(decision);
    }
  });
});

describe("what this module does not do", () => {
  it("decides no domain transition", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "lib/billing/providers/stripe-webhook.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "runReconciliation",
      "reconcileProviderSubscription",
      "subscriptions.retrieve",
      "entitlement",
    ]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});
