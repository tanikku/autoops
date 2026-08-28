import "server-only";

import type { DbClient } from "@/lib/prisma";

/**
 * How many workers an account may keep, and how many of them may be active.
 *
 * **The worker rows are the count.** There is no counter column and no quota
 * table: how many workers an account has is how many `Routine` rows it has, and
 * how many are active is how many of those say `active`. Deleting a worker or
 * pausing one therefore frees capacity by itself — nothing has to be told, and
 * there is no second number that can drift away from the first.
 *
 * That decision is what makes the rest of this module necessary. A count is not
 * something a conditional `UPDATE` can be written against, the way
 * `claimRoutineSlot`, `acquireExecutionLease` and `consumeAiDraftQuota` all are:
 * those ask about one row, and this asks how many rows there are. Counting and
 * then writing is a check-then-act, and under PostgreSQL's default READ
 * COMMITTED two requests can both count nineteen and both insert.
 *
 * **So the account itself is the serialization point** — see
 * `lockAccountForWorkerQuota`. Every operation that could push either count up
 * takes that lock first, inside the same transaction as the write, which makes
 * the count it then reads a count nothing else can be changing.
 */

/**
 * How many workers one account may have, in any state.
 *
 * Draft, paused and active all count, and so do both kinds: what this bounds is
 * how much of the platform one account occupies — rows, the dashboard's own
 * read, and for a website worker the page snapshot it keeps.
 */
export const TOTAL_WORKER_LIMIT = 20;

/**
 * How many of an account's workers may be `active` at once.
 *
 * **A manual worker that is active spends one of these**, even though nothing
 * schedules it. The limit is about a state somebody can see and change rather
 * than about what the scheduler will do with it: a rule that let a `manual`
 * active worker through would be one nobody could read off the dashboard, and
 * changing a cadence would silently spend or free a slot.
 *
 * What the scheduler actually picks up is narrower — `active` *and* a cadence
 * other than `manual` — and that remains true and separate.
 */
export const ACTIVE_WORKER_LIMIT = 10;

/** Which limit an operation ran into. Neither is a failure. */
export type WorkerQuotaRejection = "total" | "active";

/**
 * Takes the account's own row so that its quota can be counted safely.
 *
 * **The self-assignment is the lock, and it is not a typo.** Writing `id` back
 * to the value it already has produces a real `UPDATE ... SET "id" = $1 WHERE
 * "id" = $2`, which holds the row for the rest of the transaction — so a second
 * request for the same account waits at this line until the first commits, and
 * then counts the rows the first one wrote. That is the whole of what makes
 * count-then-write correct here.
 *
 * **`data: {}` must never be used instead.** It looks equivalent and is not:
 * Prisma issues no `UPDATE` at all for an empty `data` and turns the call into
 * a `SELECT`, which takes no lock and would leave both requests counting the
 * same nineteen. Both behaviours were measured against local PostgreSQL in the
 * Sprint 3 spike rather than reasoned about.
 *
 * **Nothing about the account is changed.** `User` carries no `updatedAt` and
 * no trigger, so the row's data is exactly what it was. **If a column like
 * `updatedAt` is ever added to `User`, this lock has to be re-examined** — it
 * would start stamping an account every time one of its workers is created or
 * activated, which is not what such a column would be there to say.
 *
 * It is deliberately not exported. Callers ask for a quota decision; how that
 * decision is made safe is this module's business, and a lock taken in one
 * place and counted in another is not a contract that survives being spread
 * out.
 */
async function lockAccountForWorkerQuota(
  client: DbClient,
  userId: string,
): Promise<void> {
  await client.user.update({ where: { id: userId }, data: { id: userId } });
}

/**
 * Decides whether an account may create one more worker.
 *
 * **Takes the caller's transaction rather than making one.** The write this
 * guards has to land inside the same transaction as the lock — a decision
 * committed separately is a decision about a moment that has passed — and a
 * website worker's two writes are already one transaction, so this joins theirs
 * rather than nesting another.
 *
 * The active count is read only when the worker being created would be active.
 * A draft costs nothing against that limit and asking anyway would be one query
 * per hire for an answer nothing reads.
 *
 * @returns which limit was reached, or `null` when the create may go ahead. A
 *   database failure throws, because it is neither.
 */
export async function claimWorkerCreation(
  client: DbClient,
  userId: string,
  status: string,
): Promise<WorkerQuotaRejection | null> {
  await lockAccountForWorkerQuota(client, userId);

  const total = await client.routine.count({ where: { userId } });
  if (total >= TOTAL_WORKER_LIMIT) {
    return "total";
  }

  if (status !== "active") {
    return null;
  }

  const active = await client.routine.count({
    where: { userId, status: "active" },
  });

  return active >= ACTIVE_WORKER_LIMIT ? "active" : null;
}

/**
 * Decides whether an account may make one more of its workers active.
 *
 * **Only a transition asks.** A worker that is already active and is being
 * edited is not taking a slot it does not have, so editing its name must not be
 * refused because the account is at its limit — it is *part* of that limit.
 * Deciding that is the caller's, which knows what the worker was; what this
 * answers is whether there is room for one more.
 *
 * The total is not re-checked: activating changes no row count, and an account
 * over the total limit by some other route should not have its existing workers
 * frozen as a side effect.
 *
 * @returns `"active"` when the limit is reached, or `null` when it may go
 *   ahead. A database failure throws.
 */
export async function claimWorkerActivation(
  client: DbClient,
  userId: string,
): Promise<WorkerQuotaRejection | null> {
  await lockAccountForWorkerQuota(client, userId);

  const active = await client.routine.count({
    where: { userId, status: "active" },
  });

  return active >= ACTIVE_WORKER_LIMIT ? "active" : null;
}
