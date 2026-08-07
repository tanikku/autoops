import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchDueWorkers } from "@/lib/dispatcher";

/**
 * Why a request was turned away, in a form safe to write to a log.
 *
 * **The four cases are kept apart on purpose.** From outside, a cron service
 * sending no header at all is indistinguishable from one sending the wrong
 * value — and knowing which it was is the whole of the diagnosis. Sprint 29
 * lost an afternoon to a `$CRON_SECRET` that was never expanded, which this
 * would have named as a mismatch rather than a missing header on the first
 * tick.
 */
type Rejection =
  | "secret-not-configured"
  | "no-authorization-header"
  | "not-a-bearer-token"
  | "token-mismatch";

/**
 * What each rejection reads as in the log.
 *
 * Written for whoever is looking at this at the time, who wants the next step
 * rather than a label: each says which side to go and look at. **Naming
 * `CRON_SECRET` is safe — the variable's name is in the README and in
 * `.env.example`. Its value never appears here, and neither does the header
 * that was sent.**
 */
const rejectionMessages: Record<Rejection, string> = {
  "secret-not-configured":
    "CRON_SECRET is not set on this service, so every request is refused. Set it here, matching the caller.",
  "no-authorization-header":
    "the request arrived with no Authorization header. Check that the caller sends one.",
  "not-a-bearer-token":
    "the Authorization header is not a Bearer token. It should read `Bearer <secret>`.",
  "token-mismatch":
    "the bearer token does not match CRON_SECRET. The header arrived intact, so the value is what differs — check the caller's, including whether its shell expanded the variable at all.",
};

/**
 * Checks the shared secret supplied by the cron service, and says what was
 * wrong when it does not check out. Null means the request may proceed.
 *
 * Fails closed: with no `CRON_SECRET` configured every request is rejected,
 * so a missing environment variable can never leave the endpoint open.
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

  // Compare in constant time so the response latency does not leak the secret.
  const matches =
    provided.length === expected.length && timingSafeEqual(provided, expected);

  return matches ? null : "token-mismatch";
}

/**
 * The entry point every cron service calls. It only hands off to the
 * dispatcher — scheduling decisions and execution stay where they are.
 */
export async function POST(request: Request) {
  const rejection = rejectionReason(request);
  if (rejection) {
    // The reason, never the value. Nothing here echoes the header or the
    // secret: a log that quoted either would be storing the secret the moment
    // a caller finally got it right.
    //
    // Until this line, a rejected tick left no trace on this side at all —
    // the caller saw a 401 and the server said nothing.
    console.warn("[cron] rejected a request —", rejectionMessages[rejection]);

    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const { dispatched, failed } = await dispatchDueWorkers(new Date());

    // `failed` is additive: `dispatched` keeps its meaning and its type, so a
    // cron service reading it carries on unchanged. Without the new field a
    // tick where every worker threw is indistinguishable from a quiet one —
    // both report zero and both return 200.
    return NextResponse.json({
      success: true,
      dispatched: dispatched.length,
      failed,
    });
  } catch (error) {
    // The cause stays in the server log; the caller only learns that it failed.
    console.error("[cron] dispatch failed", error);
    return NextResponse.json(
      { success: false, error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
