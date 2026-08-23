"use server";

import { revalidatePath } from "next/cache";
import { providerErrorKind } from "@/lib/ai/provider";
import {
  extractUrlCandidates,
  isInvalidWorkerDraftResponse,
  MAX_WORKER_DRAFT_REQUEST_CHARS,
  type WorkerDraft,
} from "@/lib/ai/worker-draft";
import { createWorkerDraftGenerator } from "@/lib/ai/worker-draft-factory";
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

/**
 * What came of asking AutoOps to describe a worker.
 *
 * **Three of these are answers and one is a failure**, and the difference is
 * not decoration. A request AutoOps cannot do yet was understood perfectly
 * well; a website worker whose request named no page is one question from
 * being complete. Neither is an error, and neither should arrive as one — which
 * is also why this never goes through `useActionResult`: that raises a toast
 * for every result and navigates on success, and none of the three answers here
 * wants either.
 */
export type WorkerDraftState =
  | { status: "supported"; draft: WorkerDraft }
  | { status: "unsupported"; reason: string }
  | { status: "needs_input"; field: "websiteUrl"; message: string }
  | { status: "error"; message: string }
  | null;

/**
 * What a failure is shown as.
 *
 * **The provider's own vocabulary stops at `lib/ai`.** A kind like
 * `rate-limited` or `invalid-request` describes a request somebody else made to
 * a third party; the person here pressed a button on a form. Only the
 * difference they can act on survives the crossing — wait and retry, or give up
 * on drafting and fill the form in.
 */
const DRAFT_MESSAGES = {
  notConfigured: "Drafting is unavailable because AutoOps has no AI configured.",
  empty: "Describe what you would like AutoOps to handle.",
  tooLong: `Keep the description under ${MAX_WORKER_DRAFT_REQUEST_CHARS.toLocaleString("en-US")} characters.`,
  timeout: "Drafting took too long. Try again.",
  unavailable: "The AI service could not be reached. Try again.",
  unreadable:
    "AutoOps could not read the answer. Try describing the work again.",
} as const;

/**
 * Describes a worker from a sentence, without creating one.
 *
 * **Nothing here writes anything.** No routine, no source, no account row: the
 * result is a set of values for a form somebody is looking at, and the only
 * path to the database is still `createRoutineAction` below, reached by
 * pressing Save. That is why this asks `requireUserId` rather than
 * `requireProvisionedUserId` — provisioning exists for writes that need the
 * account row to exist first, and this is not one.
 *
 * **The addresses are found here rather than by the model.** `lib/ai` is handed
 * the ones already written in the request, and its answer can only point at
 * them by number, so a plausible URL nobody typed has no way into a draft.
 */
export async function generateWorkerDraftAction(
  _prevState: WorkerDraftState,
  formData: FormData,
): Promise<WorkerDraftState> {
  await requireUserId();

  const request = String(formData.get("request") ?? "").trim();

  if (request === "") {
    return { status: "error", message: DRAFT_MESSAGES.empty };
  }

  if (request.length > MAX_WORKER_DRAFT_REQUEST_CHARS) {
    return { status: "error", message: DRAFT_MESSAGES.tooLong };
  }

  // **No stand-in.** A fabricated run produces a sentence somebody reads and
  // dismisses; a fabricated draft produces settings somebody saves.
  const generator = createWorkerDraftGenerator();

  if (!generator) {
    return { status: "error", message: DRAFT_MESSAGES.notConfigured };
  }

  try {
    const result = await generator.generate({
      request,
      urlCandidates: extractUrlCandidates(request),
    });

    return result.status === "supported"
      ? { status: "supported", draft: result.draft }
      : result;
  } catch (error) {
    // An answer that arrived and could not be used, rather than one that never
    // arrived. Nothing is retried: the person is standing at the form and can
    // ask again in the words that suit them.
    if (isInvalidWorkerDraftResponse(error)) {
      console.error("[draft] the model's answer could not be read");
      return { status: "error", message: DRAFT_MESSAGES.unreadable };
    }

    // The kind is logged and not shown. Nothing about it changes what the
    // person does next except whether waiting is worth it.
    const kind = providerErrorKind(error);
    console.error(`[draft] generation failed — kind=${kind}`);

    return {
      status: "error",
      message:
        kind === "timeout" ? DRAFT_MESSAGES.timeout : DRAFT_MESSAGES.unavailable,
    };
  }
}
