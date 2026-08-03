import "server-only";

import { enqueueRoutine } from "@/lib/queue";
import { setRoutineNextRunAt } from "@/lib/routines";
import { advanceNextRunAt } from "@/lib/schedule";
import { getDueWorkers } from "@/lib/scheduler";

/**
 * Hands the workers the scheduler selected to the queue, in order, then moves
 * each one's schedule forward.
 *
 * The dispatcher decides nothing — the scheduler owns *what* is due, the
 * schedule module owns *when* the next slot falls, and the queue owns *how* a
 * worker runs. Owning the hand-off here is what lets any of them be replaced
 * without touching the others.
 *
 * **A run that fails still advances the schedule.** Execution reports its
 * outcome by recording it rather than by throwing, so nothing distinguishes the
 * two cases here — and nothing should. Deciding whether a failure deserves
 * another attempt is a retry policy, and the dispatcher holds no policies. The
 * failure is visible in the run history either way.
 *
 * Returns the ids that were enqueued.
 */
export async function dispatchDueWorkers(now: Date): Promise<string[]> {
  const dueWorkers = await getDueWorkers(now);
  const dispatched: string[] = [];

  for (const worker of dueWorkers) {
    await enqueueRoutine(worker.id);
    dispatched.push(worker.id);

    // The whole schedule goes to the schedule module, which is the only place
    // that knows what to do with it. Reading the owner's timezone happens
    // there too: picking it apart here would be the dispatcher deciding
    // something.
    await setRoutineNextRunAt(
      worker.id,
      await advanceNextRunAt(worker, worker.nextRunAt),
    );
  }

  return dispatched;
}
