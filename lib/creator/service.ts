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
  type CreatorFeedbackCandidate,
  type CreatorFeedbackPartition,
  createCreatorFeedback,
  normalizeOptionalText,
  readCreatorFeedbackPartition,
  readCreatorMemory,
  readCreatorProfile,
  readDecisionForFeedback,
  readUnsummarizedOlderFeedback,
  saveCreatorAnalysis,
  saveCreatorMemory,
  type StoredCreatorMemory,
} from "@/lib/creator/repository";
import {
  assertUsableStoredMemory,
  type CreatorAnalysisMemory,
  type CreatorMemorySynthesizer,
  creatorMemoryLimits,
  isInvalidCreatorMemory,
  selectMemorySynthesisBatch,
} from "@/lib/creator/memory";
import { providerErrorKind } from "@/lib/ai/provider";
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
  synthesizer: CreatorMemorySynthesizer | null,
): Promise<CreatorAnalysisOutcome> {
  // **The original text is what is judged and what is stored.** Only the
  // emptiness check looks at a trimmed copy; trimming what gets saved would
  // change somebody's material on its way in.
  if (source.body.trim() === "") {
    throw new EmptyCreatorContentError();
  }

  const title = normalizeOptionalText(source.title);

  // **One read establishes the split.** `recent` is what the analyzer is shown;
  // the boundary behind it is what any summary is measured against, so the two
  // can never describe the same answer.
  const [profile, partition] = await Promise.all([
    readCreatorProfile(userId),
    readCreatorFeedbackPartition(userId),
  ]);

  const feedback = partition.recent;

  // **Everything about memory happens here, before the request is built and
  // outside every transaction.** It may make one provider call; it may make
  // none. Whatever happens, `memory` ends up as a value the analyzer can be
  // given or as null, and never as a reason this analysis fails.
  const memory = await settleCreatorMemory(userId, partition, synthesizer);

  const request: CreatorAnalysisRequest = {
    profile,
    memory,
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
  synthesizer: CreatorMemorySynthesizer | null = null,
): Promise<CreatorAnalysisOutcome> {
  return analyzeCreatorContent(
    userId,
    { sourceKind: "text", sourceUrl: null, title: input.title, body: input.body },
    analyzer,
    synthesizer,
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
  synthesizer: CreatorMemorySynthesizer | null = null,
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
    synthesizer,
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

/**
 * The summary of older answers this analysis should be given, if any.
 *
 * **Every way this can go wrong ends with an analysis that still happens.** A
 * summary is context somebody's judgement is better with and fine without: the
 * answers it stands for are all still in the database, and the recent twelve —
 * the stronger evidence — are unaffected by anything here. So a provider that
 * times out, a row this version cannot read, a race lost to another analysis,
 * or a batch too large to send all resolve to *less* memory rather than to a
 * failed analysis. The one thing that is never done is guessing.
 *
 * **At most one synthesis per analysis, and no retry.** Catching up on a long
 * history happens across later analyses; making one of them pay for all of it
 * would put the slowest possible request in front of the call somebody is
 * actually waiting for.
 *
 * **No provider call is inside a transaction.** Reads happen, then the model is
 * asked, then a conditional write — a connection held open across somebody
 * else's API latency is a connection nobody else can use.
 */
async function settleCreatorMemory(
  userId: string,
  partition: CreatorFeedbackPartition,
  synthesizer: CreatorMemorySynthesizer | null,
): Promise<CreatorAnalysisMemory | null> {
  const { olderBoundary } = partition;

  if (olderBoundary === null) {
    // Twelve or fewer answers: every one of them is in `recent`, so there is no
    // older side for a summary to stand for.
    return null;
  }

  // **Read and judged before the boundary is used for anything.** What comes
  // back is either a summary this analysis is willing to send or nothing, and
  // that decision is made once.
  let stored: StoredCreatorMemory | null;

  try {
    stored = await readCreatorMemory(userId);
  } catch (error) {
    // The analysis has everything it strictly needs; this was the extra.
    logMemoryAnomaly("read-failed", error);
    return null;
  }

  const usable = usableStoredMemory(stored);

  if (stored !== null && usable === null) {
    // Refused above, and the reason is already logged there.
    return null;
  }

  if (synthesizer === null) {
    // This deployment cannot extend a summary. Use whatever is there.
    return asAnalysisMemory(usable);
  }

  return (
    (await refreshCreatorMemory({
      userId,
      olderBoundary,
      stored: usable,
      synthesizer,
    })) ?? asAnalysisMemory(usable)
  );
}

/** The two values the analyzer is given, and nothing about where they came from. */
function asAnalysisMemory(
  memory: StoredCreatorMemory | null,
): CreatorAnalysisMemory | null {
  return memory === null
    ? null
    : { summary: memory.summary, derivedFromCount: memory.derivedFromCount };
}

/**
 * Whether a stored summary may be sent alongside this analysis's recent answers.
 *
 * **The rule itself lives in `lib/creator/memory.ts`,** because the panel on
 * `/creator/new` asks the same question. That page tells somebody what the next
 * analysis will be told; if it could show a summary this refuses to send, it
 * would be contradicting the thing it documents. What is here is only what
 * happens when the answer is no — logged, and carried on without.
 *
 * **Nothing is repaired and nothing is rewritten downward.** The summary really
 * was built from whatever it was built from, and adjusting a count to make it
 * fit would erase a disagreement rather than resolve it. This analysis proceeds
 * on the recent answers alone, which is the stronger evidence in any case.
 *
 * **Overlap with the recent twelve is not checked, because it cannot happen.**
 * A membership is only ever recorded for an answer already on the older side of
 * some boundary, and answers are only ever appended — so the boundary moves
 * forward and a row that has aged out never returns to the recent twelve.
 */
function usableStoredMemory(
  memory: StoredCreatorMemory | null,
): StoredCreatorMemory | null {
  if (memory === null) {
    return null;
  }

  try {
    assertUsableStoredMemory(memory);
  } catch (error) {
    // Counts are safe to log and are the whole diagnostic when they disagree;
    // the writing they describe is not, and never appears here.
    logMemoryAnomaly(
      `stored-memory-unusable count=${memory.derivedFromCount} evidence=${memory.evidenceCount}`,
      error,
    );
    return null;
  }

  return memory;
}

/**
 * One catch-up step, or nothing.
 *
 * **The batch is whatever has no membership, not whatever comes next.** There
 * is no ordering being advanced through: the candidates are older answers this
 * summary has never been shown, and the ones that are sent get a membership row
 * each. An answer that became visible late is picked up whenever it is seen,
 * however it sorts against answers already incorporated.
 *
 * **The count moves by exactly what was recorded.** A batch of seven moves it
 * by seven, because seven memberships are written in the same transaction. It
 * is a count of those rows and cannot mean anything else.
 */
async function refreshCreatorMemory({
  userId,
  olderBoundary,
  stored,
  synthesizer,
}: {
  userId: string;
  olderBoundary: NonNullable<CreatorFeedbackPartition["olderBoundary"]>;
  stored: StoredCreatorMemory | null;
  synthesizer: CreatorMemorySynthesizer;
}): Promise<CreatorAnalysisMemory | null> {
  const previousSummary = stored?.summary ?? null;
  const alreadySummarized = stored?.derivedFromCount ?? 0;

  let candidates: CreatorFeedbackCandidate[];

  try {
    candidates = await readUnsummarizedOlderFeedback(
      userId,
      olderBoundary,
      creatorMemoryLimits.synthesisFeedbackItems,
    );
  } catch (error) {
    logMemoryAnomaly("older-batch-read-failed", error);
    return null;
  }

  if (candidates.length === 0) {
    // The summary already covers every answer on the older side. Ordinary, and
    // the caller keeps what it read.
    return null;
  }

  // **The largest oldest-first run that fits.** `selectMemorySynthesisBatch`
  // returns a prefix of what it was given, which is what lets the answers that
  // were sent be named by taking the same prefix of the candidates.
  const batch = selectMemorySynthesisBatch(
    previousSummary,
    candidates.map((candidate) => candidate.context),
  );

  if (batch.length === 0) {
    // Even the oldest outstanding answer is too large to send on its own, and
    // summarising past it would produce a summary claiming to cover it.
    logMemoryAnomaly("batch-does-not-fit");
    return null;
  }

  let summary: string;
  try {
    summary = await synthesizer.synthesize({ previousSummary, feedback: batch });
  } catch (error) {
    // Provider failure, refusal, or an answer that could not be used. The
    // summary stays where it was and the analysis carries on.
    logMemoryAnomaly("synthesis-failed", error);
    return null;
  }

  const feedbackIds = candidates
    .slice(0, batch.length)
    .map((candidate) => candidate.feedbackId);

  let written: boolean;
  try {
    written = await saveCreatorMemory({
      userId,
      memoryId: stored?.id ?? null,
      summary,
      expectedCount: alreadySummarized,
      feedbackIds,
    });
  } catch (error) {
    logMemoryAnomaly("memory-write-failed", error);
    return null;
  }

  if (written) {
    return {
      summary,
      derivedFromCount: alreadySummarized + feedbackIds.length,
    };
  }

  // **Somebody else got there first, and this analysis keeps what it read.**
  // Not the winner's summary: that row was never validated here, its count and
  // its memberships were never read together, and adopting it would mean
  // sending a value on the strength of a write that happened after the only
  // read this analysis did. What was validated is still true, so it is what
  // gets used, and the next analysis reads the winner properly.
  logMemoryAnomaly(`cas-lost expected=${alreadySummarized}`);

  return null;
}

/**
 * Says that something went sideways, and nothing about what was in it.
 *
 * **Counts and rule names only.** A summary, a draft, an edit and an excerpt are
 * all somebody's unpublished writing; a log line outlives the request it came
 * from and is read by people the writing was never for. What is useful to an
 * operator — which step, which category, which numbers — carries none of it.
 */
function logMemoryAnomaly(operation: string, error?: unknown): void {
  const kind = error === undefined ? null : creatorMemoryFailureKind(error);

  console.error(
    `[creator] memory ${operation}${kind === null ? "" : ` — ${kind}`}`,
  );
}

/** A safe category for a failure, never the failure's own words. */
function creatorMemoryFailureKind(error: unknown): string {
  if (isInvalidCreatorMemory(error)) {
    return `invalid:${(error as { reason: string }).reason}`;
  }

  const providerKind = providerErrorKind(error);

  if (providerKind !== "unknown") {
    return `provider:${providerKind}`;
  }

  return error instanceof Error ? `error:${error.name}` : "error:unknown";
}
