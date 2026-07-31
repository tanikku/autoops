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
 * The schedule is advanced only after the queue accepted the worker, so a
 * failed run leaves it due and does not silently skip a slot.
 *
 * Returns the ids that were enqueued.
 */
export async function dispatchDueWorkers(now: Date): Promise<string[]> {
  const dueWorkers = await getDueWorkers(now);
  const dispatched: string[] = [];

  for (const worker of dueWorkers) {
    await enqueueRoutine(worker.id);
    dispatched.push(worker.id);

    await setRoutineNextRunAt(
      worker.id,
      advanceNextRunAt(worker.frequency, worker.nextRunAt),
    );
  }

  return dispatched;
}
