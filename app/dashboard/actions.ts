"use server";

import { revalidatePath } from "next/cache";
import { enqueueRoutine } from "@/lib/queue";

export async function runRoutineAction(formData: FormData): Promise<void> {
  const routineId = String(formData.get("routineId") ?? "");
  if (!routineId) {
    return;
  }

  await enqueueRoutine(routineId);
  revalidatePath("/dashboard");
}
