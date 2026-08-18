"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireProvisionedUserId, requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";
import { isWatcherError } from "@/lib/watcher/errors";
import { parseWatchUrl } from "@/lib/watcher/url";
import { createWebsiteSource } from "@/lib/website-sources";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateWorkerFormForKind,
  type WorkerFieldErrors,
  type WorkerFormInput,
} from "@/lib/worker-input";
import type { ActionResult, CreateRoutineInput } from "@/types";

/**
 * What the address field says when the URL is not one AutoOps would fetch.
 *
 * **One message for every way of getting it wrong**, rather than the kind-by-kind
 * wording `parseWatchUrl` throws. Those messages were written for a fetch that
 * is being refused, where the reader is looking at a stored worker; here the
 * reader is looking at the box they just typed in, and the useful thing to say
 * is what belongs in it.
 *
 * **It does not say the address is reachable, or safe.** Nothing has been
 * resolved or requested at this point — that happens on every run, in
 * `lib/watcher`, and a page that passes here can still be refused there.
 */
const INVALID_WEBSITE_URL =
  "Enter a full website address, like https://example.com/news.";

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
  // **Who is asking comes first, and it is only a question.** A visitor with no
  // session is sent to sign in before anything they submitted is read, whether
  // or not it was valid. This writes nothing — provisioning is a separate step,
  // below, and deliberately not part of authenticating.
  await requireUserId();

  const input = readWorkerForm(formData);

  // A new worker starts as a draft that nothing schedules, so both fall back
  // to the quietest option rather than to a previous value.
  //
  // **Worked out before validation, because validation reads them.** Whether a
  // blank prompt is allowed depends on what the worker will be saved as, not
  // on what the form happened to send. Both of these are pure — nothing is
  // read or written to decide them.
  const status = input.status ?? "draft";
  const frequency = input.frequency ?? "manual";

  // **The one field with no fallback.** Status and frequency default because a
  // worker that does not say is a quiet one, and both can be changed afterwards
  // anyway. A kind cannot: it decides what gets created alongside the worker and
  // is the one thing editing will not revisit. Defaulting an unreadable value to
  // `prompt` would answer a question nobody asked — and would do it by creating
  // a worker that ignores the address that was submitted with it.
  if (input.kind === null) {
    return {
      status: "error",
      message: "Choose whether this worker runs a prompt or watches a page.",
      values: input,
    };
  }

  const kind = input.kind;
  const errors = validateWorkerFormForKind(input, { status, frequency }, kind);
  if (hasWorkerFormErrors(errors)) {
    return {
      status: "error",
      message: summarizeWorkerFormErrors(errors),
      values: input,
      errors,
    };
  }

  // **Parsed here, before anything is written, and never inside the
  // transaction.** What gets stored is the canonical form `URL` produces rather
  // than the string as typed, so the address a run fetches is the one that was
  // checked. Still only syntax: see `INVALID_WEBSITE_URL`.
  let websiteUrl: string | null = null;
  if (kind === "website") {
    try {
      websiteUrl = parseWatchUrl(input.websiteUrl).toString();
    } catch (error) {
      if (!isWatcherError(error)) {
        throw error;
      }

      const urlErrors: WorkerFieldErrors = {
        websiteUrl: INVALID_WEBSITE_URL,
      };

      return {
        status: "error",
        message: summarizeWorkerFormErrors(urlErrors),
        values: input,
        errors: urlErrors,
      };
    }
  }

  // The owner comes from the session, never from the submitted form — the same
  // session the check above read. JWT sessions never write the account row, so
  // this is also what makes sure it exists before the first row that references
  // it: a `Routine` carries a foreign key to it. Asked for after validation, so
  // a rejected submission never creates the row it would have needed.
  const userId = await requireProvisionedUserId();

  // A time of day only means anything alongside a cadence, and a weekday only
  // alongside a week: a manual worker has no slot to place either in, and a
  // daily one runs on every day there is.
  const runAtMinutes = frequency === "manual" ? null : input.runAtMinutes;
  const runAtWeekday = frequency === "weekly" ? input.runAtWeekday : null;
  const runAtDay = frequency === "monthly" ? input.runAtDay : null;
  const timezone = await getUserTimezone(userId);

  const routine: CreateRoutineInput = {
    name: input.name,
    description: input.description,
    prompt: input.prompt,
    kind,
    status,
    frequency,
    runAtMinutes,
    runAtWeekday,
    runAtDay,
    nextRunAt: calculateNextRunAt({
      frequency,
      runAtMinutes,
      runAtWeekday,
      runAtDay,
      timezone,
    }),
  };

  try {
    if (websiteUrl === null) {
      await createRoutine(routine, userId);
    } else {
      // **Both rows or neither.** A website worker is the pair — a routine that
      // says it watches something and a source that says what. Written apart,
      // the failure is not "creation failed" but a worker that exists, appears
      // in the dashboard, and fails every run because there is nothing to
      // fetch; nobody looking at it could tell it from one that was made
      // correctly. The transaction is what makes a half-made watcher
      // unrepresentable rather than merely unlikely.
      //
      // There is nothing to retry: a rollback leaves the account exactly as it
      // was, and the person is still on the form.
      await prisma.$transaction(async (tx) => {
        const created = await createRoutine(routine, userId, tx);
        await createWebsiteSource(created.id, websiteUrl, tx);
      });
    }
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
