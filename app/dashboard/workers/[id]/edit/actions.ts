"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getRoutine, updateRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireUserId } from "@/lib/session";
import {
  readWorkerForm,
  validateWorkerForm,
  type WorkerFormInput,
} from "@/lib/worker-input";
import type { ActionResult } from "@/types";

/**
 * A rejected submission carries the values back.
 *
 * React resets a form once its action settles, so without this the fields
 * would fall back to the stored worker and everything the user typed would be
 * lost to a missing name.
 */
export type UpdateRoutineState =
  | (ActionResult & { values?: WorkerFormInput })
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

  const error = validateWorkerForm(input);
  if (error) {
    return { status: "error", message: error, values: input };
  }

  // An existing worker falls back to what it already had: an unreadable value
  // must not quietly reset a running worker to a draft.
  const status = input.status ?? existing.status;
  const frequency = input.frequency ?? existing.frequency;

  // Changing the cadence invalidates the pending slot: a worker switched to
  // `manual` must stop being due, and one switched away from it needs a first
  // slot. An unchanged cadence keeps its slot so editing never shifts the
  // schedule.
  const nextRunAt =
    frequency === existing.frequency
      ? existing.nextRunAt
      : calculateNextRunAt(frequency);

  try {
    await updateRoutine(
      id,
      {
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        schedule: input.schedule,
        status,
        frequency,
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
