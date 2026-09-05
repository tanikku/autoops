"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { providerErrorKind } from "@/lib/ai/provider";
import {
  creatorAnalysisLimits,
  isCreatorAnalysisRequestTooLarge,
  isInvalidCreatorAnalysisResponse,
} from "@/lib/creator/analyzer";
import { createCreatorAnalyzer } from "@/lib/creator/creator-analyzer-factory";
import {
  isCreatorDecisionNotFound,
  isCreatorFeedbackAlreadyRecorded,
  isInvalidCreatorFeedbackHistory,
} from "@/lib/creator/repository";
import {
  analyzeCreatorText,
  isEmptyCreatorContent,
  isInvalidCreatorFeedback,
  recordCreatorFeedback,
} from "@/lib/creator/service";
import { t, type TranslationKey } from "@/lib/i18n";
import { consumeCreatorAnalysisQuota } from "@/lib/rate-limit";
import { requireProvisionedUserId, requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";
import { type ActionResult, isCreatorFeedbackAction } from "@/types";

/**
 * The outside edge of the Creator loop.
 *
 * **Thin on purpose.** Everything about what a good decision is, what a valid
 * history looks like and what may be written lives in `lib/creator`; this file
 * decides who is asking, whether they may ask again this hour, and what to say
 * when something goes wrong. Re-deciding any of that here would give the same
 * question two answers that could drift apart.
 *
 * **Three things arrive from outside and none of them is trusted.** The owner
 * comes from the session, never from a form. What kind of source this is and
 * which channels get judged are not the client's to choose — C1 has one way in
 * and three channels, and a field naming either would be a claim nothing
 * checks. What the form may say is a title and a body.
 */

export type CreatorAnalysisState = ActionResult | null;
export type CreatorFeedbackState = ActionResult | null;

/**
 * The wording each outcome gets.
 *
 * Keys rather than sentences so that a message which does not exist is a
 * compile error, exactly as `DRAFT_MESSAGE_KEYS` does it next door.
 */
const ANALYSIS_MESSAGE_KEYS = {
  notConfigured: "creator.analysis.notConfigured",
  empty: "creator.analysis.empty",
  tooLong: "creator.analysis.tooLong",
  limitReached: "creator.analysis.limitReached",
  timeout: "creator.analysis.timeout",
  unavailable: "creator.analysis.unavailable",
  unreadable: "creator.analysis.unreadable",
  failed: "creator.analysis.failed",
  done: "creator.analysis.done",
} as const satisfies Record<string, TranslationKey>;

const FEEDBACK_MESSAGE_KEYS = {
  saved: "creator.feedback.saved",
  alreadyRecorded: "creator.feedback.alreadyRecorded",
  invalid: "creator.feedback.invalid",
  failed: "creator.feedback.failed",
} as const satisfies Record<string, TranslationKey>;

function analysisMessage(
  language: string,
  key: keyof typeof ANALYSIS_MESSAGE_KEYS,
): string {
  return t(language, ANALYSIS_MESSAGE_KEYS[key]);
}

function feedbackMessage(
  language: string,
  key: keyof typeof FEEDBACK_MESSAGE_KEYS,
): string {
  return t(language, FEEDBACK_MESSAGE_KEYS[key]);
}

/** A field as the form sent it, or an empty string when it sent nothing. */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Asks Koqentra to read one piece of writing and say where it belongs.
 *
 * **The order is what keeps the cheap refusals cheap.** An empty box and a
 * piece past the limit are settled before the account row is brought into
 * being, before the allowance moves, and before anything is sent anywhere;
 * somebody who pressed the button by accident has spent nothing.
 *
 * **There is no stand-in when no key is configured.** A worker with no model
 * records a fixed line that reads as a placeholder; an invented editorial
 * judgement reads exactly like a real one and somebody would publish it. The
 * feature is absent rather than pretending.
 */
export async function analyzeCreatorTextAction(
  _prevState: CreatorAnalysisState,
  formData: FormData,
): Promise<CreatorAnalysisState> {
  const rawTitle = field(formData, "title");
  const body = field(formData, "body");

  // **Who is asking, without writing anything down.** A signed-out request is
  // redirected, and this throws to do it — so nothing below may swallow that
  // with a general catch.
  //
  // **Read-only on purpose.** `requireProvisionedUserId` is not the identity
  // check with a longer name: it creates the account row. Asking for it here
  // would mean a submission that is about to be rejected has already brought
  // that row into being, which is the one thing the provisioning boundary
  // exists to prevent. It is asked for below, once the request is known to be
  // one that could go ahead.
  const userId = await requireUserId();

  // Read only to choose the wording of a result. Nothing about the account's
  // language reaches the analyzer, the request, or what comes back.
  const language = await getUserLanguage(userId);

  if (body.trim() === "") {
    return { status: "error", message: analysisMessage(language, "empty") };
  }

  // **Checked here as well as in the service.** The service is the contract and
  // keeps its own check; this one is the outside edge, and its job is to turn a
  // request nobody can act on away before it costs anything.
  if (body.length > creatorAnalysisLimits.contentBody) {
    return { status: "error", message: analysisMessage(language, "tooLong") };
  }

  if (rawTitle.trim().length > creatorAnalysisLimits.contentTitle) {
    return { status: "error", message: analysisMessage(language, "tooLong") };
  }

  // **The first write of the request, and everything that could reject it has
  // already happened.** The same boundary, asked for at the same point in the
  // same order, as `createRoutineAction` and `generateWorkerDraftAction`: after
  // validation, before anything is counted or sent. A failure to write the row
  // leaves as a `UserProvisioningError` and is not caught here — nothing has
  // been spent and no model has been asked, which is the state a caller seeing
  // the throw would want.
  const provisionedUserId = await requireProvisionedUserId();

  const analyzer = createCreatorAnalyzer();

  if (analyzer === null) {
    // **Before the allowance moves.** Charging somebody for a feature this
    // deployment does not have would be charging them for nothing.
    return {
      status: "error",
      message: analysisMessage(language, "notConfigured"),
    };
  }

  // **The provisioned id from here on.** Both are the same account — the
  // provider's `sub` either way — but the one that carries a guarantee the row
  // exists is the one a foreign key may point at.
  let allowed: boolean;
  try {
    allowed = await consumeCreatorAnalysisQuota(provisionedUserId);
  } catch (error) {
    // **Fail closed.** Not knowing how much allowance is left is not the same
    // as knowing there is some. The driver's own complaint names tables and
    // connection strings and stays in the log; what goes back names no cause,
    // because once the database is ruled out there is nothing accurate left to
    // tell a reader.
    console.error("[creator] the rate limit could not be read", error);
    return { status: "error", message: analysisMessage(language, "failed") };
  }

  if (!allowed) {
    // An ordinary answer rather than a failure, so nothing is logged.
    return {
      status: "error",
      message: analysisMessage(language, "limitReached"),
    };
  }

  try {
    await analyzeCreatorText(
      provisionedUserId,
      { title: rawTitle === "" ? null : rawTitle, body },
      analyzer,
    );

    // **The write happened here, so the invalidation belongs here.** The inbox
    // is a Server Component reading the database; after this action the cached
    // render of `/creator` describes a moment before the analysis existed, and
    // the client navigation that follows would show it. In production that read
    // as "nothing to review" on a page that had three decisions waiting —
    // correct on a refresh, wrong on arrival.
    //
    // **Not in the client, and not in the shared hook.** `useActionResult` is a
    // navigation contract several features share; putting one feature's cache
    // invalidation inside it would make every future caller inherit a rule that
    // has nothing to do with them. A mutation invalidating what it changed is
    // the mutation's own business.
    //
    // **A fixed path, and only on success.** Nothing about the account or the
    // writing is passed here — the route is the same string for everybody, and
    // the per-user data behind it is fetched by the page under its own session.
    revalidatePath("/creator");

    // **Nothing about the writing comes back.** What a screen needs to render
    // is a question for the checkpoint that builds one; returning drafts here
    // would put unpublished text in a form's state before anybody had decided
    // it belongs there.
    return { status: "success", message: analysisMessage(language, "done") };
  } catch (error) {
    return {
      status: "error",
      message: analysisMessage(language, analysisFailure(error)),
    };
  }
}

/**
 * Names what went wrong, in the vocabulary the reader gets.
 *
 * **Nothing that came from a model, a driver or a stored row is quoted.** The
 * failures are logged by category and by nothing else: an analyzer's answer and
 * an account's history are both unpublished writing, and a log line is not the
 * place for either.
 */
function analysisFailure(error: unknown): keyof typeof ANALYSIS_MESSAGE_KEYS {
  // Both of these are the outside edge catching what the service already
  // refuses. They arrive when the two disagree about a boundary, which is worth
  // a message rather than a crash.
  if (isEmptyCreatorContent(error)) {
    return "empty";
  }

  if (isCreatorAnalysisRequestTooLarge(error)) {
    return "tooLong";
  }

  if (isInvalidCreatorAnalysisResponse(error)) {
    console.error("[creator] the model's answer could not be read");
    return "unreadable";
  }

  if (isInvalidCreatorFeedbackHistory(error)) {
    // The stored history holds something this version cannot read as evidence.
    // The decision's id is enough to find it; nothing it contains is logged.
    const decisionId = (error as { decisionId?: unknown }).decisionId;
    console.error(`[creator] stored history is unusable — decision=${decisionId}`);
    return "failed";
  }

  const kind = providerErrorKind(error);

  if (kind !== "unknown") {
    // The existing vocabulary, reused rather than reinvented. The kind is
    // logged and not shown: it changes nothing the person does next except
    // whether waiting is worth it.
    console.error(`[creator] analysis failed — kind=${kind}`);
    return kind === "timeout" ? "timeout" : "unavailable";
  }

  // Everything left is Koqentra's own side — a write that would not commit,
  // most likely. The error object is logged for the operator; its message is
  // never what the reader is shown.
  console.error("[creator] analysis could not be completed", error);
  return "failed";
}

/**
 * Records what somebody decided about one of those judgements.
 *
 * **No allowance is spent and no model is called.** This writes a single row
 * about a decision that already exists; bounding it with the analysis quota
 * would make disagreeing with Koqentra cost the same as asking it a question,
 * which is the opposite of what the feedback loop is for.
 */
export async function recordCreatorFeedbackAction(
  _prevState: CreatorFeedbackState,
  formData: FormData,
): Promise<CreatorFeedbackState> {
  const decisionId = field(formData, "editorialDecisionId");
  const action = field(formData, "action");
  const editedBody = field(formData, "editedBody");
  const reason = field(formData, "reason");

  // Read-only, for the same reason as above: a submission about to be turned
  // away must not be what creates the account row.
  const userId = await requireUserId();
  const language = await getUserLanguage(userId);

  if (decisionId === "") {
    // Nothing was named, so there is nothing to be found — the same answer as
    // naming something that does not exist.
    notFound();
  }

  if (!isCreatorFeedbackAction(action)) {
    return { status: "error", message: feedbackMessage(language, "invalid") };
  }

  const provisionedUserId = await requireProvisionedUserId();

  try {
    await recordCreatorFeedback(provisionedUserId, decisionId, {
      action,
      // Empty is nothing written, which is what null already means. The service
      // decides whether an answer of this kind may carry text at all.
      editedBody: editedBody === "" ? null : editedBody,
      reason: reason === "" ? null : reason,
    });

    return { status: "success", message: feedbackMessage(language, "saved") };
  } catch (error) {
    // **A decision belonging to somebody else is answered exactly as one that
    // does not exist.** The repository already refuses to tell them apart; this
    // keeps that true all the way out, so no id can be probed for existence.
    if (isCreatorDecisionNotFound(error)) {
      notFound();
    }

    if (isCreatorFeedbackAlreadyRecorded(error)) {
      // Not a failure and not an overwrite: the earlier answer stands.
      return {
        status: "error",
        message: feedbackMessage(language, "alreadyRecorded"),
      };
    }

    if (isInvalidCreatorFeedback(error)) {
      // The reason is a rule name, safe to log and useless to quote at a
      // reader — the text involved is theirs and stays out of both.
      const reasonName = (error as { reason?: unknown }).reason;
      console.error(`[creator] feedback rejected — reason=${reasonName}`);
      return { status: "error", message: feedbackMessage(language, "invalid") };
    }

    console.error("[creator] feedback could not be saved", error);
    return { status: "error", message: feedbackMessage(language, "failed") };
  }
}
