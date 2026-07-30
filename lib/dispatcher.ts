import "server-only";

import { enqueueRoutine } from "@/lib/queue";
import { getDueWorkers } from "@/lib/scheduler";

/**
 * Hands the workers the scheduler selected to the queue, in order.
 *
 * This decides nothing — the scheduler owns *what* is due and the queue owns
 * *how* a worker runs. Keeping the hand-off here is what lets either side be
 * replaced (a real queue, a different trigger) without touching the other.
 *
 * Returns the ids that were enqueued.
 */
export async function dispatchDueWorkers(now: Date): Promise<string[]> {
  const dueWorkers = await getDueWorkers(now);

  for (const worker of dueWorkers) {
    await enqueueRoutine(worker.id);
  }

  return dueWorkers.map((worker) => worker.id);
}
