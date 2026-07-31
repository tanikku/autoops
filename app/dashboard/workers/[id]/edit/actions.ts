"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getRoutine, updateRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireUserId } from "@/lib/session";
import {
  isRoutineFrequency,
  isRoutineStatus,
  type ActionResult,
  type RoutineFrequency,
  type RoutineStatus,
} from "@/types";

export type UpdateRoutineState = ActionResult | null;

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
    return { status: "error", message: "Name is required." };
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

  try {
    await updateRoutine(
      id,
      { name, prompt, status, frequency, nextRunAt },
      userId,
    );
  } catch (error) {
    console.error("[worker] update failed", error);
    return { status: "error", message: "Could not save the worker." };
  }

  revalidatePath("/dashboard");
  return { status: "success", message: `Worker "${name}" saved.` };
}
