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
import { t, type TranslationKey } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { consumeAiDraftQuota } from "@/lib/rate-limit";
import { createRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireProvisionedUserId, requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";
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
  const userId = await requireUserId();

  // **Read for the wording of the answer, and for nothing else.** Which fields
  // are required, and what gets written, are the same in every language. The
  // account row may not exist yet — this reads through a fallback rather than
  // creating one, so the order below is untouched: authenticate, validate,
  // provision, write.
  const language = await getUserLanguage(userId);

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
      message: t(language, "worker.action.kindRequired"),
      values: input,
    };
  }

  const kind = input.kind;
  const errors = validateWorkerFormForKind(
    input,
    { status, frequency },
    kind,
    language,
  );
  if (hasWorkerFormErrors(errors)) {
    return {
      status: "error",
      message: summarizeWorkerFormErrors(errors, language),
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
        websiteUrl: t(language, "worker.validation.websiteUrlInvalid"),
      };

      return {
        status: "error",
        message: summarizeWorkerFormErrors(urlErrors, language),
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
  const provisionedUserId = await requireProvisionedUserId();

  // A time of day only means anything alongside a cadence, and a weekday only
  // alongside a week: a manual worker has no slot to place either in, and a
  // daily one runs on every day there is.
  const runAtMinutes = frequency === "manual" ? null : input.runAtMinutes;
  const runAtWeekday = frequency === "weekly" ? input.runAtWeekday : null;
  const runAtDay = frequency === "monthly" ? input.runAtDay : null;
  const timezone = await getUserTimezone(provisionedUserId);

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
      await createRoutine(routine, provisionedUserId);
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
        const created = await createRoutine(routine, provisionedUserId, tx);
        await createWebsiteSource(created.id, websiteUrl, tx);
      });
    }
  } catch (error) {
    console.error("[worker] create failed", error);
    return {
      status: "error",
      message: t(language, "worker.action.createFailed"),
      values: input,
    };
  }

  revalidatePath("/dashboard");
  // The caller raises the toast and then navigates, so the outcome never has
  // to survive in the URL.
  // **The name is the owner's and is placed, not glued.** It goes into the
  // sentence exactly as it was typed, in whichever language it was written.
  return {
    status: "success",
    message: t(language, "worker.action.created", { name: input.name }),
  };
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
const DRAFT_MESSAGE_KEYS = {
  notConfigured: "worker.draft.notConfigured",
  empty: "worker.draft.empty",
  tooLong: "worker.draft.tooLong",
  timeout: "worker.draft.timeout",
  unavailable: "worker.draft.unavailable",
  unreadable: "worker.draft.unreadable",
  limitReached: "worker.draft.limitReached",
  failed: "worker.draft.failed",
} as const satisfies Record<string, TranslationKey>;

/**
 * One of the eight, in the language the account reads.
 *
 * **The limit is formatted the way it always was.** Grouping a number is a
 * formatting question rather than a wording one, and Day 2B changes wording
 * only — so `2,000` reads the same on both versions of this screen.
 */
function draftMessage(
  language: string,
  key: keyof typeof DRAFT_MESSAGE_KEYS,
): string {
  return t(language, DRAFT_MESSAGE_KEYS[key], {
    limit: MAX_WORKER_DRAFT_REQUEST_CHARS.toLocaleString("en-US"),
  });
}

/**
 * Describes a worker from a sentence, without creating one.
 *
 * **It creates no worker, and it does write one thing.** No routine and no
 * source: the result is a set of values for a form somebody is looking at, and
 * the only path to those tables is still `createRoutineAction` below, reached
 * by pressing Save. What it does write is the account's own allowance — asking
 * a model costs something, so a request that is going to be made is counted
 * before it is made.
 *
 * **That write is why provisioning appears here at all.** It did not before,
 * and the comment that said so was right at the time: with nothing being
 * written there was no row that had to exist. `RateLimitBucket` carries a
 * foreign key to `User`, so now there is — and the order it is asked for in is
 * the one Sprint 42 settled, unchanged:
 *
 * ```
 * authentication  →  validation  →  provisioning  →  the write itself
 * ```
 *
 * **Everything that can reject the request comes first**, and none of it
 * provisions: an empty request, one past the length limit, and an AutoOps with
 * no AI configured all leave without the account row being brought into being.
 * Somebody who pressed the button and typed nothing has still written nothing.
 *
 * **The addresses are found here rather than by the model.** `lib/ai` is handed
 * the ones already written in the request, and its answer can only point at
 * them by number, so a plausible URL nobody typed has no way into a draft.
 */
export async function generateWorkerDraftAction(
  _prevState: WorkerDraftState,
  formData: FormData,
): Promise<WorkerDraftState> {
  const userId = await requireUserId();

  // **A read, and only for the wording of a failure.** Nothing about which
  // language the account is set to reaches the generator, the request, or the
  // draft that comes back.
  const language = await getUserLanguage(userId);

  const request = String(formData.get("request") ?? "").trim();

  if (request === "") {
    return { status: "error", message: draftMessage(language, "empty") };
  }

  if (request.length > MAX_WORKER_DRAFT_REQUEST_CHARS) {
    return { status: "error", message: draftMessage(language, "tooLong") };
  }

  // **No stand-in.** A fabricated run produces a sentence somebody reads and
  // dismisses; a fabricated draft produces settings somebody saves.
  const generator = createWorkerDraftGenerator();

  if (!generator) {
    return {
      status: "error",
      message: draftMessage(language, "notConfigured"),
    };
  }

  // **The row has to exist before the allowance can point at it.** This is the
  // same boundary `createRoutineAction` and Settings go through, asked for at
  // the same place in the same order: after everything that could reject the
  // request, before the first write. A failure to write it leaves as a
  // `UserProvisioningError` and is not caught here — nothing has been counted
  // and no model has been asked, which is exactly the state a caller that saw
  // the throw would want.
  const provisionedUserId = await requireProvisionedUserId();

  // **Counted before the request is made, and never given back after.** What
  // the allowance protects against is the asking, so the count has to move on
  // the way in; a failure afterwards has already cost whatever the call cost.
  let allowed: boolean;
  try {
    allowed = await consumeAiDraftQuota(provisionedUserId);
  } catch (error) {
    // **Fail closed.** Not knowing how much of the allowance is left is not the
    // same as knowing there is some, and the safe reading of a database that
    // will not answer is that the request does not go ahead. The driver's own
    // complaint stays in the log: it names tables and connection strings, and
    // the person at the form can do nothing with it.
    //
    // **Not `unavailable`.** That sentence says the AI service could not be
    // reached, and nothing here has tried to reach it — the failure is
    // AutoOps' own. What goes back names no cause at all, which is the only
    // accurate thing left to say once the database is ruled out as something
    // to tell a reader about.
    console.error("[draft] the rate limit could not be read", error);
    return { status: "error", message: draftMessage(language, "failed") };
  }

  if (!allowed) {
    // An ordinary answer, not a failure: the account asked for more drafts in
    // an hour than the allowance holds. Nothing is logged as an error, because
    // nothing went wrong.
    return { status: "error", message: draftMessage(language, "limitReached") };
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
      return { status: "error", message: draftMessage(language, "unreadable") };
    }

    // The kind is logged and not shown. Nothing about it changes what the
    // person does next except whether waiting is worth it.
    const kind = providerErrorKind(error);
    console.error(`[draft] generation failed — kind=${kind}`);

    return {
      status: "error",
      message: draftMessage(
        language,
        kind === "timeout" ? "timeout" : "unavailable",
      ),
    };
  }
}
