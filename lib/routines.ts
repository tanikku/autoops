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

// `status` and `frequency` are plain string columns in SQLite, so narrow them
// at the boundary.
export function toRoutine(record: RoutineRecord): Routine {
  return {
    ...record,
    status: isRoutineStatus(record.status) ? record.status : "draft",
    frequency: isRoutineFrequency(record.frequency)
      ? record.frequency
      : "manual",
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
