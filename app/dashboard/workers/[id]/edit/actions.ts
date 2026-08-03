"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getRoutine, updateRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateWorkerForm,
  type WorkerFieldErrors,
  type WorkerFormInput,
} from "@/lib/worker-input";
import type { ActionResult } from "@/types";

/**
 * A rejected submission carries the values and the per-field messages back.
 *
 * React resets a form once its action settles, so without the values the
 * fields would fall back to the stored worker and everything the user typed
 * would be lost to a missing name. The errors let each field say what is wrong
 * with it, next to the input.
 */
export type UpdateRoutineState =
  | (ActionResult & { values?: WorkerFormInput; errors?: WorkerFieldErrors })
  | null;

export async function updateRoutineAction(
  id: string,
  _prevState: UpdateRoutineState,
  formData: FormData,
): Promise<UpdateRoutineState> {
  const userId = await requireUserId();

  // Reading through the tenant-scoped query means another owner's worker is
  // indistinguishable from one that does not exist.
  const existing = await getRoutine(id, userId);
  if (!existing) {
    notFound();
  }

  const input = readWorkerForm(formData);

  const errors = validateWorkerForm(input);
  if (hasWorkerFormErrors(errors)) {
    return {
      status: "error",
      message: summarizeWorkerFormErrors(errors),
      values: input,
      errors,
    };
  }

  // An existing worker falls back to what it already had: an unreadable value
  // must not quietly reset a running worker to a draft.
  const status = input.status ?? existing.status;
  const frequency = input.frequency ?? existing.frequency;

  // A time of day only means anything alongside a cadence, and a weekday only
  // alongside a week: a manual worker has no slot to place either in, and a
  // daily one runs on every day there is.
  const runAtMinutes = frequency === "manual" ? null : input.runAtMinutes;
  const runAtWeekday = frequency === "weekly" ? input.runAtWeekday : null;
  const runAtDay = frequency === "monthly" ? input.runAtDay : null;
  const timezone = await getUserTimezone(userId);

  // Any part of the schedule changing invalidates the pending slot: a worker
  // switched to `manual` must stop being due, one switched away from it needs a
  // first slot, and a worker moved from Monday to Wednesday should not run on
  // Monday once more first. Leaving all of it alone keeps the slot, so editing
  // a name or prompt never shifts the schedule.
  const scheduleChanged =
    frequency !== existing.frequency ||
    runAtMinutes !== existing.runAtMinutes ||
    runAtWeekday !== existing.runAtWeekday ||
    runAtDay !== existing.runAtDay;

  const nextRunAt = scheduleChanged
    ? calculateNextRunAt({
        frequency,
        runAtMinutes,
        runAtWeekday,
        runAtDay,
        timezone,
      })
    : existing.nextRunAt;

  try {
    await updateRoutine(
      id,
      {
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        status,
        frequency,
        runAtMinutes,
        runAtWeekday,
        runAtDay,
        nextRunAt,
      },
      userId,
    );
  } catch (error) {
    console.error("[worker] update failed", error);
    return {
      status: "error",
      message: "Could not save the worker.",
      values: input,
    };
  }

  // The detail and edit pages both render this worker, so revalidating only
  // the dashboard leaves them serving pre-save values. Navigating back to the
  // edit form would then repopulate it from the stale cache, and saving again
  // would write those old values over the new ones.
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/workers/${id}`);
  revalidatePath(`/dashboard/workers/${id}/edit`);

  return { status: "success", message: `Worker "${input.name}" saved.` };
}
