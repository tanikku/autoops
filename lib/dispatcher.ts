import "server-only";

import { isExecutionSuppressed } from "@/lib/execution-lease";
import { enqueueRoutine } from "@/lib/queue";
import { claimRoutineSlot } from "@/lib/routines";
import { isRunPersistenceError } from "@/lib/runs";
import { advanceSchedule } from "@/lib/schedule";
import { type DueWorker, getDueWorkers } from "@/lib/scheduler";
import { getUserTimezone } from "@/lib/users";

/**
 * How long a tick may spend before it stops starting new workers.
 *
 * **Cooperative, not a deadline.** Nothing is cancelled when this passes: a
 * worker already running keeps its fetch, its model call, and the transaction
 * that records what it did. What changes is that the next one is not started.
 * Killing work in flight would mean a run that reached a provider and was
 * billed for, with nothing written down about it.
 *
 * **Four minutes, against Railway's five.** The tick answers an HTTP request,
 * and a response that takes longer than five minutes without sending anything
 * is cut off at the edge — losing the tick's own log line and its heartbeat
 * along with it. A minute of headroom is what a worker started at 3:59 has to
 * finish in, and it is not enough for the worst case: a single run may take ten
 * minutes on its own. **This bounds how many long runs a tick strings
 * together, not how long one of them lasts.**
 *
 * **Deliberately not `TICK_WARN_THRESHOLD_MS`.** That one decides whether a log
 * line is a warning and changes nothing about what runs; this one changes what
 * runs and writes nothing. Sharing a number between the two would mean tuning
 * the log altered execution.
 */
export const MAX_TICK_EXECUTION_MS = 240_000;

/** What one tick did: the workers handed off, and how many could not be. */
export type DispatchResult = {
  dispatched: string[];
  failed: number;
};

/**
 * Claims each worker the scheduler selected, then hands the ones it won to the
 * queue.
 *
 * The dispatcher decides nothing — the scheduler owns *what* is due, the
 * schedule module owns *when* the next slot falls, and the queue owns *how* a
 * worker runs. Owning the hand-off here is what lets any of them be replaced
 * without touching the others.
 *
 * **A slot is taken before it is run, not after.** Two cron ticks arriving at
 * once — a retry, an overlapping manual call, a second instance — would both
 * read the same due workers, and running first would run each of them twice.
 * Claiming first makes one of the two lose and skip the worker. What that costs
 * is the opposite failure: a process that dies between claiming and running
 * drops that slot instead of repeating it, which is the safer direction when a
 * run bills an API and produces real output.
 *
 * **A run that fails still advances the schedule** — the slot is already gone
 * by the time execution starts. Execution reports its outcome by recording it
 * rather than by throwing, so nothing distinguishes the two cases here, and
 * nothing should. Deciding whether a failure deserves another attempt is a
 * retry policy, and the dispatcher holds no policies.
 *
 * **One worker failing is one worker failing.** Anything thrown while claiming
 * or handing off used to escape the loop and end the tick, so a single broken
 * worker took every worker behind it with it — and they sort by `nextRunAt`,
 * meaning the same ones lost every time. Catching per worker keeps the blast
 * radius to the worker it belongs to.
 *
 * That is not a retry policy, and the distinction matters. Nothing here decides
 * a failure deserves another attempt: a claimed slot stays claimed and the
 * worker waits for its next one, exactly as it would if the process had died
 * mid-run. The only decision is to carry on with the rest of the list.
 *
 * **A worker already running counts as neither.** Execution ownership is held
 * per worker rather than per slot (`lib/execution-lease.ts`), so a slot can be
 * won for a worker a hand-started run is in the middle of. Nothing is handed
 * off and nothing goes wrong, so the tick reports neither — the event is in
 * the log. **The slot is still spent**: it was claimed before any of this, and
 * nothing here gives it back.
 *
 * Returns the ids that were enqueued — the workers claimed rather than the
 * workers found — alongside a count of the ones that threw, so a caller can
 * tell "nothing was due" from "nothing worked".
 */
