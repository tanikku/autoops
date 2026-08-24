"use server";

import { revalidatePath } from "next/cache";
import { isExecutionSuppressed } from "@/lib/execution-lease";
import { enqueueRoutine } from "@/lib/queue";
import { deleteRoutine, getRoutine } from "@/lib/routines";
import { isRunPersistenceError } from "@/lib/runs";
import { DEFAULT_LANGUAGE, t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";
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

  // Read for the wording of the answer, and for nothing else.
  const language = await getUserLanguage(userId);

  // **A delete that threw is not a delete that found nothing.** The two are
  // the same to whoever pressed the button — the worker is still there either
  // way — but only one of them means something is wrong, and the reason for it
  // belongs in the log rather than in a toast. Every other action that writes
  // catches its own write; this was the one that did not, and an exception
  // escaping here reaches a page the caller has already navigated away from.
  let deleted: boolean;
  try {
    deleted = await deleteRoutine(id, userId);
  } catch (error) {
    console.error("[worker] delete failed", error);
    return {
      status: "error",
      message: t(language, "worker.action.deleteFailed"),
    };
  }

  // Missing and someone else's are deliberately the same answer: the query
  // matched on `id` *and* `userId`, so a worker that is not this account's
  // cannot be told apart from one that does not exist.
  if (!deleted) {
    return { status: "error", message: t(language, "worker.action.notFound") };
  }

  revalidatePath("/dashboard");
  return { status: "success", message: t(language, "worker.action.deleted") };
}

export async function runRoutineAction(
  _prevState: RunRoutineState,
  formData: FormData,
): Promise<RunRoutineState> {
  const routineId = String(formData.get("routineId") ?? "");
  if (!routineId) {
    // **The one message here that stays English**, and deliberately.
    //
    // A form that submitted nothing is answered before anybody is
    // authenticated, which is the order this action has always kept — and
    // whose language to answer in is not a question that can be asked yet.
    // Reading the account row first would send a visitor with no session to
    // sign in where they used to get this sentence, which is a change to what
    // the action does rather than to what it says.
    //
    // The wording still comes from the dictionary so it stays with the rest of
    // them; only the language is fixed. The ordering itself is a separate
    // question from this Sprint's.
    return {
      status: "error",
      message: t(DEFAULT_LANGUAGE, "run.action.noWorkerSelected"),
    };
  }

  // Only the owner may run a worker. `getRoutine` returns null for a worker
  // that belongs to someone else, so this rejects without revealing that the
  // id exists.
  const userId = await requireUserId();

  // Read for the wording of the answers below, and for nothing else.
  const language = await getUserLanguage(userId);

  const routine = await getRoutine(routineId, userId);
  if (!routine) {
    return { status: "error", message: t(language, "worker.action.notFound") };
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
        message: t(language, "run.action.alreadyRunning", {
          name: routine.name,
        }),
      };
    }

    // The run reached a provider; what could not be written is what it did.
    // **The wording stops short of saying the outcome was lost** — a driver
    // that throws may be reporting a lost response rather than a rejected
    // write, so whether the activity feed will show this run is not something
    // this knows.
    if (isRunPersistenceError(error)) {
      return {
        status: "error",
        message: t(language, "run.action.outcomeNotRecorded", {
          name: routine.name,
        }),
      };
    }

    console.error("[worker] manual run failed", error);
    return {
      status: "error",
      message: t(language, "run.action.failed", { name: routine.name }),
    };
  }

  revalidatePath("/dashboard");

  // A failed run is recorded rather than thrown, so the absence of an
  // exception no longer means the worker succeeded.
  if (run.status === "failed") {
    return {
      status: "error",
      message: t(language, "run.action.failed", { name: routine.name }),
    };
  }

  // **What the run produced is not in here.** Its output, and the reason a
  // failed one gives, are stored on the execution and shown on its own page,
  // in the words they arrived in.
  return {
    status: "success",
    message: t(language, "run.action.succeeded", { name: routine.name }),
  };
}
