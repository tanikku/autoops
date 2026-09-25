import { NextResponse } from "next/server";
import {
  readStripeDelivery,
  verifyStripeDelivery,
} from "@/lib/billing/providers/stripe-webhook";
import { recordProviderEventReceipt } from "@/lib/billing/reconciliation-queue";

/**
 * Where Stripe tells Koqentra that something may have changed.
 *
 * **It records and answers. It decides nothing.** No subscription is fetched,
 * no entitlement is worked out, no domain row is written — because none of that
 * can be done correctly from a delivery. Stripe does not guarantee the order
 * deliveries arrive in, and stamps their times in whole seconds, so two of them
 * can be indistinguishable; acting on one would be acting on a guess. What
 * happens instead is that the subscription is marked as owing a look, and a
 * later reconciliation reads Stripe's *current* state and acts on that.
 *
 * **Success is only sent once the record is committed.** Stripe stops retrying
 * on a `2xx`, so answering before the write landed would let a delivery be lost
 * to a process that died a moment later — and nothing would ever ask again. The
 * write is awaited; there is no fire-and-forget, and no work scheduled to
 * outlive the response.
 *
 * **The signature is the authentication.** There is no session here and no
 * login: the caller is Stripe because the bytes verify against the endpoint's
 * secret, and nothing is read out of the body until they do.
 */

// Signature verification and the database driver are both Node-only, and the
// raw body has to survive intact — none of which Edge offers.
export const runtime = "nodejs";

/** What the caller is told, with nothing of the cause in it. */
function answer(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  // **Read as text, and only as text.** The signature covers the exact bytes
  // Stripe sent; `request.json()` would hand back an object that cannot be
  // turned back into them, and the verification would fail for a delivery that
  // was perfectly good.
  const rawBody = await request.text();

  const verified = verifyStripeDelivery(
    rawBody,
    request.headers.get("stripe-signature"),
    process.env.STRIPE_WEBHOOK_SECRET,
  );

  if (!verified.ok) {
    if (verified.failure === "not-configured") {
      // Nothing is accepted without a secret to check it against. A deployment
      // that has not been given one is not open; it is closed.
      console.error(
        "[billing] a Stripe delivery arrived but STRIPE_WEBHOOK_SECRET is not set",
      );

      return answer(503, { success: false, error: "Not Configured" });
    }

    // The reason, never the header and never the body: an unverified payload is
    // by definition something a stranger may have written.
    console.warn(`[billing] rejected a Stripe delivery — ${verified.failure}`);

    return answer(400, { success: false, error: "Bad Request" });
  }

  const delivery = readStripeDelivery(verified.event);

  if (delivery.kind !== "wake") {
    // Answered rather than retried: another attempt would reach the same
    // conclusion, and Stripe would go on sending it for three days.
    console.log(
      `[billing] ignored a Stripe delivery — type=${delivery.eventType} reason=${delivery.kind}`,
    );

    return answer(200, { success: true, recorded: false });
  }

  try {
    const recorded = await recordProviderEventReceipt(delivery.receipt);

    console.log(
      `[billing] recorded a Stripe delivery — type=${delivery.receipt.providerEventType} outcome=${recorded.outcome}`,
    );

    // A redelivery is a success: the first one is already recorded, and the
    // subscription already owes a look. Answering anything else would have
    // Stripe retry something that is done.
    return answer(200, { success: true, recorded: recorded.outcome === "recorded" });
  } catch (error) {
    // **Nothing landed, so nothing may be acknowledged.** A non-2xx is what
    // keeps the delivery alive in Stripe's retry schedule.
    console.error("[billing] could not record a Stripe delivery", error);

    return answer(500, { success: false, error: "Internal Server Error" });
  }
}
