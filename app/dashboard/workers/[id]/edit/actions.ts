"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { deleteRoutine, getRoutine, updateRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireUserId } from "@/lib/session";
import {
  isRoutineFrequency,
  isRoutineStatus,
  type RoutineFrequency,
  type RoutineStatus,
} from "@/types";

export type UpdateRoutineState = { error: string } | null;

/**
 * Deletes a worker and, through the schema's cascade, its run history.
 *
 * The id is bound to the action rather than submitted with the form, and the
 * delete is matched on `id` *and* `userId`, so another tenant's worker is never
 * reachable — it 404s exactly like one that does not exist.
 */
export async function deleteWorkerAction(id: string): Promise<void> {
  const userId = await requireUserId();

  const deleted = await deleteRoutine(id, userId);
  if (!deleted) {
    notFound();
  }

  revalidatePath("/dashboard");
  redirect("/dashboard?deleted=1");
}

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

  const name = String(formData.get("name") ?? "").trim();
  const prompt = String(formData.get("prompt") ?? "").trim();
  const rawStatus = String(formData.get("status") ?? "");
  const rawFrequency = String(formData.get("frequency") ?? "");

  if (!name) {
    return { error: "Name is required." };
  }

  const status: RoutineStatus = isRoutineStatus(rawStatus)
    ? rawStatus
    : existing.status;

  const frequency: RoutineFrequency = isRoutineFrequency(rawFrequency)
    ? rawFrequency
    : existing.frequency;

  // Changing the cadence invalidates the pending slot: a worker switched to
  // `manual` must stop being due, and one switched away from it needs a first
  // slot. An unchanged cadence keeps its slot so editing never shifts the
  // schedule.
  const nextRunAt =
    frequency === existing.frequency
      ? existing.nextRunAt
      : calculateNextRunAt(frequency);

  await updateRoutine(id, { name, prompt, status, frequency, nextRunAt }, userId);

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
