import "server-only";

import { prisma } from "@/lib/prisma";
import { openOrGetUsagePeriod } from "@/lib/usage/period";
import type { UsageKind } from "@/lib/usage/types";

/**
 * Counting what accounts actually use, before anything is allowed to stop them.
 *
 * **This is not `consumeUsage`, and the difference is the whole file.** That
 * function asks permission: it refuses when an allowance is spent, and it does
 * so inside the write so two callers cannot both slip past a boundary. It is
 * the shape hard enforcement will need, and it is untouched here.
 *
 * What this does is *measure*. A counter may go past its limit, and going past
 * it changes nothing — no run stops, no draft fails, no analysis is refused.
 * Koqentra does not yet know what a month of real use looks like, and the only
 * honest way to find out is to count without acting on the count.
 *
 * **The limit on the row is a comparison, not a rule.** It is written down so a
 * snapshot can say "eighty per cent of what a plan would allow"; nothing reads
 * it to decide anything. Setting it absurdly high to make enforcement "pass"
 * would have produced the same non-enforcement and destroyed the measurement,
 * which is why the real number is kept.
 */

/**
 * Which plan's numbers observation compares against.
 *
 * **Not an entitlement.** No account has a `Subscription`, none has been
 * granted anything, and nothing infers a right from this. It is the yardstick
 * the counters are read against while there is no billing cycle to read them
 * against — chosen as `beta` because that is the allowance the carried-over
 * accounts would be given if anybody had granted them one.
 *
 * **Nothing may treat a `UsagePeriod` as proof of a plan.** When entitlement
 * arrives it comes from `Subscription`, and `planAtStart` will record whatever
 * that says. Until then this string means "what we compared against", and
 * `lib/entitlements/` remains the only place a right is decided.
 */
export const OBSERVATION_PLAN = "beta" as const;

/** A month of observation, as UTC instants. */
export type ObservationWindow = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
};

/**
 * The UTC calendar month an instant falls in.
 *
 * **A calendar month, and only because there is nothing better yet.** A paid
 * period is a subscription's own cycle and a trial's is its fourteen days;
 * neither exists, and inventing one per account would be inventing a billing
 * decision. The month is the neutral choice: the same boundary for everybody,
 * derivable without a row, and obviously not a billing cycle.
 *
 * **This must not become the paid period.** When `Subscription` exists, paid
 * plans read `currentPeriodStart`/`currentPeriodEnd` and trials read
 * `trialStartedAt`/`trialEndsAt`. The name says `observation` so that a future
 * reader cannot mistake one for the other.
 */
export function observationWindowFor(now: Date): ObservationWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  return {
    periodStart: new Date(Date.UTC(year, month, 1)),
    periodEnd: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/** A window to count against, and the plan its limits were copied from. */
export type UsageWindow = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly plan: string;
};

/**
 * Which window an account's usage belongs in at this instant.
 *
 * **A trial is counted over its own fourteen days.** The calendar month is what
 * observation falls back on for an account with no cycle of its own, and for a
 * trial it would be wrong twice: a trial beginning on the twenty-eighth would
 * have its allowance reset three days in, and the fortnight's usage would be
 * split across two rows that neither of them describes. So a running trial
 * sends the counting to the period opened when it started — see
 * `startTrialOnFirstWorkerActivation`, which is the only thing that opens one.
 *
 * **The columns are read directly rather than through `computeEntitlement`.**
 * What is being chosen here is a place to write a number, not a right: asking
 * the entitlement would make observation depend on a decision it must not be
 * able to act on, and would let an unreadable row stop the counting. The
 * question this asks is narrower than entitlement and deliberately answerable
 * without it — *is there a trial, and is now inside it*.
 *
 * **Outside the trial's own dates, the month comes back.** A trial that has run
 * out has a period that is closed, and continuing to add to it would keep
 * writing into a fortnight that has ended. What happens to an account after its
 * trial is an enforcement question, and this phase does not answer it — it only
 * avoids writing a false one down.
 */
export async function resolveUsageWindow(
  userId: string,
  now: Date,
): Promise<UsageWindow> {
  const record = await prisma.subscription.findUnique({
    where: { userId },
    select: { state: true, trialStartedAt: true, trialEndsAt: true },
  });

  if (
    record !== null &&
    record.state === "trialing" &&
    record.trialStartedAt !== null &&
    record.trialEndsAt !== null &&
    now.getTime() >= record.trialStartedAt.getTime() &&
    now.getTime() < record.trialEndsAt.getTime()
  ) {
    return {
      periodStart: record.trialStartedAt,
      periodEnd: record.trialEndsAt,
      plan: "trial",
    };
  }

  return { ...observationWindowFor(now), plan: OBSERVATION_PLAN };
}

/**
 * What an observation increment did, for anything that wants to know.
 *
 * **There is no "refused".** Going past a limit is a fact to record, not an
 * answer to give, and a caller that could be told "no" would eventually act on
 * it. The only failure here is a database that would not answer.
 */
export type UsageObservation =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: "unavailable" };

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
 * Adds to one of an account's counters, whatever the counter already says.
 *
 * **The period is opened on first use and never in advance.** No job walks the
 * accounts at midnight, nothing was backfilled, and an account that does
 * nothing this month has no row at all — which is the truthful state of
 * something nobody has measured rather than a zero somebody wrote down.
 *
 * **The increment is one statement, and the limit is not in its condition.**
 * Two calls arriving together are resolved by PostgreSQL adding to the column
 * rather than by whichever read it first, so nothing is lost; and because no
 * condition can fail, a counter that is already over its limit keeps counting.
 * That is the difference from `consumeUsage`, stated as code.
 *
 * **Best-effort, and that is a contract.** Observation exists to watch what
 * Koqentra does, and an observation that could stop a run would be changing
 * what it watches. Every failure here ends in a log line.
 */
export async function recordUsageObservation(
  userId: string,
  kind: UsageKind,
  units = 1,
  now: Date = new Date(),
): Promise<UsageObservation> {
  // Checked before anything is opened or written, so a caller's arithmetic
  // mistake cannot create a period it then fails to use.
  if (!Number.isInteger(units) || units < 1) {
    throw new Error(`Usage units must be a positive integer, received ${units}`);
  }

  try {
    // **A trial's own period when there is one, the month otherwise.** The
    // period is still only opened on first use: an account on a trial already
    // has one, opened when the trial started, so this finds it rather than
    // making it.
    const window = await resolveUsageWindow(userId, now);

    const period = await openOrGetUsagePeriod({ userId, ...window });

    const { count } = await prisma.usageCounter.updateMany({
      where: { periodId: period.id, kind },
      data: { used: { increment: units } },
    });

    if (count !== 1) {
      // The period was opened with all three counters, so a missing row means
      // something else wrote this period. Reported rather than repaired: a
      // counter invented here would have no limit anybody decided on.
      console.warn("[usage] no counter to observe against —", kind);
      return { recorded: false, reason: "unavailable" };
    }

    return { recorded: true };
  } catch (error) {
    // **Named, and no further.** The kind is enough to tell whether observation
    // is failing for everything or for one path; the account is not logged,
    // because a log line outlives the request it came from.
    //
    // A unique violation here is two first-uses racing, which
    // `openOrGetUsagePeriod` already resolves by reading — reaching this means
    // something else went wrong, and it is reported the same way.
    console.error(
      "[usage] observation was not recorded —",
      kind,
      isUniqueViolation(error) ? "— period conflict" : "",
      error,
    );

    return { recorded: false, reason: "unavailable" };
  }
}
