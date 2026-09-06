import type { CreatorFeedbackContext } from "@/lib/creator/analyzer";

/**
 * Turning feedback that has aged out of the recent window into one summary.
 *
 * **A different act from judging a piece of writing, and kept apart from it.**
 * The analyzer decides what to publish and reads evidence to do it; this reads
 * evidence and produces an inference for later. Folding the two together would
 * let the material currently being judged become part of what an account is
 * assumed to prefer forever, which is exactly the thing the profile /
 * feedback / memory separation exists to prevent.
 *
 * **No database and no SDK.** Values in, values out — the same boundary
 * `lib/creator/analyzer.ts` keeps, and for the same reason: everything here can
 * be tested without a connection and without a key, and a caller that only
 * needs the *type* of a synthesizer does not pull a provider client in with it.
 *
 * **What it produces is an inference, never a statement.** The owner's stated
 * preferences live in `CreatorProfile` and outrank this; recent raw feedback
 * outranks it too. A summary that read as fact would quietly acquire authority
 * it has not earned.
 */

/** How much of a derived summary may exist, and be sent. */
export const creatorMemoryLimits = {
  /**
   * The longest a stored summary may be.
   *
   * **Refused, never trimmed** — on the way out of the provider and on the way
   * in to an analysis. A cut summary is a different inference, and one that
   * reads as complete.
   */
  summary: 6_000,
  /**
   * How many aged-out answers one synthesis may incorporate.
   *
   * **A batch, not the backlog.** An account that answered a hundred times
   * before this feature existed has eighty-eight aged-out answers, and asking
   * for all of them in one request would make the first analysis after deploy
   * the most expensive one anybody ever runs. Twelve matches the recent window,
   * so a single catch-up step is the same size as the thing it is catching up
   * with, and the rest is picked up by later analyses.
   */
  synthesisFeedbackItems: 12,
  /**
   * The largest synthesis request that may be sent, in UTF-16 code units.
   *
   * **Measured on what is actually serialised**, not estimated from field
   * lengths — the JSON that goes out is the thing with a size. Twelve answers
   * each carrying a long-form draft and an edit can reach well past this, which
   * is why the batch is chosen by measuring rather than by counting alone.
   */
  synthesisRequestChars: 120_000,
} as const;

/** What was inferred from older answers, and how many it stands for. */
export type CreatorAnalysisMemory = {
  summary: string;
  /**
   * How many aged-out answers the summary was built from.
   *
   * **A count of answers, not a position in them.** It is exactly how many are
   * recorded as incorporated, which is what makes it safe to show somebody. It
   * is deliberately not "the oldest N": which answers a summary covers is
   * recorded per answer, because the oldest N is only a fixed set for as long
   * as the oldest N do not change, and nothing makes that true.
   */
  derivedFromCount: number;
};

/** What a synthesis is given: what was concluded before, and what is new. */
export type CreatorMemorySynthesisRequest = {
  /** The summary being extended, or null the first time. */
  previousSummary: string | null;
  /**
   * The next aged-out answers, **oldest first**.
   *
   * The order is the contract, exactly as it is for an analysis: no dates are
   * sent, so position is the only thing carrying recency.
   */
  feedback: CreatorFeedbackContext[];
};

/**
 * Produces one summary. Nothing else.
 *
 * **It returns prose, not a decision.** No verdict, no draft, no channel — a
 * synthesizer that could say "post this" would be a second analyzer with none
 * of the first one's rules.
 */
export type CreatorMemorySynthesizer = {
  synthesize(request: CreatorMemorySynthesisRequest): Promise<string>;
};

/**
 * A summary that cannot be used, named by what is wrong with it.
 *
 * **Nothing of the summary is in the message.** It is an inference about
 * somebody's unpublished writing, and an error string travels further than the
 * value it describes. The same shape as every other boundary error here — one
 * class and one predicate.
 */
export class InvalidCreatorMemoryError extends Error {
  /** A rule name. Never any of the text. */
  readonly reason: string;

  constructor(reason: string) {
    super(`The derived memory cannot be used (${reason})`);
    this.name = "InvalidCreatorMemoryError";
    this.reason = reason;
  }
}

export function isInvalidCreatorMemory(error: unknown): boolean {
  return error instanceof InvalidCreatorMemoryError;
}

/**
 * Whether a summary a provider returned may be stored.
 *
 * **Trim-empty is a failure, not an empty summary.** A model that answered
 * with nothing has not concluded "there is nothing to conclude"; it has failed
 * to answer, and storing that would mark answers as incorporated into a summary
 * that says nothing about them.
 */
