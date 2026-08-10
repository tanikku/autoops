import "server-only";

import { prisma } from "@/lib/prisma";
import {
  isRoutineFrequency,
  isRoutineStatus,
  type Routine,
  type RoutineInput,
} from "@/types";

export type RoutineRecord = Awaited<
  ReturnType<typeof prisma.routine.findFirstOrThrow>
>;

/**
 * Turns a stored row into the worker the rest of the application sees.
 *
 * Two things happen here. `status` and `frequency` are plain string columns,
 * so they are narrowed — the database will accept anything the application
 * does not. And every field is named rather than spread, which decides what a
 * row is allowed to carry outwards.
 *
 * **The naming is what keeps execution ownership off the wire.** `Routine`
 * reaches client components, so a spread would send `executionOwner` and
 * `executionLeaseUntil` to the browser the moment those columns existed —
 * internal execution state travelling with a worker that has no use for it.
 * Listing the fields makes exposure something a column opts into: a new one
 * stays server-side until somebody adds it here, and a field `Routine`
 * requires but this omits is a type error rather than an absence noticed later.
 */
export function toRoutine(record: RoutineRecord): Routine {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    description: record.description,
    prompt: record.prompt,
    status: isRoutineStatus(record.status) ? record.status : "draft",
    frequency: isRoutineFrequency(record.frequency)
      ? record.frequency
      : "manual",
    runAtMinutes: record.runAtMinutes,
    runAtWeekday: record.runAtWeekday,
    runAtDay: record.runAtDay,
    nextRunAt: record.nextRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function listRoutines(userId: string): Promise<Routine[]> {
  const records = await prisma.routine.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return records.map(toRoutine);
}

/** Returns null for both "missing" and "someone else's" — callers 404 on either. */
export async function getRoutine(
  id: string,
  userId: string,
): Promise<Routine | null> {
  const record = await prisma.routine.findFirst({ where: { id, userId } });
  return record ? toRoutine(record) : null;
}

export async function createRoutine(
  input: RoutineInput,
  userId: string,
): Promise<Routine> {
  const record = await prisma.routine.create({ data: { ...input, userId } });
  return toRoutine(record);
}

export async function updateRoutine(
  id: string,
  input: Partial<RoutineInput>,
  userId: string,
): Promise<Routine | null> {
  const { count } = await prisma.routine.updateMany({
    where: { id, userId },
    data: input,
  });

  return count === 0 ? null : getRoutine(id, userId);
}

export async function deleteRoutine(
  id: string,
  userId: string,
): Promise<boolean> {
  const { count } = await prisma.routine.deleteMany({ where: { id, userId } });
  return count > 0;
}

/**
 * Takes a worker's pending slot, reporting whether this caller got it.
 *
 * The write lands only while `nextRunAt` still holds `expected` — the value the
 * caller read a moment ago. Two dispatchers reaching the same slot therefore
 * produce one `true` and one `false`: a single `UPDATE` is atomic, so by the
 * time the loser's runs, its `WHERE` no longer matches anything.
 *
 * **This is what stops a worker running twice**, and it needs no transaction to
 * do it. Wrapping the execution instead would mean holding one open across a
 * call to the AI provider, which is the case every guide on transactions tells
 * you to avoid.
 *
 * It works because the next slot is always later than the current one — the
 * schedule module never returns the value it was given. A frequency that could
 * land on the same instant would defeat the check silently.
 *
 * Deliberately not tenant-scoped: the dispatcher runs system-wide on behalf of
 * the platform, not a signed-in user.
 */
export async function claimRoutineSlot(
  id: string,
  expected: Date,
  nextRunAt: Date | null,
): Promise<boolean> {
  const { count } = await prisma.routine.updateMany({
    where: { id, nextRunAt: expected },
    data: { nextRunAt },
  });

  return count === 1;
}
