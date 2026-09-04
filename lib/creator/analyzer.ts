import {
  type CreatorFeedbackAction,
  type CreatorSourceKind,
  type CreatorTargetChannel,
  creatorTargetChannels,
  type EditorialVerdict,
  editorialVerdicts,
} from "@/types";

/**
 * Deciding what, if anything, one piece of material is worth publishing.
 *
 * **This file knows nothing about the database.** It takes values and returns
 * values; where a profile or a feedback history came from is somebody else's
 * question. That is what lets the whole decision policy be tested without a
 * connection, and what stops a Prisma row shape from becoming the thing a
 * model is asked about.
 *
 * **It is also not `AIProvider`.** That interface sends a worker's prompt and
 * hands back whatever came out, because there the answer *is* the product.
 * Here the answer is three structured judgements, each of which is a claim
 * about what should happen next — so everything below exists to stop a claim
 * becoming a fact without checking it first. `lib/ai/worker-draft.ts` draws the
 * same line for the same reason.
 *
 * **Nothing here produces or consumes a derived memory.** The analyzer reads
 * the human feedback that actually happened and decides from that; summarising
 * a history into a durable preference is a separate act with its own evidence
 * rules, and mixing it in would let the material currently being judged become
 * part of what the account is assumed to prefer forever.
 */

/**
 * How much of each field may be sent.
 *
 * **Application limits, not column widths.** Every one of these is `String` in
 * the schema, so nothing here is about what Postgres would accept — it is about
 * what is reasonable to put in one request, and about the request failing
 * loudly rather than silently becoming a different request.
 *
 * **Over-length input is refused, never trimmed.** Cutting a body would ask the
 * model to judge material nobody wrote; cutting an edited draft would change
 * what the person's edit actually was, which is the single most informative
 * signal in the whole history. A wrong answer arrived at confidently is worse
 * than an error.
 */
export const creatorAnalysisLimits = {
  contentBody: 40_000,
  contentTitle: 300,
  contentSourceUrl: 8_192,
  profileAudience: 2_000,
  profileGoals: 2_000,
  profileVoiceInstructions: 5_000,
  /** How many past decisions the model is shown. The most recent ones. */
  feedbackItems: 12,
  feedbackDecisionReason: 2_000,
  feedbackReason: 2_000,
  feedbackContentTitle: 300,
  /**
   * How much of the material a past decision was about may be quoted back.
   *
   * Deliberately far short of `contentBody`: this is orientation, not a second
   * copy of an article. Twelve past decisions each carrying a full body would
   * bury the piece actually being judged.
   */
  feedbackContentExcerpt: 2_000,
  /**
   * Past drafts stay at the long-form ceiling even though a *new* `x` draft may
   * not. The history holds decisions for every channel, and a long-form piece
   * somebody edited is exactly the entry worth keeping intact.
   */
  feedbackDraftBody: 20_000,
  feedbackEditedBody: 20_000,
  resultReason: 2_000,
} as const;

/**
 * How long a freshly written draft may be, per channel.
 *
 * **These are sanity limits, not posting limits.** They do not model any
 * platform's rules and must not be read as doing so — in particular the `x`
 * figure is **not** a 280-character limit, and nothing here counts the way X
 * counts. Publishing is not part of C1 at all.
 *
 * What they are for: an editorial policy that asks for a concise standalone
 * post is a request, and a model can wander a long way from one. A short post
 * arriving at nine thousand characters is not a judgement worth acting on, and
 * catching that here means the application does not depend on the prompt alone
 * to hold a shape it cares about.
 */
export const creatorDraftLimits: Record<CreatorTargetChannel, number> = {
  x: 2_000,
  reddit: 10_000,
  longform: 20_000,
};

/** What the owner has said about their own work. Explicit preference. */
export type CreatorAnalysisProfile = {
  audience: string;
  goals: string;
  voiceInstructions: string;
};

/** The material to judge. */
export type CreatorAnalysisContent = {
  sourceKind: CreatorSourceKind;
  sourceUrl: string | null;
  title: string | null;
  body: string;
};

