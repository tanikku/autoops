import "server-only";

import { prisma } from "@/lib/prisma";
import { isRoutineFrequency, type Routine, type RoutineStatus } from "@/types";

/**
 * A worker is enabled when its status is `active`. Paused and draft workers are
 * never due, regardless of `nextRunAt`.
 */
const ENABLED_STATUS: RoutineStatus = "active";

/**
 * A due worker, carrying only what dispatching one needs.
 *
 * **A projection of `Routine` rather than a type of its own**, so the columns
 * cannot describe themselves differently here than they do everywhere else —
 * `nextRunAt` is the same `Date | null`, and `frequency` is already narrowed to
 * the four the schedule module accepts.
 *
 * What is missing is the point: `name`, `description`, `status`, `createdAt`,
 * `updatedAt` and above all `prompt`, which is the largest column a worker has
 * and the one execution reads for itself when the time comes. Nothing between
 * here and the hand-off ever looks at it.
 */
export type DueWorker = Pick<
  Routine,
  | "id"
  | "userId"
  | "nextRunAt"
  | "frequency"
  | "runAtMinutes"
  | "runAtWeekday"
  | "runAtDay"
>;

/**
 * The columns above, in the form Prisma takes them.
 *
 * Kept beside the type instead of inlined so the two are read together — a
 * column added to one and not the other is a type error rather than a silently
 * absent field.
 */
const dueWorkerColumns = {
  id: true,
  userId: true,
  nextRunAt: true,
  frequency: true,
  runAtMinutes: true,
  runAtWeekday: true,
  runAtDay: true,
} as const;

/**
 * Returns the workers that should run at `now`.
 *
 * This decides *what* to run and nothing else — it does not execute workers,
 * enqueue them, or touch the AI provider. That keeps it usable from any
 * trigger (cron, a queue consumer, a manual call) without changes here.
 *
 * A worker is due when it is enabled and its `nextRunAt` has passed. Workers
 * with no `nextRunAt` (manual frequency) are never due: SQL comparisons
 * against NULL are never true, so they are excluded by the same predicate.
 */
export async function getDueWorkers(now: Date): Promise<DueWorker[]> {
  const records = await prisma.routine.findMany({
    where: {
      status: ENABLED_STATUS,
      nextRunAt: { lte: now },
    },
    orderBy: { nextRunAt: "asc" },
    select: dueWorkerColumns,
  });

  // `frequency` is a plain string column, so the database can hold a value the
  // application cannot read. Narrowing it here rather than in the dispatcher
  // keeps the dispatcher from deciding anything: what it receives is already
  // one of the four `lib/schedule.ts` accepts.
  //
  // The fallback matches `toRoutine` — a worker whose cadence cannot be read
  // stops being due rather than running on one nobody chose.
  return records.map((record) => ({
    ...record,
    frequency: isRoutineFrequency(record.frequency)
      ? record.frequency
      : "manual",
  }));
}
