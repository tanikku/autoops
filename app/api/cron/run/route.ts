import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchDueWorkers } from "@/lib/dispatcher";
import { latestExecutionFailureAt } from "@/lib/runs";

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
 * How long a tick may take before the log says so, in milliseconds.
 *
 * Railway's edge closes a request that has transferred no data for **five
 * minutes**, and this endpoint transfers nothing until the dispatcher returns —
 * so a tick that runs past 300s is one the cron service never hears the end of.
 * Half of that is the threshold because the dispatcher works through due
 * workers **one at a time**: a tick is a sum, not an average, so a single
 * worker taking 150s is a tick that breaches the moment a second worker is
 * hired. The same 300s is also the cron interval, so the two problems — a
 * severed response and a tick still running when the next one starts — arrive
 * together rather than one giving warning of the other.
 *
 * **It is a warning value, not a policy.** Nothing here times a tick out,
 * retries it, records it, or changes what runs. The only thing it decides is
 * whether the line below is a `warn` or not — the same standing
 * `STUCK_THRESHOLD_MS` has in `lib/health.ts`, which likewise changes a display
 * and nothing else.
 */
const TICK_WARN_THRESHOLD_MS = 150_000;

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
 * Writes when execution last failed, on every tick.
 *
 * **A tick that succeeded says nothing about the runs inside it.** `dispatched`
 * counts workers that reached a provider, not workers that produced anything,
 * so a tick whose every run failed still answers `200` — and the heartbeat that
 * follows it still fires, because that heartbeat is about the cron service
 * being alive. The failures land in run history, where only the account that
 * owns the worker can see them. This is the one line an operator can watch
 * instead.
 *
 * **It is written whether or not there is anything to report**, for the reason
 * the due count is: a line that only appears sometimes cannot tell "nothing has
 * failed" from "the check did not run".
 *
 * **Observing must not be able to change what was observed.** A failure to read
 * this would otherwise escape into the handler's own catch, turn a tick that
 * worked into a `500`, and take the heartbeat down with it — the monitoring
 * deciding the outcome it was supposed to be watching. It is caught here and
 * the tick carries on, the same way releasing an execution lease refuses to
 * throw over the run it was cleaning up after.
 */
async function reportLatestExecutionFailure(): Promise<void> {
  try {
    const lastFailedAt = await latestExecutionFailureAt();

    console.log(
      `[cron] execution failures — last_failed_at=${lastFailedAt?.toISOString() ?? "none"}`,
    );
  } catch (error) {
    console.error("[cron] could not read the latest execution failure", error);
  }
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
    const startedAtMs = Date.now();
    const { dispatched, failed } = await dispatchDueWorkers(new Date());
    const durationMs = Date.now() - startedAtMs;

    // How long a tick took is knowable today only by subtracting the cron
    // container's start time from the `date` header of its response, a reading
    // no finer than a second and available only by hand. One line here puts the
    // number on the side that measured it.
    //
    // **The line is all that was added.** The call above is untouched, and so
    // is the response below: what a tick reports to its caller is the queue
    // contract, and that changes with `take` and the execution lock or not at
    // all.
    const summary = `[cron] tick finished — duration_ms=${durationMs} dispatched=${dispatched.length} failed=${failed}`;

    if (durationMs >= TICK_WARN_THRESHOLD_MS) {
      console.warn(
        `${summary} — over ${TICK_WARN_THRESHOLD_MS}ms, half of the five minutes Railway allows a response to take.`,
      );
    } else {
      console.log(summary);
    }

    await reportLatestExecutionFailure();

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