/**
 * One thing that already happened: a decision, and what the person did about it.
 *
 * **Both halves of an edit are here on purpose.** `draftBody` is what was
 * proposed and `editedBody` is what was actually wanted; the difference between
 * them says more about somebody's taste than either does alone, and a context
 * carrying only the final text would throw away the half that carries it.
 *
 * **A rejected skip is the most informative entry there is, and it has no
 * draft.** When somebody disagrees with a decision not to post, nothing in the
 * fields above says what they disagreed *about* — there was never a draft to
 * read. `contentTitle` and `contentExcerpt` are what ground the entry in the
 * material it was about, which is why they are here rather than only on
 * recommendations.
 *
 * **The excerpt arrives already bounded.** This layer does not shorten
 * anything; how a piece is reduced to an excerpt is the repository's decision
 * in C1.3, and doing it here would mean the analyzer quietly choosing what the
 * model gets to see.
 *
 * **No id, no owner, no timestamps.** The model has no use for them, and every
 * field that reaches a prompt is a field that has to be worth the risk of being
 * there. Recency is carried by the order of the array — see
 * `CreatorAnalysisRequest`.
 */
export type CreatorFeedbackContext = {
  targetChannel: CreatorTargetChannel;
  verdict: EditorialVerdict;
  decisionReason: string;
  draftBody: string | null;
  action: CreatorFeedbackAction;
  editedBody: string | null;
  feedbackReason: string | null;
  /** The title of the material this decision was about, when it had one. */
  contentTitle: string | null;
  /** A bounded extract of that material. Built by the caller, never here. */
  contentExcerpt: string;
};

export type CreatorAnalysisRequest = {
  profile: CreatorAnalysisProfile;
  content: CreatorAnalysisContent;
  /**
   * Past decisions **oldest first, newest last**. Empty on somebody's first
   * piece.
   *
   * **The order is the contract, and it is the only thing carrying recency.**
   * No timestamps are sent: a date would be one more thing for the model to
   * reason about and would say nothing the position does not. When two entries
   * disagree — approved a tone once, rejected it later — the later one is the
   * newer evidence and wins between them. An explicit statement in `profile`
   * still outranks both, because it is what the person says they want rather
   * than what they happened to do.
   *
   * A caller that hands these over in the wrong order is not sending an
   * ordering mistake; it is sending a different history.
   */
  feedback: CreatorFeedbackContext[];
};

/**
 * What was decided for one channel.
 *
 * **`skip` is an answer, not a failure.** A channel where this material would
 * not land well is worth saying so about, and an editor that recommends
 * everything is one nobody needs.
 *
 * **`verdict` never carries how the request went.** A call that timed out
 * produced no judgement at all; putting `failed` in this union would file an
 * absence of a decision alongside real ones and let it be learned from later.
 */
export type CreatorChannelDecision = {
  verdict: EditorialVerdict;
  /** Why, in the reader's language. Never empty. */
  reason: string;
  /** The proposed post when recommending, and null when skipping. */
  draftBody: string | null;
};

/**
 * One decision per channel, as fixed properties rather than a list.
 *
 * **The shape is the validation.** A list would let a model return two answers
 * for `x` and none for `reddit`, and every caller would then need code for a
 * case that should not be expressible. This way all three are structurally
 * required, duplicates cannot be written down, and nothing has to re-emit a
 * channel name as a string that could arrive misspelled.
 */
export type CreatorAnalysisResult = {
  [Channel in CreatorTargetChannel]: CreatorChannelDecision;
};

export interface CreatorAnalyzer {
  analyze(request: CreatorAnalysisRequest): Promise<CreatorAnalysisResult>;
}

/**
 * The model answered, but not with something that can be acted on.
 *
 * **Separate from `ProviderError`.** That one means the request did not
 * succeed; this one means it did and the answer is unusable — a recommendation
 * with nothing to publish, a skip carrying a draft, a reply that stopped
 * halfway. The two need different handling by whoever catches them, so they are
 * different types, exactly as `InvalidWorkerDraftResponseError` is.
 *
 * **The message says what was wrong with the shape, never what was in it.**
 */
export class InvalidCreatorAnalysisResponseError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`The AI returned an unusable analysis: ${detail}`, options);
    this.name = "InvalidCreatorAnalysisResponseError";
  }
}

