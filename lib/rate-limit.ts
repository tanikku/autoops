import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * How much of a rate-limited action an account may take, and in what span.
 *
 * **One allowance, for drafting a worker with AI.** This is not a metering,
 * billing or plan system, and the shape here is deliberately too small to
 * become one: there is a single scope, a single limit, and no way to ask how
 * much of it is left. What it is for is one thing — an account cannot spend an
 * unbounded amount of somebody else's money by holding down a button on a
 * form.
 *
 * **The counter lives in the database, and that is the whole design.** A limit
 * kept in the process resets on every deploy and restart, and stops being one
 * limit at all the moment a second replica exists — both of which are ordinary
 * on the platform this runs on rather than hypothetical.
 *
 * **`consumeAiDraftQuota` is the only way in.** Nothing reads the count and
 * decides: the limit is a condition inside the write, so two requests arriving
 * together are separated by the database rather than by whichever of them read
 * first. See the note on that function for why every step is a conditional
 * `updateMany`.
 *
 * **It bounds AI drafts, and only those.** Running a worker by hand is not
 * bounded by anything, here or elsewhere, and nothing in this module should be
 * read as saying otherwise.
 */

/** How many AI drafts one account may ask for inside a window. */
export const AI_DRAFT_LIMIT = 10;

/**
 * How long a window lasts, measured from the request that opened it.
 *
 * **A fixed span, not a calendar hour.** Nothing rounds to the top of the hour
 * and nothing consults a timezone: the window starts at the instant the first
 * request arrives and ends exactly an hour later, which is the same rule for
 * every account wherever it is. An hour that ends on the clock's hour would
 * give somebody arriving at 10:59 two full allowances in two minutes.
 *
 * **Exactly one hour later is still the same window.** The boundary is `>=`,
 * so the first request *past* the hour is the one that opens a new one.
 */
export const AI_DRAFT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Which allowance the rows above belong to.
 *
 * A constant rather than a literal at the call site: the column is a plain
 * string, so a typo would silently give an account a second, empty allowance
 * instead of failing.
 */
export const AI_DRAFT_SCOPE = "worker-draft";

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
 * Takes one from a live window, if it has room.
 *
 * **The limit is in the `WHERE` and the addition is the database's**, which is
 * what makes this safe to run twice at once: two callers finding a count of
 * nine produce one row updated and one row not, because only one of them
 * matches a row whose count is still under the limit. Reading the count and
 * deciding in application code would let both read nine and both write ten.
 *
 * `windowStartedAt >= floor` is what "live" means — an older window is not
 * matched here at all, so a full window that has expired is left for the
 * rollover below rather than being mistaken for a full one that has not.
 */
async function takeFromLiveWindow(
  userId: string,
  floor: Date,
): Promise<boolean> {
  const { count } = await prisma.rateLimitBucket.updateMany({
    where: {
      userId,
      scope: AI_DRAFT_SCOPE,
      windowStartedAt: { gte: floor },
      count: { lt: AI_DRAFT_LIMIT },
    },
    data: { count: { increment: 1 } },
  });

  return count === 1;
}

/**
 * Spends one AI draft from this account's allowance.
 *
 * **Four steps, each one a write with its own condition, and no read that a
 * decision is made from.** They are in this order because each one describes a
 * state the row can be in, and the earlier ones are the common cases:
 *
 * 1. a live window with room — increment it;
 * 2. a window that has expired — start a new one at `now` with a count of one;
 * 3. no row at all — create one, which is where a brand-new account arrives;
 * 4. and if the create lost a race, try the first step once more, because the
 *    request that beat us to it has left a live window behind.
 *
 * **The retry is once and is not a loop.** After step 3 there is a row, so the
 * only thing that can still deny the request is a window that is genuinely
 * full — and retrying that would spin without changing anything. The one
 * remaining race, a window expiring between steps, resolves on the caller's
 * next request rather than being chased here.
 *
 * **A denial and a failure are not the same answer.** `false` means the
 * allowance is spent, which is an ordinary thing to tell somebody; a database
 * that would not answer throws, because the caller has to fail closed rather
 * than treat it as a quiet "no". This is the same split
 * `acquireExecutionLease` makes between `null` and a rejection.
 *
 * **Consuming is not reserving.** Whatever the caller does next may fail, and
 * nothing here gives the allowance back — the request was made, and the cost
 * it guards was already incurred by the time anyone knows how it went.
 *
 * `now` is the application's clock, exactly as it is in `acquireExecutionLease`
 * and for the same reason: reading the database's would mean raw SQL, and the
 * difference only shows up once more than one process is writing. Passing it
 * is also what makes the window boundary testable without moving the clock.
 *
 * @returns `true` when the request may go ahead, `false` when the allowance is
 *   spent. A database failure throws, because it is neither.
 */
export async function consumeAiDraftQuota(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const floor = new Date(now.getTime() - AI_DRAFT_WINDOW_MS);

  if (await takeFromLiveWindow(userId, floor)) {
    return true;
  }

  // An expired window is replaced rather than cleared: the row is the same one,
  // and the write that moves it is also the write that takes the first request
  // of the new window. Splitting those in two would leave a window open with
  // nothing counted against it.
  const rolled = await prisma.rateLimitBucket.updateMany({
    where: {
      userId,
      scope: AI_DRAFT_SCOPE,
      windowStartedAt: { lt: floor },
    },
    data: { windowStartedAt: now, count: 1 },
  });

  if (rolled.count === 1) {
    return true;
  }

  const existing = await prisma.rateLimitBucket.findUnique({
    where: { userId_scope: { userId, scope: AI_DRAFT_SCOPE } },
  });

  if (!existing) {
    try {
      await prisma.rateLimitBucket.create({
        data: {
          userId,
          scope: AI_DRAFT_SCOPE,
          windowStartedAt: now,
          count: 1,
        },
      });

      return true;
    } catch (error) {
      // Somebody else created the account's row between the read above and
      // this write. That is the unique constraint doing its job, and the row
      // that now exists is a live window with one request in it — so this is
      // the same situation as step 1, arrived at a moment later.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  return takeFromLiveWindow(userId, floor);
}
