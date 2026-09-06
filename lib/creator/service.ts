import "server-only";

import {
  assertCreatorAnalysisRequestWithinLimits,
  type CreatorAnalysisRequest,
  type CreatorAnalysisResult,
  type CreatorAnalyzer,
  creatorAnalysisLimits,
} from "@/lib/creator/analyzer";
import {
  CreatorDecisionNotFoundError,
  createCreatorFeedback,
  normalizeOptionalText,
  readCreatorProfile,
  readDecisionForFeedback,
  readRecentFeedbackContext,
  saveCreatorAnalysis,
} from "@/lib/creator/repository";
import type { CreatorFeedbackAction } from "@/types";

/**
 * The Creator loop, in the order it happens.
 *
 * **Everything this needs is handed to it.** The owner arrives as an argument
 * and the analyzer arrives as a dependency: nothing here reads a session, and
 * nothing here decides whether a real model or a fake one is at the other end.
 * That is what makes the whole loop testable without a key, and what stops a
 * unit test from quietly spending money. Choosing the provider is the entry
 * point's job, in C1.4.
 *
 * **The model is called outside every transaction.** A request may take the
 * better part of a minute; a database connection held open for that would be
 * one connection per analysis spent waiting on somebody else's API.
 */

/** What somebody pasted in. No owner: that is an argument, never input. */
export type CreatorTextInput = {
  title: string | null;
  body: string;
};

/**
 * What was read from a page. No owner, and no raw URL either.
 *
 * `sourceUrl` is the address the body actually came from — after redirects —
 * because that is the page that was read. It arrives already fetched: this
 * layer never touches the network, exactly as it never touches a session.
 */
export type CreatorUrlInput = {
  title: string | null;
  sourceUrl: string;
  body: string;
};

/**
 * The material and where it came from, as one indivisible fact.
 *
 * **Server-decided, never submitted.** Which arm this is follows from which of
 * the two entry points below was called, and those are chosen by a server
 * action. A form field naming a source kind would be a claim about provenance
 * that nothing could check.
 */
type CreatorSourceInput =
  | { sourceKind: "text"; sourceUrl: null; title: string | null; body: string }
  | { sourceKind: "url"; sourceUrl: string; title: string | null; body: string };

/** The material was empty, so there was nothing to judge. */
export class EmptyCreatorContentError extends Error {
  constructor() {
    super("There is no text to analyse.");
    this.name = "EmptyCreatorContentError";
  }
}

export function isEmptyCreatorContent(error: unknown): boolean {
  return error instanceof EmptyCreatorContentError;
}

/** What an edit or a rejection said, without the owner it cannot choose. */
export type CreatorFeedbackInput = {
  action: CreatorFeedbackAction;
  editedBody: string | null;
  reason: string | null;
};

/** The answer does not describe something that could have happened. */
export class InvalidCreatorFeedbackError extends Error {
  /** A field name or a rule name — never any of the text involved. */
  readonly reason: string;

  constructor(reason: string) {
    super(`That feedback cannot be recorded (${reason})`);
    this.name = "InvalidCreatorFeedbackError";
    this.reason = reason;
  }
}

export function isInvalidCreatorFeedback(error: unknown): boolean {
  return error instanceof InvalidCreatorFeedbackError;
}

/**
 * What a completed analysis leaves behind.
 *
 * Deliberately small. What a screen needs to render is a question for the
 * checkpoint that builds one; guessing at it now would mean a shape nobody has
 * looked at yet becoming something to keep compatible with.
 */
export type CreatorAnalysisOutcome = {
  contentItemId: string;
  result: CreatorAnalysisResult;
};

/**
 * Judges one pasted piece and records what was decided.
 *
 * The order matters at two points and both are about not writing things down
 * too early: the request is measured before the model is called, so an
 * oversized request costs nothing; and **nothing is written until the analysis
 * has succeeded**, so a failed call leaves no content item, no empty profile,
 * and no half-finished set of decisions.
 */
