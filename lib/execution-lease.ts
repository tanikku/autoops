import "server-only";

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Taking and giving back the right to execute a worker.
 *
 * **This is execution ownership, and it is not the scheduled slot.**
 * `claimRoutineSlot` decides which cron tick gets to spend a slot; two ticks
 * arriving together produce one winner because they are competing for one
 * value of `nextRunAt`. A hand-started run competes for nothing — it never
 * reads that column — so the claim says nothing about whether a worker is
 * already running. That is the gap this closes, and it closes it for both
 * paths at once because it is keyed on the worker rather than on a slot.
 *
 * **What it guarantees is narrower than "one execution at a time".** A lease
 * is taken for a fixed span, and nothing renews it. A run that outlives its
 * lease no longer holds anything, so the next attempt may take over while the
 * first is still going — and then both are running. What is guaranteed is
 * that the first one cannot *undo* the second: a release only lands while the
 * token still matches, so the older holder tidying up after itself leaves the
 * newer claim alone.
 *
 * Stating that plainly matters more than it looks. Something built on top of
 * this believing it has at-most-once execution would be wrong in exactly the
 * case that is hardest to reproduce.
 *
 * **Nothing here is integrated yet.** The primitive exists; no execution path
 * calls it.
 */

/**
 * How long a claim lasts.
 *
 * Comfortably longer than any run should take — `ClaudeProvider` allows one
 * request ten minutes — with the rest absorbing what happens around the
 * request: the database round trips `runRoutine` makes on either side of it,
 * time spent waiting for a connection, and the event loop being shared with
 * whatever else the server is doing.
 *
 * **It is an allowance, not a bound.** Nothing in the pipeline caps total
 * execution time: a connection can be waited on indefinitely, since the pool
 * is configured with no acquisition timeout. Choosing a number here does not
 * make overrunning impossible, only unlikely — which is why the release below
 * is written to stay correct when it happens anyway.
 *
 * **Deliberately not derived from the provider's timeout.** That value is one
 * provider's policy about one request; this one is the platform's policy about
 * one execution, and a second provider would not change it. Tying them
 * together would make a change to either look like a change to both.
 *
 * **Deliberately not shared with `STUCK_THRESHOLD_MS`** (`lib/health.ts`),
 * which happens to be the same fifteen minutes. That one decides what a page
 * says; this one decides whether a worker runs. A number that is only ever
 * displayed and a number that gates execution should not move together
 * because they once agreed.
 */
export const EXECUTION_LEASE_MS = 15 * 60 * 1000;

/**
 * Nothing ran, because something already is.
 *
 * **Not a failure, and the distinction is the reason this type exists.** A
 * `failed` run is one that started and did not work; this is a run that never
 * started, because the worker it belongs to was busy. Nothing is recorded for
 * it — no `RunHistory` row, no provider call — so there is nothing for a
 * failure count to point at.
 *
 * It travels as an exception because that is how `runRoutine` already reports
 * the cases where no `RunHistory` exists to return, and it keeps
 * `enqueueRoutine`'s signature exactly as it was. Callers that care tell it
 * apart with `isExecutionSuppressed`; callers that do not see an ordinary
 * rejection.
 *
 * **Deliberately unrelated to `ProviderErrorKind`.** That vocabulary names
 * ways a model call went wrong, and no model was called here.
 */
export class ExecutionSuppressedError extends Error {
  readonly routineId: string;

  constructor(routineId: string) {
    super(`Worker ${routineId} is already running.`);
    this.name = "ExecutionSuppressedError";
    this.routineId = routineId;
  }
}

/** Whether a rejection means "already running" rather than "went wrong". */
export function isExecutionSuppressed(error: unknown): boolean {
  return error instanceof ExecutionSuppressedError;
}

/** A claim that was granted, and the token that can give it back. */
export type ExecutionLease = {
  /**
   * Opaque, minted per acquisition. **Not an execution id and not a job id** —
   * a run is identified by its `RunHistory` row, and nothing outside this
   * module reads this value.
   */
  token: string;
  expiresAt: Date;
};

/** What became of a release. None of these is an exception. */
export type ExecutionLeaseRelease =
  /** The claim was ours and is now given back. */
  | "released"
  /** Somebody else's, or already expired and taken. Ordinary, not an error. */
  | "not-held"
  /** The write itself failed. The claim lapses on its own instead. */
  | "failed";

/**
 * Takes the right to execute a worker, or reports that someone else has it.
 *
 * A single conditional `UPDATE`, exactly as `claimRoutineSlot` is: the row is
 * written only while it is free or the previous claim has lapsed, so two
 * callers arriving together produce one `1` and one `0`. **No transaction is
 * involved, and none should be** — the run this guards is a call to an AI
 * provider, and holding a transaction across it is the thing every guide on
 * transactions tells you to avoid. It would also hold one of the pool's ten
 * connections for the duration.
 *
 * **`now` is the application's clock, not the database's.** Reading the
 * database's would mean raw SQL, which nothing in AutoOps uses, for a
 * difference that only shows up once more than one process is writing. There
 * is one today. **Revisit this before there are two** — a worker service, or a
 * second replica, would be comparing lapse times against clocks that can
 * disagree.
 *
 * Passing `now` is what makes the boundary testable without moving the clock.
 *
 * @returns the lease when it was granted, `null` when someone else holds one.
 *   A database failure throws, because it is neither.
 */
export async function acquireExecutionLease(
  routineId: string,
  now: Date = new Date(),
): Promise<ExecutionLease | null> {
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);

  const { count } = await prisma.routine.updateMany({
    where: {
      id: routineId,
      OR: [
        { executionLeaseUntil: null },
        { executionLeaseUntil: { lt: now } },
      ],
    },
    data: { executionOwner: token, executionLeaseUntil: expiresAt },
  });

  return count === 1 ? { token, expiresAt } : null;
}

/**
 * Gives back a claim, and only the claim it was given.
 *
 * **The token in the condition is the whole point.** A run that overran its
 * lease has already lost it, and by the time it finishes tidying up another
 * run may hold one. Matching on the token means the older one writes nothing
 * — `count` comes back `0` and the newer claim survives. Releasing on the id
 * alone would hand the worker to two runs at once and then clear the second
 * one's protection on the way out.
 *
 * **It never throws.** Release belongs in the cleanup of whatever ran, and an
 * exception raised there replaces the result of the run it was cleaning up
 * after — a failed release would turn a completed run into a thrown one. The
 * failure is logged and reported instead, and the claim lapses on its own,
 * which is the same recovery a process that died mid-run gets.
 *
 * `not-held` and `failed` are worth separating even though neither is an
 * error: the first says a run outlived its lease, the second says the database
 * refused a write. Only the first is evidence about how long runs take.
 */
export async function releaseExecutionLease(
  routineId: string,
  token: string,
): Promise<ExecutionLeaseRelease> {
  try {
    const { count } = await prisma.routine.updateMany({
      where: { id: routineId, executionOwner: token },
      data: { executionOwner: null, executionLeaseUntil: null },
    });

    if (count === 1) {
      return "released";
    }

    // The id is the point of this line, as it is in the dispatcher: without it
    // the log records that a lease outlived its run and leaves you to guess
    // whose. It is the only evidence that the allowance above was too short.
    console.warn(
      "[lease] nothing to release — the lease had already lapsed or been taken",
      routineId,
    );
    return "not-held";
  } catch (error) {
    console.error("[lease] could not release", routineId, error);
    return "failed";
  }
}
