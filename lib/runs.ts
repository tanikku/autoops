import "server-only";

import { DummyProvider } from "@/lib/ai/dummy-provider";
import { prisma } from "@/lib/prisma";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import { isRunStatus, type RunHistory, type RunHistoryEntry } from "@/types";

const SIMULATED_RUN_MS = 1000;
const provider = new DummyProvider();

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
    include: { routine: { select: { prompt: true } } },
  });

  await new Promise((resolve) => setTimeout(resolve, SIMULATED_RUN_MS));

  const prompt = renderPrompt(run.routine.prompt, promptVariables());
  const output = await provider.execute(prompt);

  const finished = await prisma.runHistory.update({
    where: { id: run.id },
    data: {
      status: "completed",
      finishedAt: new Date(),
      output,
    },
  });

  return toRun(finished);
}