export function isInvalidCreatorAnalysisResponse(error: unknown): boolean {
  return error instanceof InvalidCreatorAnalysisResponseError;
}

/** A request that cannot be sent as written. Raised before anything leaves. */
export class CreatorAnalysisRequestTooLargeError extends Error {
  /** Which field was too big — a field name, never its contents. */
  readonly field: string;

  constructor(field: string, limit: number, actual: number) {
    super(
      `${field} is ${actual} characters, and at most ${limit} may be sent.`,
    );
    this.name = "CreatorAnalysisRequestTooLargeError";
    this.field = field;
  }
}

export function isCreatorAnalysisRequestTooLarge(error: unknown): boolean {
  return error instanceof CreatorAnalysisRequestTooLargeError;
}

function requireWithin(field: string, value: string, limit: number): void {
  if (value.length > limit) {
    throw new CreatorAnalysisRequestTooLargeError(field, limit, value.length);
  }
}

/**
 * Refuses a request that is too large, before a single byte is sent.
 *
 * **Fail closed rather than trim.** See `creatorAnalysisLimits`. The error names
 * the field and the two numbers, which is enough for a caller to say something
 * useful and carries none of the text itself.
 *
 * Counting is by UTF-16 code unit — `String#length` — which is what every limit
 * in this repository already means and what a person's editor is closest to.
 */
export function assertCreatorAnalysisRequestWithinLimits(
  request: CreatorAnalysisRequest,
): void {
  const { profile, content, feedback } = request;

  requireWithin(
    "profile.audience",
    profile.audience,
    creatorAnalysisLimits.profileAudience,
  );
  requireWithin(
    "profile.goals",
    profile.goals,
    creatorAnalysisLimits.profileGoals,
  );
  requireWithin(
    "profile.voiceInstructions",
    profile.voiceInstructions,
    creatorAnalysisLimits.profileVoiceInstructions,
  );

  requireWithin("content.body", content.body, creatorAnalysisLimits.contentBody);
  if (content.title !== null) {
    requireWithin(
      "content.title",
      content.title,
      creatorAnalysisLimits.contentTitle,
    );
  }
  if (content.sourceUrl !== null) {
    requireWithin(
      "content.sourceUrl",
      content.sourceUrl,
      creatorAnalysisLimits.contentSourceUrl,
    );
  }

  if (feedback.length > creatorAnalysisLimits.feedbackItems) {
    throw new CreatorAnalysisRequestTooLargeError(
      "feedback",
      creatorAnalysisLimits.feedbackItems,
      feedback.length,
    );
  }

  for (const [index, item] of feedback.entries()) {
    requireWithin(
      `feedback[${index}].decisionReason`,
      item.decisionReason,
      creatorAnalysisLimits.feedbackDecisionReason,
    );
    requireWithin(
      `feedback[${index}].contentExcerpt`,
      item.contentExcerpt,
      creatorAnalysisLimits.feedbackContentExcerpt,
    );
    if (item.contentTitle !== null) {
      requireWithin(
        `feedback[${index}].contentTitle`,
        item.contentTitle,
        creatorAnalysisLimits.feedbackContentTitle,
      );
    }
    if (item.draftBody !== null) {
      requireWithin(
        `feedback[${index}].draftBody`,
        item.draftBody,
        creatorAnalysisLimits.feedbackDraftBody,
      );
    }
    if (item.editedBody !== null) {
      requireWithin(
        `feedback[${index}].editedBody`,
        item.editedBody,
        creatorAnalysisLimits.feedbackEditedBody,
      );
    }
    if (item.feedbackReason !== null) {
      requireWithin(
        `feedback[${index}].feedbackReason`,
        item.feedbackReason,
        creatorAnalysisLimits.feedbackReason,
      );
    }
  }
}

/**
 * The JSON Schema the model is held to.
 *
 * Every property is required and `additionalProperties` is false at both
 * levels, so there is no optional half-answer for a caller to interpret. The
 * three channel names come from `creatorTargetChannels`, which means adding a
 * channel is a change in one place rather than four.
 *
 * **This is a constraint on the model, not a guarantee to the application.** A
 * schema shapes what comes back; it cannot say a recommendation carries text
 * worth reading, or that a skip left the draft alone. `readCreatorAnalysis`
 * checks those, and must keep doing so even while this is in force.
 */