export function assertUsableMemorySummary(summary: unknown): string {
  if (typeof summary !== "string") {
    throw new InvalidCreatorMemoryError("summary-not-a-string");
  }

  if (summary.trim() === "") {
    throw new InvalidCreatorMemoryError("summary-empty");
  }

  if (summary.length > creatorMemoryLimits.summary) {
    throw new InvalidCreatorMemoryError("summary-too-long");
  }

  return summary;
}

/**
 * Whether a stored memory value may be sent to an analysis.
 *
 * **Read back rather than trusted.** The row was written by an earlier version
 * of this code, or by a synthesis that has since been changed; a summary past
 * the limit or a count that is not a whole number describes a state this
 * version cannot reason about, and sending it would be sending something
 * nobody can say is correct.
 */
export function assertUsableMemory(memory: CreatorAnalysisMemory): void {
  assertUsableMemorySummary(memory.summary);

  if (!Number.isInteger(memory.derivedFromCount)) {
    throw new InvalidCreatorMemoryError("count-not-an-integer");
  }

  if (memory.derivedFromCount < 0) {
    throw new InvalidCreatorMemoryError("count-negative");
  }
}

/** A stored summary, with the number of answers actually recorded against it. */
export type CreatorMemoryRecord = CreatorAnalysisMemory & {
  evidenceCount: number;
};

/**
 * Whether a stored summary may be treated as this account's current memory.
 *
 * **One rule, used by the analysis and by the panel that describes it.** The
 * page exists to tell somebody what the next analysis will be told; a summary
 * shown there that the analysis would refuse to send is the panel contradicting
 * the thing it documents. So both ask this, and neither gets its own slightly
 * different idea of what counts.
 *
 * It adds two conditions to `assertUsableMemory`:
 *
 * **The count has to match the memberships.** `derivedFromCount` says how many
 * answers the summary stands for and the memberships say which; when they
 * disagree, one of them is wrong and nothing here can tell which. Showing or
 * sending it would mean putting a number in front of somebody that describes
 * evidence nobody can name.
 *
 * **A summary standing for nothing is not a summary.** The columns default to
 * an empty string and zero, so a row can exist before anything has been
 * incorporated into it. That row is not a conclusion about anybody.
 *
 * **Nothing is repaired.** A row that fails this is left exactly as it is: the
 * disagreement is real, and writing over it would hide it without resolving it.
 */
export function assertUsableStoredMemory(memory: CreatorMemoryRecord): void {
  assertUsableMemory(memory);

  if (memory.derivedFromCount === 0) {
    throw new InvalidCreatorMemoryError("derived-from-nothing");
  }

  if (memory.evidenceCount !== memory.derivedFromCount) {
    throw new InvalidCreatorMemoryError("count-evidence-mismatch");
  }
}

/** The same question, for callers that have nowhere to put a reason. */
export function isUsableStoredMemory(
  memory: CreatorMemoryRecord | null,
): boolean {
  if (memory === null) {
    return false;
  }

  try {
    assertUsableStoredMemory(memory);
    return true;
  } catch {
    return false;
  }
}

/**
 * How large this synthesis request would be on the wire.
 *
 * **The serialised document, not a sum of fields.** What the provider is sent
 * is JSON, and its overhead — keys, quoting, escaping — is real size. Measuring
 * the thing itself is the only way the bound means what it says.
 */
export function memorySynthesisRequestSize(
  request: CreatorMemorySynthesisRequest,
): number {
  return JSON.stringify(request).length;
}

/**
 * The longest oldest-first run of answers that fits in one synthesis.
 *
 * **A prefix, always.** Two reasons, and the second is the load-bearing one.
 * Oldest first is the order the evidence reads best in; and because what comes
 * back is a *prefix* of what went in, the caller can name the answers it sent
 * by taking the same prefix of its own list — which is what the memberships it
 * writes are made of. A selection that skipped a large answer to reach a
 * smaller one behind it would leave the two lists out of step, and the
 * memberships would then name answers the model never saw.
 *
 * **Whole answers only.** Nothing is cut down to fit: an answer with half its
 * edit removed is a different answer, and the difference between what was
 * proposed and what somebody actually wanted is the most informative thing in
 * the history.
 *
 * Returns an empty array when even the oldest answer alone is too large — the
 * caller then does not call the provider and records nothing, because a summary
 * that skipped it would be a summary claiming to cover it.
 */
export function selectMemorySynthesisBatch(
  previousSummary: string | null,
  candidates: CreatorFeedbackContext[],
): CreatorFeedbackContext[] {
  const batch: CreatorFeedbackContext[] = [];

  for (const item of candidates.slice(
    0,
    creatorMemoryLimits.synthesisFeedbackItems,
  )) {
    const next = [...batch, item];

    if (
      memorySynthesisRequestSize({ previousSummary, feedback: next }) >
      creatorMemoryLimits.synthesisRequestChars
    ) {
      break;
    }

    batch.push(item);
  }

  return batch;
}
