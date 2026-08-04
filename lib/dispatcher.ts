import "server-only";

import { enqueueRoutine } from "@/lib/queue";
import { setRoutineNextRunAt } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { getDueWorkers } from "@/lib/scheduler";
import { getUserTimezone } from "@/lib/users";
import type { Routine } from "@/types";

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

    await setRoutineNextRunAt(worker.id, await nextSlotFor(worker));
  }

  return dispatched;
}

/**
 * Where the pending slot moves to once a worker has been handed off.
 *
 * Gathering the owner's timezone is the dispatcher's job because reading rows
 * already is: it loads the workers and writes the result back. Handing the
 * schedule module a complete `ScheduleInput` is what keeps that module free of
 * the database and pure enough to reason about on its own.
 *
 * The next slot is measured from the slot that just ran — never from the clock
 * — so a cron tick that fires late does not drag the schedule with it. A worker
 * due at 09:00 and dispatched at 09:05 is next due at 09:00 the following day,
 * not 09:05.
 *
 * A worker with no pending slot keeps none. The scheduler never returns one,
 * since a null `nextRunAt` cannot be due; the guard stays because this function
 * promises an answer for any worker, not only for the ones that arrive here
 * today.
 */
async function nextSlotFor(worker: Routine): Promise<Date | null> {
  if (worker.nextRunAt === null) {
    return null;
  }

  return calculateNextRunAt(
    {
      frequency: worker.frequency,
      runAtMinutes: worker.runAtMinutes,
      runAtWeekday: worker.runAtWeekday,
      runAtDay: worker.runAtDay,
      timezone: await getUserTimezone(worker.userId),
    },
    worker.nextRunAt,
  );
}
