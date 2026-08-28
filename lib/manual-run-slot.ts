import "server-only";

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Taking and giving back the right to have a hand-started run in progress.
 *
 * **Per account, and that is the whole of what makes it different from the
 * execution lease.** `acquireExecutionLease` asks whether *this worker* is
 * already running; two runs of two different workers are not competing for
 * anything there, and never were. An account with ten workers could start ten
 * runs at once, each one legitimate on its own, and every one of them a call to
 * a provider and a fetch of somebody else's website. This is what bounds that,
 * and it bounds it by owner rather than by worker.
 *
 * **Hand-started runs only.** Scheduled execution never comes through here: a
 * tick takes five workers at most, works through them one at a time, and stops
 * starting new ones on its own budget. It is bounded already, by different
 * numbers, for different reasons — and a scheduled run refused a slot would be
 * refused because of something its owner did by hand, which is not a decision
 * anything here should be making.
 *
 * **The two are held together, not instead of one another.** A manual run holds
 * a slot from here and then a lease on its worker, and both are given back when
 * it finishes. Neither says anything about the other's guarantee.
 *
 * **Not a rate limit.** It bounds how many runs are in flight at once, and says
 * nothing about how many an account may start in an hour: one run at a time,
 * over and over, is unbounded work and is deliberately still allowed. Counting
 * requests over a window is `lib/rate-limit.ts`, and mixing the two into one
 * row would give a column two meanings.
 */

/**
 * How many hand-started runs one account may have going at once.
 *
 * **One, as a product decision rather than a technical ceiling.** The slots are
 * rows, so raising this raises how many rows an account may hold and needs no
 * migration — which is the reason the table has a `slotNumber` at all when
 * today it is always zero.
 */
export const MANUAL_RUN_CONCURRENCY_LIMIT = 1;

/**
 * How long a slot is held before it lapses on its own.
 *
 * **A product-level recovery window, and nothing else.** It answers one
 * question: how long an account should be kept waiting after a process died
 * mid-run and never gave its slot back. Fifteen minutes is short enough that
 * nobody is locked out for an afternoon and long enough that no ordinary run
 * reaches it.
 *
 * **Deliberately not derived from anything, and shared with nothing.** Not from
 * `PROMPT_AI_TIMEOUT_MS` (180s) or `WEBSITE_AI_TIMEOUT_MS` (120s), which are one
 * provider call's patience; not from `FETCH_BUDGET_MS` (20s), which is one
 * page's; and **not from `EXECUTION_LEASE_MS`**, which happens to be the same
 * fifteen minutes and is a different decision about a different thing — how long
 * one worker may be considered busy. Importing that constant here would make a
 * change to the platform's view of a worker silently change how long an account
 * waits after a crash, and the two should be free to move apart.
 */
export const MANUAL_RUN_SLOT_TTL_MS = 15 * 60 * 1000;

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

/** A slot that was granted, and what is needed to give it back. */
export type ManualRunSlot = {
  slotNumber: number;
  /**
   * Opaque, minted per acquisition. **Not a run id and not an execution id** —
   * a run is identified by its `RunHistory` row, and nothing outside this
   * module reads this value.
   */
  token: string;
  expiresAt: Date;
};

/**
 * Takes one named slot, if it is free or the claim on it has lapsed.
 *
 * A single conditional `UPDATE`, exactly as `acquireExecutionLease` is: the row
 * is written only while it is free or expired, so two callers arriving together
 * produce one `1` and one `0`. **The condition is `leaseUntil < now`**, which
 * means a slot is still held at the instant it expires and free from the first
 * moment past it — the same boundary the execution lease draws.
 */
