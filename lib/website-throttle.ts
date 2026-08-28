import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * How often AutoOps will fetch any one website.
 *
 * **This is the only guard here that is not an account's.** Everything else —
 * drafts an hour, one run at a time, twenty runs an hour, twenty workers —
 * bounds what one account can spend. This bounds what a *website* is asked to
 * serve, and a site being fetched every second cannot tell which accounts the
 * requests came from. So the row is keyed by host alone, and two accounts
 * watching the same page take turns on the same row.
 *
 * **A turn is taken by moving a time forward, not by holding anything.** There
 * is no lease, no owner token and no release: a process that dies mid-fetch
 * leaves nothing behind, and the next turn arrives on its own. That is why this
 * looks nothing like `lib/manual-run-slot.ts` despite both being about "not
 * right now" — one is asking whether something is in progress, and this one is
 * asking whether enough time has passed.
 *
 * **It never waits.** Deciding whether waiting is worth it needs a budget, and
 * the only place that knows one is the fetch that is being throttled — see
 * `lib/watcher/fetch.ts`, which is handed this function and does the waiting
 * itself. A helper that slept would be spending somebody else's allowance.
 */

/**
 * The shortest gap between two fetches of the same host.
 *
 * **Ten seconds, and the number is decided by the fetch budget rather than by
 * politeness alone.** A hop that has to wait waits inside
 * `FETCH_BUDGET_MS` (twenty seconds), so an interval near or above that would
 * make every second worker of a busy host time out instead of taking a turn a
 * moment later. Ten leaves the waiting worker half its budget to fetch in.
 *
 * As a bound it is one request per ten seconds per host across the whole
 * platform, whoever asked and whichever worker they own.
 */
export const WEBSITE_DOMAIN_INTERVAL_MS = 10_000;

/**
 * Whether a fetch of this host may begin, and if not, when it may.
 *
 * `retryAfterMs` is what the caller needs to decide whether waiting fits in
 * what it has left; it is deliberately a duration rather than an instant, so
 * nothing outside this module has to reason about clocks it did not read.
 */
export type DomainThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** Prisma's code for a unique constraint that would have been broken. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Moves the host's next-allowed time forward, if it has arrived.
 *
 * **The condition is the whole guard.** `nextAllowedAt <= now` and the write
 * that pushes it are one statement, so two fetches arriving together produce
 * one `1` and one `0` — the same shape as `claimRoutineSlot` and
 * `acquireExecutionLease`. Reading the time and comparing it in application
 * code would let both read a time that had passed and both go ahead.
 *
 * The instant of expiry counts as arrived (`lte`), which is what makes a turn
 * taken exactly ten seconds after the last one succeed rather than miss by a
 * millisecond.
 */
async function takeTurn(host: string, now: Date): Promise<boolean> {
  const { count } = await prisma.domainThrottle.updateMany({
    where: { host, nextAllowedAt: { lte: now } },
    data: {
      nextAllowedAt: new Date(now.getTime() + WEBSITE_DOMAIN_INTERVAL_MS),
    },
  });

  return count === 1;
}

/** How long is left before the stored time arrives, never negative. */
function remainingMs(nextAllowedAt: Date, now: Date): number {
  return Math.max(0, nextAllowedAt.getTime() - now.getTime());
}

/**
 * Takes this host's turn, or says how long until the next one.
 *
 * Three steps, and none of them decides from a value it read:
 *
 * 1. move the time forward if it has arrived — the common case, one statement;
 * 2. if that matched nothing, find out whether the row exists at all. A row
 *    that exists and did not match is simply not due yet, and how long until it
 *    is comes from the row itself;
 * 3. no row means this host has never been fetched, so create one already
 *    holding this turn. A `P2002` there means somebody created it in between —
 *    which is the same situation as step 1 a moment later, so step 1 is tried
 *    once more and never again.
 *
 * **The retry is bounded at one.** After the create there is a row, and asking
 * the same question repeatedly would spin against a clock that has not moved.
 *
 * **A refusal and a failure are different answers.** Not being due is ordinary
 * and comes back as a decision; a database that will not answer throws, so the
 * caller fails closed instead of treating silence as permission.
 *
 * `now` is the application's clock, as it is in every other guard here: reading
 * the database's would mean raw SQL, and passing it is what makes the boundary
 * testable without waiting.
 */
export async function acquireWebsiteDomainThrottle(
  host: string,
  now: Date = new Date(),
): Promise<DomainThrottleDecision> {
  if (await takeTurn(host, now)) {
    return { allowed: true };
  }

  const existing = await prisma.domainThrottle.findUnique({ where: { host } });

  if (existing) {
    return {
      allowed: false,
      retryAfterMs: remainingMs(existing.nextAllowedAt, now),
    };
  }

  try {
    await prisma.domainThrottle.create({
      data: {
        host,
        nextAllowedAt: new Date(now.getTime() + WEBSITE_DOMAIN_INTERVAL_MS),
      },
    });

    return { allowed: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  // Somebody created the row between the read and the write above, so they are
  // holding this turn. One more attempt in case theirs has already elapsed.
  if (await takeTurn(host, now)) {
    return { allowed: true };
  }

  const created = await prisma.domainThrottle.findUnique({ where: { host } });

  return {
    allowed: false,
    retryAfterMs: created
      ? remainingMs(created.nextAllowedAt, now)
      : WEBSITE_DOMAIN_INTERVAL_MS,
  };
}