export async function dispatchDueWorkers(now: Date): Promise<DispatchResult> {
  const dueWorkers = await getDueWorkers(now);

  // **How many were due, before anything is decided about them.** The tick's
  // own line says how many were handed off, and the two are not the same
  // number: a slot lost to another tick, a worker already running, and a
  // hand-off that threw all leave `dispatched` lower than this without any of
  // them being wrong. Reading one without the other, a quiet platform and a
  // dispatcher that has stopped working look identical.
  //
  // **It says nothing about whether that is a problem**, and nothing here
  // decides. Zero is the ordinary answer on a platform with no scheduled
  // workers, which is why it is written on every tick rather than only when
  // there is something to report — "nothing was due" and "the tick did not run"
  // are different, and only a line that always appears can tell them apart.
  console.log(`[dispatcher] due workers — count=${dueWorkers.length}`);

  const dispatched: string[] = [];
  let failed = 0;
  // One reading for the whole tick, so every decision below is measured from
  // the same instant. `now` is the schedule's idea of the time and is used for
  // slot arithmetic; this is the wall clock, and the two must not be confused.
  const tickStartedAt = Date.now();

  for (const [index, worker] of dueWorkers.entries()) {
    // **Before the claim, which is the whole point.** A claim moves the slot
    // on whether or not the run then happens, so checking afterwards would
    // spend slots on workers this tick has already decided not to start. Asked
    // here, a worker that is not reached keeps its slot and is due again on the
    // next tick.
    const elapsedMs = Date.now() - tickStartedAt;
    if (elapsedMs >= MAX_TICK_EXECUTION_MS) {
      console.warn(
        "[dispatcher] tick execution budget reached — " +
          `elapsed_ms=${elapsedMs} started=${dispatched.length + failed} ` +
          `due=${dueWorkers.length} not_started=${dueWorkers.length - index}`,
      );
      break;
    }

    try {
      if (!(await claimSlot(worker, now))) {
        continue;
      }

      await enqueueRoutine(worker.id);
      dispatched.push(worker.id);
    } catch (error) {
      // A worker that was already running is neither. Nothing was handed off,
      // so it is not dispatched; nothing went wrong, so it is not failed. The
      // slot it cost is spent either way — the claim above happened, and this
      // does not undo it.
      if (isExecutionSuppressed(error)) {
        console.warn(
          "[dispatcher] worker was already running — slot spent, nothing started",
          worker.id,
        );
        continue;
      }

      // A worker whose outcome could not be written down **was still started**,
      // which is the whole of what this number counts. Putting it in `failed`
      // would say the hand-off did not happen, and it did — the run reached a
      // provider. What is missing is the record of it, and that is in the log.
      if (isRunPersistenceError(error)) {
        console.error(
          "[dispatcher] worker ran but its outcome could not be recorded",
          worker.id,
          error,
        );
        dispatched.push(worker.id);
        continue;
      }

      // The id is the point of this line: without it the log says a worker
      // failed and leaves you to guess which of them it was.
      console.error("[dispatcher] worker failed", worker.id, error);
      failed += 1;
    }
  }

  return { dispatched, failed };
}

/**
 * Moves a worker's pending slot on, and says whether this call is the one that
 * did it.
 *
 * Gathering the owner's timezone is the dispatcher's job because reading rows
 * already is: it loads the workers and writes the result back. Handing the
 * schedule module a complete `ScheduleInput` is what keeps that module free of
 * the database and pure enough to reason about on its own.
 *
 * Where the slot lands is the schedule module's call, including what to do
 * about slots missed while the service was down. `now` is passed through for
 * that decision rather than acted on here — a dispatcher that compared the two
 * itself would be holding a scheduling policy.
 *
 * A worker with no pending slot has nothing to claim. The scheduler never
 * returns one, since a null `nextRunAt` cannot be due; the guard stays because
 * a slot that could be claimed twice is the one thing this function exists to
 * prevent.
 */
async function claimSlot(worker: DueWorker, now: Date): Promise<boolean> {
  if (worker.nextRunAt === null) {
    return false;
  }

  const timezone = await getUserTimezone(worker.userId);

  const nextRunAt = advanceSchedule(
    {
      frequency: worker.frequency,
      runAtMinutes: worker.runAtMinutes,
      runAtWeekday: worker.runAtWeekday,
      runAtDay: worker.runAtDay,
      timezone,
    },
    worker.nextRunAt,
    now,
  );

  return claimRoutineSlot(worker.id, worker.nextRunAt, nextRunAt);
}
