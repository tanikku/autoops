import "server-only";

import { createAIProvider } from "@/lib/ai/factory";
import { providerErrorKind } from "@/lib/ai/provider";
import {
  acquireExecutionLease,
  ExecutionSuppressedError,
  releaseExecutionLease,
} from "@/lib/execution-lease";
import { prisma } from "@/lib/prisma";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import {
  isRunStatus,
  type RunHistory,
  type RunHistoryDetail,
  type RunHistoryEntry,
} from "@/types";

const provider = createAIProvider();

type RunRecord = Awaited<ReturnType<typeof prisma.runHistory.findFirstOrThrow>>;

/**
 * Turns a stored row into the run the rest of the application sees.
 *
 * `status` is a plain string column, so it is narrowed here — the database
 * will accept anything the application does not. Every other field is named
 * rather than spread, for the same reason `toRoutine` names its own: a run
 * reaches client components, so what a column carries outwards should be
 * something it opts into rather than something it gets by default.
 */
function toRun(record: RunRecord): RunHistory {
  return {
    id: record.id,
    routineId: record.routineId,
    userId: record.userId,
    status: isRunStatus(record.status) ? record.status : "running",
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    output: record.output,
    errorMessage: record.errorMessage,
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

/**
 * Every run of a single worker, newest first.
 *
 * Tenant-scoped like every other read, so it cannot report runs belonging to
 * someone else's worker.
 */
export async function listRunsForWorker(
  routineId: string,
  userId: string,
): Promise<RunHistory[]> {
  const records = await prisma.runHistory.findMany({
    where: { routineId, userId },
    orderBy: { startedAt: "desc" },
  });

  return records.map(toRun);
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
 * Executes a routine.
 *
 * **How long this takes is the provider's business, not this function's.**
 * `ClaudeProvider` takes as long as the model does — seconds, occasionally
 * minutes, and at most the ten it is given. The stand-in returns immediately,
 * and a run that finishes in no measurable time is the honest signal that no
 * model was called.
 *
 * The run inherits the routine's owner, so both the manual and the dispatched
 * path record it without the caller having to pass a user through.
 *
 * **A failing provider is a result, not an exception.** It comes back as a
 * `failed` record, which is what makes the failure countable in the health
 * summary instead of vanishing up the call stack. Callers depend on this: the
 * manual run action reads `status` to choose its message, and the dispatcher
 * advances the schedule without having to ask.
 *
 * **A worker that is already running is the one case with no record at all.**
 * Both paths into execution arrive here — a cron tick that won a slot, and a
 * button someone pressed — and neither knows about the other, so this is the
 * only place that can tell they have met. Taking the lease first means a
 * second arrival stops before anything exists to describe it: no row, no
 * provider call, and an `ExecutionSuppressedError` for whoever asked. That is
 * deliberately not a `failed` run; nothing went wrong, and a run that never
 * started has no outcome to record.
 *
 * **The lease is execution ownership, and the claim is not.** A cron tick has
 * already spent the slot by the time it gets here (`claimRoutineSlot`), and
 * that stays spent — the slot was taken, whatever happens next. Nothing below
 * reads or writes `nextRunAt`.
 *
 * **It is not an unconditional guarantee of one run at a time.** The lease
 * lasts a fixed span and nothing renews it, so a run that outlives its own
 * lease can overlap with the one that takes over. What holds regardless is
 * that the older run cannot release the newer one's claim.
 */
export async function runRoutine(routineId: string): Promise<RunHistory> {
  // Read before taking the lease, so a worker that has been deleted still
  // reports itself as missing. Acquiring first would match no row and be
  // indistinguishable from contention — the dispatcher counts a vanished
  // worker as a failed hand-off, and that should not quietly become silence.
  const routine = await prisma.routine.findUniqueOrThrow({
    where: { id: routineId },
    select: { userId: true, prompt: true },
  });

  const lease = await acquireExecutionLease(routineId);
  if (lease === null) {
    throw new ExecutionSuppressedError(routineId);
  }

  try {
    return await execute(routineId, routine.userId, routine.prompt);
  } finally {
    // Every path out of the execution above comes through here — the result,
    // the failure, and the writes that record either. **The release cannot
    // throw**, which is what stops a failed cleanup from replacing the outcome
    // it was cleaning up after. A lease left behind lapses on its own.
    await releaseExecutionLease(routineId, lease.token);
  }
}

/**
 * The execution itself, once the right to run it is held.
 *
 * Split out so the lease has a single, obvious span: everything in here
 * happens while it is held, and the caller's `finally` gives it back.
 */
async function execute(
  routineId: string,
  userId: string,
  routinePrompt: string,
): Promise<RunHistory> {
  const run = await prisma.runHistory.create({
    data: { routineId, userId, status: "running" },
  });

  try {
    const prompt = renderPrompt(routinePrompt, promptVariables());
    const output = await provider.execute(prompt);

    const finished = await prisma.runHistory.update({
      where: { id: run.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        output,
        errorMessage: null,
      },
    });

    return toRun(finished);
  } catch (error) {
    // Without this the row stays "running" forever and the failure is
    // invisible to the health summary.
    //
    // **The kind is logged, not stored.** What is stored is the message; the
    // kind stays in the log, because naming a column for it means deciding
    // what `failed` means and that is not settled. Until a production failure
    // has actually happened there is nothing to decide it against.
    console.error(
      "[worker] run failed —",
      providerErrorKind(error),
      "—",
      error,
    );

    // **The reason goes in its own column, and `output` stays empty.** It used
    // to hold whichever of the two the run happened to produce, which meant
    // neither could be read without checking `status` first — and neither
    // place that reads it did. Nothing about the string itself changed: it is
    // the same message this recorded before, still the failure's own wording
    // rather than something written for the worker's owner.
    const failed = await prisma.runHistory.update({
      where: { id: run.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        output: "",
        errorMessage:
          error instanceof Error ? error.message : "Execution failed.",
      },
    });

    return toRun(failed);
  }
}