async function analyzeCreatorContent(
  userId: string,
  source: CreatorSourceInput,
  analyzer: CreatorAnalyzer,
): Promise<CreatorAnalysisOutcome> {
  // **The original text is what is judged and what is stored.** Only the
  // emptiness check looks at a trimmed copy; trimming what gets saved would
  // change somebody's material on its way in.
  if (source.body.trim() === "") {
    throw new EmptyCreatorContentError();
  }

  const title = normalizeOptionalText(source.title);

  const [profile, feedback] = await Promise.all([
    readCreatorProfile(userId),
    readRecentFeedbackContext(userId),
  ]);

  const request: CreatorAnalysisRequest = {
    profile,
    content: {
      // Carried from the entry point rather than chosen here, and never from a
      // form: the two callers below are the only things that may say what a
      // source is.
      sourceKind: source.sourceKind,
      sourceUrl: source.sourceUrl,
      title,
      body: source.body,
    },
    feedback,
  };

  // **Before the call, not after a 413.** The limits belong to
  // `lib/creator/analyzer.ts`; nothing here restates a number it owns.
  assertCreatorAnalysisRequestWithinLimits(request);

  const result = await analyzer.analyze(request);

  const { contentItemId } = await saveCreatorAnalysis(
    source.sourceKind === "url"
      ? {
          userId,
          title,
          body: source.body,
          result,
          sourceKind: "url",
          sourceUrl: source.sourceUrl,
        }
      : {
          userId,
          title,
          body: source.body,
          result,
          sourceKind: "text",
          sourceUrl: null,
        },
  );

  return { contentItemId, result };
}

export async function analyzeCreatorText(
  userId: string,
  input: CreatorTextInput,
  analyzer: CreatorAnalyzer,
): Promise<CreatorAnalysisOutcome> {
  return analyzeCreatorContent(
    userId,
    { sourceKind: "text", sourceUrl: null, title: input.title, body: input.body },
    analyzer,
  );
}

/**
 * Judges one page that was read from a public address.
 *
 * **The same loop as the paste, with a different provenance.** The profile, the
 * recent answers, the request limits, the ordering and the all-or-nothing write
 * are identical — a URL changes where the words came from and nothing about how
 * they are judged.
 *
 * **The fetch already happened.** Reading a page is
 * `lib/creator/url-source.ts`'s job, and keeping it out of here is what lets
 * the whole loop be tested without a network.
 */
export async function analyzeCreatorUrl(
  userId: string,
  input: CreatorUrlInput,
  analyzer: CreatorAnalyzer,
): Promise<CreatorAnalysisOutcome> {
  return analyzeCreatorContent(
    userId,
    {
      sourceKind: "url",
      sourceUrl: input.sourceUrl,
      title: input.title,
      body: input.body,
    },
    analyzer,
  );
}

/**
 * Records what somebody decided about a decision.
 *
 * **The decision is fetched by id *and* owner**, so one that belongs to
 * somebody else comes back as absent. The caller then has a single case to map
 * to a 404, and there is no way to learn from the outside whether a given id
 * exists at all.
 *
 * The rules below are the ones the database cannot state: an edit only makes
 * sense where there was something to edit, and an approval carrying edited text
 * is not an approval of anything that was proposed.
 */
export async function recordCreatorFeedback(
  userId: string,
  editorialDecisionId: string,
  input: CreatorFeedbackInput,
): Promise<{ id: string }> {
  const decision = await readDecisionForFeedback(userId, editorialDecisionId);

  if (decision === null) {
    throw new CreatorDecisionNotFoundError();
  }

  const reason = normalizeOptionalText(input.reason);

  if (reason !== null && reason.length > creatorAnalysisLimits.feedbackReason) {
    throw new InvalidCreatorFeedbackError("reason-too-long");
  }

  if (input.action === "edit") {
    if (decision.verdict !== "recommend") {
      throw new InvalidCreatorFeedbackError("edit-of-skip");
    }

    if (!decision.hasDraft) {
      throw new InvalidCreatorFeedbackError("edit-without-draft");
    }

    if (input.editedBody === null || input.editedBody.trim() === "") {
      throw new InvalidCreatorFeedbackError("edit-without-edited-body");
    }

    if (input.editedBody.length > creatorAnalysisLimits.feedbackEditedBody) {
      throw new InvalidCreatorFeedbackError("edited-body-too-long");
    }
  } else if (input.editedBody !== null) {
    // Approving *and* rewriting are two different answers. Storing both would
    // leave the next analysis unable to tell which one actually happened.
    throw new InvalidCreatorFeedbackError("edited-body-without-edit");
  }

  return createCreatorFeedback({
    userId,
    editorialDecisionId,
    action: input.action,
    // **The original draft is left exactly as written.** The pair — proposed
    // and wanted — is the most informative thing the history ever holds, and
    // overwriting the first half to store the second would destroy it.
    editedBody: input.action === "edit" ? input.editedBody : null,
    reason,
  });
}
