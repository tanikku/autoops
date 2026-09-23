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
 * Where a product unit is written, or that it is not written at all.
 *
 * **A trial that has ended has nowhere to put one**, and saying so is the whole
 * reason this is not just a window. There were two wrong answers available: add
 * to the fortnight that finished, which keeps changing the record of something
 * that is over; or open a calendar month against beta's numbers, which says a
 * trial account is a beta account. It is not, and it never was.
 */
export type UsageWriteWindow =
  | ({ readonly kind: "period" } & UsageWindow)
  | { readonly kind: "skip"; readonly reason: UsageSkipReason };

/**
 * Why nothing is counted.
 *
 * - `outside-trial` — the account has a trial and this instant is not inside
 *   it. Almost always an ended one; a not-yet-begun one answers the same way,
 *   for the same reason.
 * - `unreadable-trial` — the row says trial and does not say when. Skipping is
 *   the fail-soft: counting it as a beta month would file the account under a
 *   plan nobody put it on, and that misfiling would outlive the row.
 */
export type UsageSkipReason = "outside-trial" | "unreadable-trial";

/**
 * What a snapshot should read, or that there is nothing to read.
 *
 * **Not the same question as where to write, which is why it is not the same
 * function.** Once a trial ends, writing must stop and looking must not: the
 * fortnight's counters are the record of it, and somebody asking what a trial
 * used is asking about exactly the period that has closed. A single answer to
 * both would have had to be wrong about one of them.
 */
export type UsageSnapshotWindow =
  | ({ readonly kind: "period" } & UsageWindow)
  /** Nothing was counted anywhere that can be attributed to this account. */
  | { readonly kind: "none"; readonly plan: string };

/** The trial columns, as the two resolvers below need to see them. */
type TrialColumns = {
  readonly plan: string;
  readonly state: string;
  readonly trialStartedAt: Date | null;
  readonly trialEndsAt: Date | null;
};

/**
 * Whether this row is a trial at all.
 *
 * **Either column is enough.** `state` stops saying `trialing` if a later phase
 * ever writes an ended trial down, and `plan` stops saying `trial` the moment
 * somebody buys something — so a row is treated as a trial while either still
 * says so. The breadth is deliberately on the safe side: being wrong this way
 * skips a count, and being wrong the other way files the account under beta.
 */
function isTrialRecord(record: TrialColumns): boolean {
  return record.plan === "trial" || record.state === "trialing";
}

/** A trial's own window, or null when the row does not say what it is. */
function trialWindowOf(record: TrialColumns): UsageWindow | null {
  if (record.trialStartedAt === null || record.trialEndsAt === null) {
    return null;
  }

  return {
    periodStart: record.trialStartedAt,
    periodEnd: record.trialEndsAt,
    plan: "trial",
  };
}

/**
 * The columns both resolvers read.
 *
 * **Read directly rather than through `computeEntitlement`.** What is being
 * chosen is a place to write a number, not a right: asking the entitlement
 * would make observation depend on a decision it must not be able to act on,
 * and would let an unreadable row stop the counting.
 */
async function readTrialColumns(userId: string): Promise<TrialColumns | null> {
  return prisma.subscription.findUnique({
    where: { userId },
    select: { plan: true, state: true, trialStartedAt: true, trialEndsAt: true },
  });
}

/**
 * Where to count an account's product usage at this instant, if anywhere.
 *
 * Three answers, and the third is the one this exists for:
 *
 * 1. **No trial** — the calendar month, against the observation yardstick.
 *    Unchanged for every account that has one today, including the granted beta
 *    cohort: their month is exactly the month it was.
 * 2. **Inside a trial** — the trial's own fourteen days. A month boundary would
 *    reset the allowance halfway through a fortnight somebody was given whole.
 * 3. **A trial, but not inside it** — nothing. See `UsageWriteWindow`.
 *
 * **Skipping is not an error and not a limit.** Nothing is refused, nothing
 * fails, and the call that prompted it goes on exactly as it would have. What
 * stops is the bookkeeping, because there is no honest row to put it in.
 */
export async function resolveUsageWriteWindow(
  userId: string,
  now: Date,
): Promise<UsageWriteWindow> {
  const record = await readTrialColumns(userId);

  if (record === null || !isTrialRecord(record)) {
    return {
      kind: "period",
      ...observationWindowFor(now),
      plan: OBSERVATION_PLAN,
    };
  }

  const trial = trialWindowOf(record);

  if (trial === null) {
    return { kind: "skip", reason: "unreadable-trial" };
  }

  const inside =
    now.getTime() >= trial.periodStart.getTime() &&
    now.getTime() < trial.periodEnd.getTime();

  return inside
    ? { kind: "period", ...trial }
    : { kind: "skip", reason: "outside-trial" };
}

/**
 * Which period a screen should read for this account.
 *
 * **A finished trial is still read.** Its counters are the record of the
 * fortnight, and an operator or an owner asking what a trial used is asking
 * about exactly the period that closed — so `50 / 20 / 14` stays answerable
 * after the fourteen days, out of the row that was already there. Nothing is
 * created to answer it, and no calendar month is invented to stand in for it.
 *
 * **A trial that does not say when it ran has nothing to show.** Reading the
 * month instead would quietly hand back a beta period — possibly one holding
 * this account's pre-trial drafting — and label it as this account's usage.
 */
export async function resolveUsageSnapshotWindow(
  userId: string,
  now: Date,
): Promise<UsageSnapshotWindow> {
  const record = await readTrialColumns(userId);

  if (record === null || !isTrialRecord(record)) {
    return {
      kind: "period",
      ...observationWindowFor(now),
      plan: OBSERVATION_PLAN,
    };
  }

  const trial = trialWindowOf(record);

  return trial === null ? { kind: "none", plan: "trial" } : { kind: "period", ...trial };
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
  /** The database would not answer. Logged, and carried on from. */
  | { readonly recorded: false; readonly reason: "unavailable" }
  /**
   * There was nowhere honest to put it — an ended or unreadable trial.
   *
   * **Not a refusal and not a failure.** The call that prompted this happened,
   * cost what it cost, and is written down in `ProviderUsageEvent` exactly as
   * before; what stopped is the product bookkeeping, because no period
   * describes this instant for this account. See `resolveUsageWriteWindow`.
   */
  | { readonly recorded: false; readonly reason: "not-counted" };

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
    // **A trial's own period, the month, or nowhere at all.** The period is
    // still only opened on first use: an account on a trial already has one,
    // opened when the trial started, so this finds it rather than making it.
    const window = await resolveUsageWriteWindow(userId, now);

    if (window.kind === "skip") {
      // **Nothing is opened and nothing is written.** Opening a calendar month
      // here is the specific mistake this branch exists to prevent: it would
      // file a trial account's work under beta's numbers, and the row would
      // outlast every explanation of why it is there.
      return { recorded: false, reason: "not-counted" };
    }

    const period = await openOrGetUsagePeriod({
      userId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      plan: window.plan,
    });

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
