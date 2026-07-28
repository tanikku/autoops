import "server-only";

import { prisma } from "@/lib/prisma";
import {
  isRoutineFrequency,
  isRoutineStatus,
  type Routine,
  type RoutineInput,
} from "@/types";

type RoutineRecord = Awaited<
  ReturnType<typeof prisma.routine.findFirstOrThrow>
>;

// `status` and `frequency` are plain string columns in SQLite, so narrow them
// at the boundary.
function toRoutine(record: RoutineRecord): Routine {
  return {
    ...record,
    status: isRoutineStatus(record.status) ? record.status : "draft",
    frequency: isRoutineFrequency(record.frequency)
      ? record.frequency
      : "manual",
  };
}

export async function listRoutines(): Promise<Routine[]> {
  const records = await prisma.routine.findMany({
    orderBy: { createdAt: "desc" },
  });
  return records.map(toRoutine);
}

export async function getRoutine(id: string): Promise<Routine | null> {
  const record = await prisma.routine.findUnique({ where: { id } });
  return record ? toRoutine(record) : null;
}

export async function createRoutine(input: RoutineInput): Promise<Routine> {
  const record = await prisma.routine.create({ data: input });
  return toRoutine(record);
}

export async function updateRoutine(
  id: string,
  input: Partial<RoutineInput>,
): Promise<Routine> {
  const record = await prisma.routine.update({ where: { id }, data: input });
  return toRoutine(record);
}

export async function deleteRoutine(id: string): Promise<void> {
  await prisma.routine.delete({ where: { id } });
}
