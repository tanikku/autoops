import "server-only";

import { prisma } from "@/lib/prisma";
import { isRunStatus, type RunHistory, type RunHistoryEntry } from "@/types";

const SIMULATED_RUN_MS = 1000;
const DUMMY_OUTPUT = "Execution completed successfully.";

type RunRecord = Awaited<ReturnType<typeof prisma.runHistory.findFirstOrThrow>>;

// `status` is a plain string column in SQLite, so narrow it at the boundary.
function toRun(record: RunRecord): RunHistory {
  return {
    ...record,
    status: isRunStatus(record.status) ? record.status : "running",
  };
}

export async function listRunHistory(): Promise<RunHistoryEntry[]> {
  const records = await prisma.runHistory.findMany({
    orderBy: { startedAt: "desc" },
    include: { routine: { select: { name: true } } },
  });

  return records.map(({ routine, ...record }) => ({
    ...toRun(record),
    routineName: routine.name,
  }));
}

/** Executes a routine. Execution is simulated until real AI runs land. */
export async function runRoutine(routineId: string): Promise<RunHistory> {
  const run = await prisma.runHistory.create({
    data: { routineId, status: "running" },
  });

  await new Promise((resolve) => setTimeout(resolve, SIMULATED_RUN_MS));

  const finished = await prisma.runHistory.update({
    where: { id: run.id },
    data: {
      status: "completed",
      finishedAt: new Date(),
      output: DUMMY_OUTPUT,
    },
  });

  return toRun(finished);
}