const channelDecisionSchema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: [...editorialVerdicts],
      description:
        "recommend when this material is worth posting on this channel, skip when it is not.",
    },
    reason: {
      type: "string",
      description:
        "One or two sentences saying why, addressed to the person whose material this is.",
    },
    draftBody: {
      type: ["string", "null"],
      description:
        "The post itself when recommending. Null when skipping — never an empty string.",
    },
  },
  required: ["verdict", "reason", "draftBody"],
  additionalProperties: false,
} as const;

export const creatorAnalysisSchema = {
  type: "object",
  properties: Object.fromEntries(
    creatorTargetChannels.map((channel) => [channel, channelDecisionSchema]),
  ),
  required: [...creatorTargetChannels],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

/**
 * Reads a verdict without insisting the model shout it.
 *
 * Case and surrounding space are the model's presentation; the value is what
 * matters, and normalising here is cheaper than a retry. **Anything that is not
 * one of the two after that is rejected** rather than guessed at — a third
 * verdict is not a formatting problem.
 */
function readVerdict(value: unknown, channel: string): EditorialVerdict {
  if (typeof value !== "string") {
    throw new InvalidCreatorAnalysisResponseError(
      `${channel} has no verdict`,
    );
  }

  const normalized = value.trim().toLowerCase();
  const verdict = editorialVerdicts.find((known) => known === normalized);

  if (verdict === undefined) {
    throw new InvalidCreatorAnalysisResponseError(
      `${channel} has a verdict this version does not know`,
    );
  }

  return verdict;
}

function readChannelDecision(
  value: unknown,
  channel: CreatorTargetChannel,
): CreatorChannelDecision {
  const draftLimit = creatorDraftLimits[channel];

  if (typeof value !== "object" || value === null) {
    throw new InvalidCreatorAnalysisResponseError(`${channel} is missing`);
  }

  const record = value as Record<string, unknown>;
  const verdict = readVerdict(record.verdict, channel);

  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new InvalidCreatorAnalysisResponseError(
      `${channel} gives no reason`,
    );
  }

  if (record.reason.length > creatorAnalysisLimits.resultReason) {
    throw new InvalidCreatorAnalysisResponseError(
      `${channel} gives a reason longer than ${creatorAnalysisLimits.resultReason} characters`,
    );
  }

  const draft = record.draftBody;

  // **The two halves of the contract that a schema cannot express.** A
  // recommendation with nothing to publish is a button that does nothing; a
  // skip carrying a draft is a post nobody decided to write.
  if (verdict === "recommend") {
    if (typeof draft !== "string" || draft.trim() === "") {
      throw new InvalidCreatorAnalysisResponseError(
        `${channel} recommends posting but wrote no draft`,
      );
    }

    // **A sanity limit, not a posting limit.** See `creatorDraftLimits`: this
    // catches a "concise standalone post" that arrived as an essay, and models
    // no platform's rules.
    if (draft.length > draftLimit) {
      throw new InvalidCreatorAnalysisResponseError(
        `${channel} wrote a draft longer than ${draftLimit} characters`,
      );
    }

    return { verdict, reason: record.reason, draftBody: draft };
  }

  if (draft !== null) {
    throw new InvalidCreatorAnalysisResponseError(
      `${channel} skips posting but still wrote a draft`,
    );
  }

  return { verdict, reason: record.reason, draftBody: null };
}

/**
 * Turns what the model returned into something the rest of the application may
 * act on, or refuses it.
 *
 * **`unknown` in, checked all the way down.** A schema is an instruction to a
 * model rather than a promise from one, and `JSON.parse` returns `any` however
 * carefully the request was written. Every field below is read as if none of
 * that had happened.
 */
export function readCreatorAnalysis(value: unknown): CreatorAnalysisResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCreatorAnalysisResponseError(
      "the answer was not an object",
    );
  }

  const record = value as Record<string, unknown>;

  return Object.fromEntries(
    creatorTargetChannels.map((channel) => [
      channel,
      readChannelDecision(record[channel], channel),
    ]),
  ) as CreatorAnalysisResult;
}
