import "server-only";

import { createAIProvider } from "@/lib/ai/factory";
import { prisma } from "@/lib/prisma";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import {
  isRunStatus,
  type RunHistory,
  type RunHistoryDetail,
  type RunHistoryEntry,
} from "@/types";

const SIMULATED_RUN_MS = 1000;
const provider = createAIProvider();

type RunRecord = Awaited<ReturnType<typeof prisma.runHistory.findFirstOrThrow>>;

// `status` is a plain string column in SQLite, so narrow it at the boundary.
function toRun(record: RunRecord): RunHistory {
  return {
    ...record,
    status: isRunStatus(record.status) ? record.status : "running",
  };
}

export async function listRunHistory(
  userId: string,
): Promise<RunHistoryEntry[]> {
  const records = await prisma.runHistory.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    include: { routine: { select: { name: true } } },
  });

  return records.map(({ routine, ...record }) => ({
    ...toRun(record),
    routineName: routine.name,
  }));
}

/** Returns null for both "missing" and "someone else's" — callers 404 on either. */
export async function getRun(
  id: string,
  userId: string,
): Promise<RunHistoryDetail | null> {
  const found = await prisma.runHistory.findFirst({
    where: { id, userId },
    include: { routine: { select: { name: true, prompt: true } } },
  });

  if (!found) {
    return null;
  }

  const { routine, ...record } = found;
  return {
    ...toRun(record),
    routineName: routine.name,
    routinePrompt: routine.prompt,
  };
}

/**
 * Executes a routine. Execution is simulated until real AI runs land.
 *
 * The run inherits the routine's owner, so both the manual and the dispatched
 * path record it without the caller having to pass a user through.
 */
export async function runRoutine(routineId: string): Promise<RunHistory> {
  const routine = await prisma.routine.findUniqueOrThrow({
    where: { id: routineId },
    select: { userId: true, prompt: true },
  });

  const run = await prisma.runHistory.create({
    data: { routineId, userId: routine.userId, status: "running" },
  });

  await new Promise((resolve) => setTimeout(resolve, SIMULATED_RUN_MS));

  const prompt = renderPrompt(routine.prompt, promptVariables());
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
