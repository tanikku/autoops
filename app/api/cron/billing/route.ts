import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { evaluateBillingHealth } from "@/lib/billing/billing-health";
import { describeBillingError } from "@/lib/billing/error-category";
import { createStripeCheckoutSessionReader } from "@/lib/billing/providers/stripe-checkout";
import { resolveProviderReader } from "@/lib/billing/providers/stripe-runtime";
import { sweepBillingReconciliations } from "@/lib/billing/sweeper";

/**
 * The tick that reconciles subscriptions which owe a look.
 *
 * **Its own route, sharing only the doorway.** The worker tick and this one are
 * called by the same cron service and checked against the same secret, and that
 * is the whole of what they have in common: nothing here reads a `Routine`,
 * takes an execution lease, or knows that workers exist. Putting billing inside
 * the worker tick would have tied two unrelated schedules together and made one
 * slow provider delay everybody's workers.
 *
 * **Dormant until something calls it.** Nothing schedules this yet, and a
 * deployment with no Stripe configuration answers with counts rather than
 * doing anything — which is the safe shape for a route that exists before the
 * thing it talks to does.
 */

// Prisma and the provider SDK are Node-only.
export const runtime = "nodejs";

/** Why a request was turned away, in a form safe to write to a log. */
type Rejection =
  | "secret-not-configured"
  | "no-authorization-header"
  | "not-a-bearer-token"
  | "token-mismatch";

const rejectionMessages: Record<Rejection, string> = {
  "secret-not-configured":
    "CRON_SECRET is not set on this service, so every request is refused. Set it here, matching the caller.",
  "no-authorization-header":
    "the request arrived with no Authorization header. Check that the caller sends one.",
  "not-a-bearer-token":
    "the Authorization header is not a Bearer token. It should read `Bearer <secret>`.",
  "token-mismatch":
    "the bearer token does not match CRON_SECRET. The header arrived intact, so the value is what differs — check the caller's.",
};

/**
 * Checks the shared secret, and says what was wrong when it does not check out.
 *
 * **The same doctrine as the worker tick**, deliberately: one cron service
 * calls both, and a second secret would be a second thing to rotate and a
 * second way to get it wrong. Fails closed — with no `CRON_SECRET` configured
 * every request is refused, so a missing variable can never leave reconciliation
 * open to anybody who finds the path.
 */
function rejectionReason(request: Request): Rejection | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return "secret-not-configured";
  }

  const header = request.headers.get("authorization");

  if (header === null) {
    return "no-authorization-header";
  }

  if (!header.startsWith("Bearer ")) {
    return "not-a-bearer-token";
  }

  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);

  // Constant time, so the response latency does not leak the secret.
  const matches =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  return matches ? null : "token-mismatch";
}

/** `key=count` pairs, in the order they were counted. */
function counts(record: Readonly<Record<string, number>>): string {
  return Object.entries(record)
    .map(([key, count]) => `${key}=${count}`)
    .join(" ");
}

function minutes(ms: number | null): string {
  return ms === null ? "none" : String(Math.floor(ms / 60_000));
}

export async function POST(request: Request) {
  const rejection = rejectionReason(request);

  if (rejection) {
    // The reason, never the value: a log that quoted either would be storing
    // the secret the moment a caller finally got it right.
    console.warn("[billing] rejected a sweep request —", rejectionMessages[rejection]);

    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const summary = await sweepBillingReconciliations({
      resolveReader: resolveProviderReader(),
      // Called only when an open checkout needs reading, so no client is built
      // on a tick with none.
      checkoutSessions: () => createStripeCheckoutSessionReader(),
    });

    // Counts and categories. No subscription id, no account, no provider
    // object: this line is read by whoever is watching the tick, not by
    // somebody investigating one account.
    console.log(
      `[billing] sweep finished — examined=${summary.examined} ${counts(summary.outcomes)} sources: ${counts(
        summary.sources,
      )} checkout-recovery: ${counts(summary.checkoutRecovery)} reasons: ${counts(summary.reasons)}`,
    );

    // **Inside the try on purpose.** A health query that fails is not a healthy
    // answer: it falls to the 500 below, and the heartbeat stops all the same.
    const health = await evaluateBillingHealth({ sweep: summary, now: new Date() });

    // Every tick, healthy or not, so a missing line means the check did not run.
    (health.critical ? console.warn : console.log)(
      `[billing] critical health — critical=${health.critical} ${counts(health.findings)} oldest-stale-pending-minutes=${minutes(
        health.oldestStalePendingMs,
      )} oldest-stale-open-checkout-minutes=${minutes(health.oldestStaleOpenCheckoutMs)}`,
    );

    // **503 only for what no retry will fix.** The work above is done and kept
    // either way; the status is what stops the cron's chain before the
    // heartbeat, so the existing dead man's switch is what raises the alarm.
    return NextResponse.json(
      {
        success: !health.critical,
        examined: summary.examined,
        outcomes: summary.outcomes,
      },
      { status: health.critical ? 503 : 200 },
    );
  } catch (error) {
    // A category in the server log, never the error itself; the caller only
    // learns that it failed.
    console.error(`[billing] sweep failed — ${describeBillingError(error)}`);

    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
