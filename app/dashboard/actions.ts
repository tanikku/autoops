"use server";

import { revalidatePath } from "next/cache";
import { runRoutine } from "@/lib/runs";

export async function runRoutineAction(formData: FormData): Promise<void> {
  const routineId = String(formData.get("routineId") ?? "");
  if (!routineId) {
    return;
  }

  await runRoutine(routineId);
  revalidatePath("/dashboard");
}
