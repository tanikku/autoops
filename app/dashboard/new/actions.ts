"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { createRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { ensureUser } from "@/lib/users";
import {
  isRoutineFrequency,
  isRoutineStatus,
  type RoutineFrequency,
  type RoutineStatus,
} from "@/types";

export type CreateRoutineState = { error: string } | null;

export async function createRoutineAction(
  _prevState: CreateRoutineState,
  formData: FormData,
): Promise<CreateRoutineState> {
  // The owner comes from the session, never from the submitted form.
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    redirect("/");
  }

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const prompt = String(formData.get("prompt") ?? "").trim();
  const schedule = String(formData.get("schedule") ?? "").trim();
  const rawStatus = String(formData.get("status") ?? "");
  const rawFrequency = String(formData.get("frequency") ?? "");

  if (!name) {
    return { error: "Name is required." };
  }

  const status: RoutineStatus = isRoutineStatus(rawStatus)
    ? rawStatus
    : "draft";

  const frequency: RoutineFrequency = isRoutineFrequency(rawFrequency)
    ? rawFrequency
    : "manual";

  // JWT sessions never write the account row, so make sure it exists before
  // the first row that references it.
  await ensureUser({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image,
  });

  await createRoutine(
    {
      name,
      description,
      prompt,
      schedule,
      status,
      frequency,
      nextRunAt: calculateNextRunAt(frequency),
    },
    session.user.id,
  );

  revalidatePath("/dashboard");
  redirect("/dashboard");
}
