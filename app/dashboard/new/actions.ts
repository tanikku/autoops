"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { createRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { ensureUser } from "@/lib/users";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateWorkerForm,
  type WorkerFieldErrors,
  type WorkerFormInput,
} from "@/lib/worker-input";
import type { ActionResult } from "@/types";

/**
 * A rejected submission carries the values and the per-field messages back.
 *
 * React resets a form once its action settles, so without the values the
 * fields would fall back to their original defaults and everything the user
 * typed — including a long prompt — would be lost to a missing name. The
 * errors let each field say what is wrong with it, next to the input.
 */
export type CreateRoutineState =
  | (ActionResult & { values?: WorkerFormInput; errors?: WorkerFieldErrors })
  | null;

export async function createRoutineAction(
  _prevState: CreateRoutineState,
  formData: FormData,
): Promise<CreateRoutineState> {
  // The owner comes from the session, never from the submitted form.
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    redirect("/");
  }

  const input = readWorkerForm(formData);

  const errors = validateWorkerForm(input);
  if (hasWorkerFormErrors(errors)) {
    return {
      status: "error",
      message: summarizeWorkerFormErrors(errors),
      values: input,
      errors,
    };
  }

  // A new worker starts as a draft that nothing schedules, so both fall back
  // to the quietest option rather than to a previous value.
  const status = input.status ?? "draft";
  const frequency = input.frequency ?? "manual";

  // JWT sessions never write the account row, so make sure it exists before
  // the first row that references it.
  await ensureUser({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    image: session.user.image,
  });

  try {
    await createRoutine(
      {
        name: input.name,
        description: input.description,
        prompt: input.prompt,
        schedule: input.schedule,
        status,
        frequency,
        nextRunAt: calculateNextRunAt(frequency),
      },
      session.user.id,
    );
  } catch (error) {
    console.error("[worker] create failed", error);
    return {
      status: "error",
      message: "Could not create the worker.",
      values: input,
    };
  }

  revalidatePath("/dashboard");
  // The caller raises the toast and then navigates, so the outcome never has
  // to survive in the URL.
  return { status: "success", message: `Worker "${input.name}" created.` };
}
