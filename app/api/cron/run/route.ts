import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { dispatchDueWorkers } from "@/lib/dispatcher";

/**
 * Checks the shared secret supplied by the cron service.
 *
 * Fails closed: with no `CRON_SECRET` configured every request is rejected,
 * so a missing environment variable can never leave the endpoint open.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(secret);

  // Compare in constant time so the response latency does not leak the secret.
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

/**
 * The entry point every cron service calls. It only hands off to the
 * dispatcher — scheduling decisions and execution stay where they are.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
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
