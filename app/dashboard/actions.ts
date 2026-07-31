"use server";

import { revalidatePath } from "next/cache";
import { enqueueRoutine } from "@/lib/queue";
import { getRoutine } from "@/lib/routines";
import { requireUserId } from "@/lib/session";

export async function runRoutineAction(formData: FormData): Promise<void> {
  const routineId = String(formData.get("routineId") ?? "");
  if (!routineId) {
    return;
  }

  // Only the owner may run a worker. `getRoutine` returns null for a worker
  // that belongs to someone else, so this rejects without revealing that the
  // id exists.
  const userId = await requireUserId();
  const routine = await getRoutine(routineId, userId);
  if (!routine) {
    return;
  }

  await enqueueRoutine(routineId);
  revalidatePath("/dashboard");
}
