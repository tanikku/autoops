"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createRoutine } from "@/lib/routines";
import { isRoutineStatus, type RoutineStatus } from "@/types";

export type CreateRoutineState = { error: string } | null;

export async function createRoutineAction(
  _prevState: CreateRoutineState,
  formData: FormData,
): Promise<CreateRoutineState> {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const prompt = String(formData.get("prompt") ?? "").trim();
  const schedule = String(formData.get("schedule") ?? "").trim();
  const rawStatus = String(formData.get("status") ?? "");

  if (!name) {
    return { error: "Name is required." };
  }

  const status: RoutineStatus = isRoutineStatus(rawStatus)
    ? rawStatus
    : "draft";

  await createRoutine({ name, description, prompt, schedule, status });

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
