"use server";

import { revalidatePath } from "next/cache";
import { isExecutionSuppressed } from "@/lib/execution-lease";
import { enqueueRoutine } from "@/lib/queue";
import { deleteRoutine, getRoutine } from "@/lib/routines";
import { requireUserId } from "@/lib/session";
import type { ActionResult } from "@/types";

export type RunRoutineState = ActionResult | null;
export type DeleteWorkerState = ActionResult | null;

/**
 * Deletes a worker and, through the schema's cascade, its run history.
 *
 * This lives on the dashboard rather than the edit page because a server action
 * re-renders the page it was called from: the edit page would look up a worker
 * that no longer exists and 404 before the success toast could show.
 *
 * The id is bound to the action rather than submitted with the form, and the
 * delete is matched on `id` *and* `userId`, so another tenant's worker is never
 * reachable.
 */
export async function deleteWorkerAction(
  id: string,
  prevState: DeleteWorkerState,
): Promise<DeleteWorkerState> {
  void prevState; // required by `useActionState`, unused here
  const userId = await requireUserId();

  const deleted = await deleteRoutine(id, userId);
  if (!deleted) {
    return { status: "error", message: "Worker not found." };
  }

  revalidatePath("/dashboard");
  return { status: "success", message: "Worker deleted." };
}

export async function runRoutineAction(
  _prevState: RunRoutineState,
  formData: FormData,
): Promise<RunRoutineState> {
  const routineId = String(formData.get("routineId") ?? "");
  if (!routineId) {
    return { status: "error", message: "No worker selected." };
  }

  // Only the owner may run a worker. `getRoutine` returns null for a worker
  // that belongs to someone else, so this rejects without revealing that the
  // id exists.
  const userId = await requireUserId();
  const routine = await getRoutine(routineId, userId);
  if (!routine) {
    return { status: "error", message: "Worker not found." };
  }

  let run;
  try {
    run = await enqueueRoutine(routineId);
  } catch (error) {
    // Already running is not a failure — nothing was attempted, so there is
    // nothing that went wrong. Saying so is the difference between "try again"
    // and "wait": the run this button would have started is happening.
    //
    // Nothing else changes. The schedule is untouched, no run is recorded, and
    // the worker is not queued behind the one in progress.
    if (isExecutionSuppressed(error)) {
      return {
        status: "error",
        message: `"${routine.name}" is already running.`,
      };
    }

    console.error("[worker] manual run failed", error);
    return { status: "error", message: `"${routine.name}" failed to run.` };
  }

  revalidatePath("/dashboard");

  // A failed run is recorded rather than thrown, so the absence of an
  // exception no longer means the worker succeeded.
  if (run.status === "failed") {
    return { status: "error", message: `"${routine.name}" failed to run.` };
  }

  return { status: "success", message: `"${routine.name}" ran successfully.` };
}
