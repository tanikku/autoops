"use server";

import { revalidatePath } from "next/cache";
import { enqueueRoutine } from "@/lib/queue";
import { getRoutine } from "@/lib/routines";
import { requireUserId } from "@/lib/session";
import type { ActionResult } from "@/types";

export type RunRoutineState = ActionResult | null;

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

  try {
    await enqueueRoutine(routineId);
  } catch (error) {
    console.error("[worker] manual run failed", error);
    return { status: "error", message: `"${routine.name}" failed to run.` };
  }

  revalidatePath("/dashboard");
  return { status: "success", message: `"${routine.name}" ran successfully.` };
}