async function claimSlot(
  userId: string,
  slotNumber: number,
  now: Date,
  token: string,
  expiresAt: Date,
): Promise<boolean> {
  const { count } = await prisma.manualRunSlot.updateMany({
    where: {
      userId,
      slotNumber,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { owner: token, leaseUntil: expiresAt },
  });

  return count === 1;
}

/**
 * Takes the right to start a run by hand, or reports that the account is
 * already using it.
 *
 * **Nothing is read to decide.** Whether a slot is free is a condition inside
 * the write, so two requests arriving together are separated by the database
 * rather than by whichever of them read first. The only read here answers a
 * different question — whether the row exists at all — and it is what tells a
 * brand-new account's first run from a slot somebody else is holding.
 *
 * Each slot is tried in turn, and the loop is bounded by the limit: there is no
 * retry policy here, only a fixed number of rows to ask about. With the limit at
 * one there is exactly one.
 *
 * **A refusal and a failure are not the same answer.** `null` means the account
 * is busy, which is an ordinary thing to tell somebody; a database that will not
 * answer throws, because the caller has to fail closed rather than treat it as a
 * quiet "no". Same split as `acquireExecutionLease` and `consumeAiDraftQuota`.
 *
 * `now` is the application's clock, for the reason the lease gives: reading the
 * database's would mean raw SQL, and passing it is what makes the expiry
 * boundary testable without moving the clock.
 *
 * @returns the slot when it was granted, `null` when the account already has
 *   its runs in flight. A database failure throws, because it is neither.
 */
export async function acquireManualRunSlot(
  userId: string,
  now: Date = new Date(),
): Promise<ManualRunSlot | null> {
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + MANUAL_RUN_SLOT_TTL_MS);

  for (
    let slotNumber = 0;
    slotNumber < MANUAL_RUN_CONCURRENCY_LIMIT;
    slotNumber += 1
  ) {
    if (await claimSlot(userId, slotNumber, now, token, expiresAt)) {
      return { slotNumber, token, expiresAt };
    }

    // Nothing was updated, which is either a slot somebody holds or a row that
    // has never existed. Only the second is worth another write.
    const existing = await prisma.manualRunSlot.findUnique({
      where: { userId_slotNumber: { userId, slotNumber } },
    });

    if (existing) {
      continue;
    }

    try {
      await prisma.manualRunSlot.create({
        data: { userId, slotNumber, owner: token, leaseUntil: expiresAt },
      });

      return { slotNumber, token, expiresAt };
    } catch (error) {
      // Somebody else created the row between the read and this write. The row
      // that now exists is a slot they are holding, so this attempt has lost it
      // — exactly as if the conditional write above had found it taken. One
      // more try, and only one: after the create there is a row, and asking the
      // same question again would spin.
      if (!isUniqueViolation(error)) {
        throw error;
      }

      if (await claimSlot(userId, slotNumber, now, token, expiresAt)) {
        return { slotNumber, token, expiresAt };
      }
    }
  }

  return null;
}

/** What became of a release. None of these is an exception. */
export type ManualRunSlotRelease =
  /** The slot was ours and is now given back. */
  | "released"
  /** Somebody else's, or already expired and taken. Ordinary, not an error. */
  | "not-held"
  /** The write itself failed. The slot lapses on its own instead. */
  | "failed";

/**
 * Gives back a slot, and only the slot it was given.
 *
 * **The token in the condition is the point**, as it is in
 * `releaseExecutionLease`: a run that overran the TTL has already lost its slot,
 * and by the time it finishes another run may hold one. Matching on the token
 * means the older one writes nothing and the newer claim survives.
 *
 * **It never throws.** Release belongs in the cleanup of whatever ran, and an
 * exception raised there would replace the result of the run it was cleaning up
 * after — turning a completed run into a thrown one. The failure is logged and
 * reported instead, and the slot lapses on its own, which is the same recovery
 * a process that died mid-run gets.
 */
export async function releaseManualRunSlot(
  userId: string,
  slotNumber: number,
  token: string,
): Promise<ManualRunSlotRelease> {
  try {
    const { count } = await prisma.manualRunSlot.updateMany({
      where: { userId, slotNumber, owner: token },
      data: { owner: null, leaseUntil: null },
    });

    if (count === 1) {
      return "released";
    }

    // Nothing silently: this says a run outlived the recovery window, which is
    // the only evidence that the window is too short.
    console.warn(
      "[manual-run] nothing to release — the slot had already lapsed or been taken",
      userId,
    );
    return "not-held";
  } catch (error) {
    console.error("[manual-run] could not release the slot", userId, error);
    return "failed";
  }
}
