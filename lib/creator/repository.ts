import "server-only";

import {
  type CreatorAnalysisProfile,
  type CreatorAnalysisResult,
  creatorAnalysisLimits,
  type CreatorFeedbackContext,
} from "@/lib/creator/analyzer";
import { type DbClient, prisma } from "@/lib/prisma";
import {
  type CreatorFeedbackAction,
  type CreatorTargetChannel,
  creatorTargetChannels,
  isCreatorFeedbackAction,
  isCreatorTargetChannel,
  isEditorialVerdict,
} from "@/types";

/**
 * Where the Creator loop meets the database.
 *
 * **Two things happen here and nowhere else**: rows become the values
 * `lib/creator/analyzer.ts` describes, and a finished analysis becomes rows.
 * The analyzer stays ignorant of Prisma, so every narrowing, every ownership
 * check and every piece of shaping a stored row needs before a model may be
 * told about it lives on this side of the line.
 *
 * **`userId` is always an argument, never a column that was read.** Reading an
 * owner out of a row and then querying by it would make a row able to nominate
 * whose data it belongs to. The id handed in comes from the session; every
 * query below is scoped by it, at every level.
 */

/** Prisma's code for a unique constraint that would have been broken. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * A stored history that cannot be turned into evidence.
 *
 * **Raised instead of skipping the row.** A history is a sequence of things
 * that happened, and quietly dropping the entries that do not parse hands the
 * model a different history than the one on record — one that is missing
 * exactly the rows something already went wrong with. Stopping is the safe
 * answer, because nothing here is urgent enough to be worth guessing about.
 *
 * **Nothing private goes in the message.** A row id and a technical reason are
 * enough to find the problem; the text of somebody's unpublished draft is not
 * a diagnostic.
 */
export class InvalidCreatorFeedbackHistoryError extends Error {
  /** The decision the unusable entry belongs to. */
  readonly decisionId: string;

  constructor(decisionId: string, reason: string) {
    super(`Stored feedback history cannot be read (${reason})`);
    this.name = "InvalidCreatorFeedbackHistoryError";
    this.decisionId = decisionId;
  }
}

export function isInvalidCreatorFeedbackHistory(error: unknown): boolean {
  return error instanceof InvalidCreatorFeedbackHistoryError;
}

/** The decision named does not exist, or belongs to somebody else. */
export class CreatorDecisionNotFoundError extends Error {
  constructor() {
    super("No such decision.");
    this.name = "CreatorDecisionNotFoundError";
  }
}

export function isCreatorDecisionNotFound(error: unknown): boolean {
  return error instanceof CreatorDecisionNotFoundError;
}

/** Somebody already answered this decision, and answers are not rewritten. */
export class CreatorFeedbackAlreadyRecordedError extends Error {
  constructor() {
    super("This decision already has feedback.");
    this.name = "CreatorFeedbackAlreadyRecordedError";
  }
}

export function isCreatorFeedbackAlreadyRecorded(error: unknown): boolean {
  return error instanceof CreatorFeedbackAlreadyRecordedError;
}

/** What an account is assumed to prefer before it has said anything. */
export const EMPTY_CREATOR_PROFILE: CreatorAnalysisProfile = {
  audience: "",
  goals: "",
  voiceInstructions: "",
};

/**
 * The owner's stated preferences, or empty ones.
 *
 * **A missing profile is not a reason to refuse.** Somebody analysing their
 * first piece has never opened a settings screen, and the analyzer copes with
 * empty strings perfectly well — it simply has less to go on.
 *
 * **Reading does not create the row.** A profile written here would outlive an
 * analysis that then failed at the model, leaving an account holding a row it
 * never asked for. The row is created inside the transaction that saves a
 * successful analysis, and only there.
 */
export async function readCreatorProfile(
  userId: string,
  client: DbClient = prisma,
): Promise<CreatorAnalysisProfile> {
  const profile = await client.creatorProfile.findUnique({
    where: { userId },
    select: { audience: true, goals: true, voiceInstructions: true },
  });

  return profile ?? EMPTY_CREATOR_PROFILE;
}

/**
 * Shortens a stored value for use as historical context, deterministically.
 *
 * **This is not the truncation the analyzer refuses to do.** That rule is about
 * the piece being judged now, where cutting would change what the model was
 * asked about. This is a past item being *quoted* to explain an earlier
 * decision, and quoting a paragraph of it is the point.
 *
 * The same text always yields the same excerpt: a prefix, an ellipsis when
 * something was left off, and never longer than the limit.
 *
 * **`limit` counts UTF-16 code units — `String.length` — because that is what
 * `creatorAnalysisLimits` counts.** The two metrics are not the same: an emoji
 * is one code point and two units, so a budget spent per code point would let
 * `"😀".repeat(1_500)` through here at 1,500 and have it rejected at 3,000 by
 * `assertCreatorAnalysisRequestWithinLimits`. An excerpt this layer built would
 * then be the thing that failed the request.
 *
 * **Iterating by code point while spending by unit** is what gives both
 * properties at once: the budget below matches the limit that will be checked,
 * and a cut never lands between the halves of a surrogate pair and leaves a
 * lone surrogate behind.
 */
export function excerptForHistory(text: string, limit: number): string {
  const trimmed = text.trim();

  if (trimmed.length <= limit) {
    return trimmed;
  }

  const ellipsis = "…";
  const budget = limit - ellipsis.length;
  const kept: string[] = [];
  // Code units used so far, not code points kept — see above.
  let length = 0;

  for (const point of Array.from(trimmed)) {
    if (length + point.length > budget) {
      break;
    }

    kept.push(point);
    length += point.length;
  }

  return `${kept.join("").trimEnd()}${ellipsis}`;
}

/** How many past decisions are shown, and in which direction they are read. */
const HISTORY_LIMIT = creatorAnalysisLimits.feedbackItems;

/**
 * The account's most recent answered decisions, oldest first.
 *
 * **The ordering is the whole subtlety.** What is wanted is the *latest* twelve
 * arranged *oldest first*, and asking the database for that directly is not
 * possible — `ORDER BY createdAt ASC` with a limit returns the twelve oldest
 * rows in the table, which on an established account is the opposite set. So
 * the read is descending and the list is reversed afterwards. `id` breaks ties
 * in the same direction, because two rows written in the same millisecond would
 * otherwise come back in whatever order the planner felt like and the "latest
 * twelve" would quietly differ between two identical requests.
 *
 * **Every level is scoped by the owner, not just the feedback row.** The
 * denormalised `userId` columns are an application invariant rather than a
 * database one: no composite foreign key makes a decision's owner match its
 * content's. So the filter names the owner on the feedback, on the decision,
 * and on the content behind it, and the draft is read through the decision that
 * has already been scoped. One row belonging to somebody else reaching this
 * payload would put another account's unpublished writing in front of a model.
 */
export async function readRecentFeedbackContext(
  userId: string,
  client: DbClient = prisma,
): Promise<CreatorFeedbackContext[]> {
  const rows = await client.creatorFeedback.findMany({
    where: {
      userId,
      editorialDecision: {
        userId,
        contentItem: { userId },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT,
    select: {
      id: true,
      action: true,
      editedBody: true,
      reason: true,
      editorialDecision: {
        select: {
          id: true,
          targetChannel: true,
          verdict: true,
          reason: true,
          userId: true,
          draft: { select: { body: true, userId: true } },
          contentItem: { select: { title: true, body: true, userId: true } },
        },
      },
    },
  });

  // Newest first out of the database, oldest first into the analyzer.
  return rows.reverse().map((row) => toFeedbackContext(row, userId));
}

type FeedbackRow = {
  id: string;
  action: string;
  editedBody: string | null;
  reason: string | null;
  editorialDecision: {
    id: string;
    targetChannel: string;
    verdict: string;
    reason: string;
    userId: string;
    draft: { body: string; userId: string } | null;
    contentItem: { title: string | null; body: string; userId: string };
  };
};

/**
 * Turns one stored answer into evidence, or refuses to.
 *
 * **Stored strings are narrowed, never coerced.** A `targetChannel` this
 * version does not recognise is not turned into `x`: that would invent a fact
 * about what somebody once decided, and the invented fact would then be learned
 * from. The same goes for a verdict and an action.
 *
 * **The combinations a schema cannot express are checked here.** A `recommend`
 * without a draft, a `skip` carrying one, an `edit` with nothing edited — each
 * describes something that cannot have happened, so the history holding it is
 * not a record of anything and analysis stops.
 */
function toFeedbackContext(row: FeedbackRow, userId: string): CreatorFeedbackContext {
  const decision = row.editorialDecision;
  const refuse = (reason: string): never => {
    throw new InvalidCreatorFeedbackHistoryError(decision.id, reason);
  };

  // **Belt as well as braces.** The query above already scopes every level by
  // the owner; this catches a future edit that loosens it, where the cost of
  // being wrong is another account's writing in a prompt.
  if (
    decision.userId !== userId ||
    decision.contentItem.userId !== userId ||
    (decision.draft !== null && decision.draft.userId !== userId)
  ) {
    refuse("owner-mismatch");
  }

  if (!isCreatorTargetChannel(decision.targetChannel)) {
    refuse("unknown-channel");
  }

  if (!isEditorialVerdict(decision.verdict)) {
    refuse("unknown-verdict");
  }

  if (!isCreatorFeedbackAction(row.action)) {
    refuse("unknown-action");
  }

  const targetChannel = decision.targetChannel as CreatorTargetChannel;
  const verdict = decision.verdict as "recommend" | "skip";
  const action = row.action as CreatorFeedbackAction;

  if (decision.reason.trim() === "") {
    refuse("empty-decision-reason");
  }

  if (verdict === "recommend" && decision.draft === null) {
    refuse("recommend-without-draft");
  }

  if (verdict === "skip" && decision.draft !== null) {
    refuse("skip-with-draft");
  }

  if (action === "edit") {
    if (verdict !== "recommend") {
      refuse("edit-of-skip");
    }

    if (decision.draft === null) {
      refuse("edit-without-draft");
    }

    if (row.editedBody === null || row.editedBody.trim() === "") {
      refuse("edit-without-edited-body");
    }
  } else if (row.editedBody !== null) {
    // An approval carrying edited text is a contradiction: somebody either
    // agreed with the draft or wrote a different one. Reading it either way
    // would be this layer deciding what they meant.
    refuse("edited-body-without-edit");
  }

  return {
    targetChannel,
    verdict,
    decisionReason: decision.reason,
    draftBody: decision.draft?.body ?? null,
    action,
    editedBody: row.editedBody,
    feedbackReason: normalizeOptionalText(row.reason),
    contentTitle:
      decision.contentItem.title === null
        ? null
        : excerptForHistory(
            decision.contentItem.title,
            creatorAnalysisLimits.feedbackContentTitle,
          ),
    contentExcerpt: excerptForHistory(
      decision.contentItem.body,
      creatorAnalysisLimits.feedbackContentExcerpt,
    ),
  };
}

/** Whitespace-only is nothing said, which is what null already means. */
export function normalizeOptionalText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export type CreatorAnalysisPersistence = {
  userId: string;
  title: string | null;
  body: string;
  result: CreatorAnalysisResult;
};

/**
 * Everything a finished analysis produces, written or not at all.
 *
 * **One transaction, and the model is nowhere near it.** The call that takes up
 * to a minute has already returned by the time this begins; holding a database
 * connection open across it would tie up a connection per analysis for the
 * length of somebody else's API latency.
 *
 * **A profile is created here rather than at read time, and never updated.**
 * The row has to exist for `ContentItem` to point at it, so an account's first
 * analysis makes an empty one. What it must not do is write over a profile
 * somebody filled in: this code path is judging a piece of writing, and an
 * analysis quietly rewriting stated preferences would be the one thing the
 * separation of explicit preference from derived memory exists to prevent.
 *
 * **Three decisions always, drafts only where recommended.** A skip with a
 * draft is a post nobody decided to write.
 */
export async function saveCreatorAnalysis(
  { userId, title, body, result }: CreatorAnalysisPersistence,
  client: DbClient = prisma,
): Promise<{ contentItemId: string }> {
  const run = async (tx: DbClient) => {
    const profile = await tx.creatorProfile.upsert({
      where: { userId },
      // Empty rather than absent: the account has stated nothing yet, and
      // `{}` on an existing row is what keeps a stated preference stated.
      create: { userId, ...EMPTY_CREATOR_PROFILE },
      update: {},
      select: { id: true },
    });

    const contentItem = await tx.contentItem.create({
      data: {
        userId,
        creatorProfileId: profile.id,
        sourceKind: "text",
        sourceUrl: null,
        title,
        body,
      },
      select: { id: true },
    });

    for (const channel of creatorTargetChannels) {
      const decision = result[channel];

      const saved = await tx.editorialDecision.create({
        data: {
          userId,
          contentItemId: contentItem.id,
          targetChannel: channel,
          verdict: decision.verdict,
          reason: decision.reason,
        },
        select: { id: true },
      });

      if (decision.verdict === "recommend" && decision.draftBody !== null) {
        await tx.contentDraft.create({
          data: {
            userId,
            editorialDecisionId: saved.id,
            body: decision.draftBody,
          },
        });
      }
    }

    return { contentItemId: contentItem.id };
  };

  return client === prisma ? prisma.$transaction(run) : run(client);
}

/** One decision, as much of it as recording an answer needs to know. */
export type DecisionForFeedback = {
  id: string;
  verdict: "recommend" | "skip";
  hasDraft: boolean;
};

/**
 * The decision somebody is answering, if it is theirs.
 *
 * **Scoped by owner in the same query that finds it**, so a decision belonging
 * to another account is indistinguishable from one that does not exist. Telling
 * the two apart would confirm the existence of somebody else's work to anybody
 * willing to guess ids.
 */
export async function readDecisionForFeedback(
  userId: string,
  decisionId: string,
  client: DbClient = prisma,
): Promise<DecisionForFeedback | null> {
  const decision = await client.editorialDecision.findFirst({
    where: { id: decisionId, userId, contentItem: { userId } },
    select: {
      id: true,
      verdict: true,
      draft: { select: { id: true, userId: true } },
    },
  });

  if (decision === null || !isEditorialVerdict(decision.verdict)) {
    return null;
  }

  return {
    id: decision.id,
    verdict: decision.verdict,
    hasDraft: decision.draft !== null && decision.draft.userId === userId,
  };
}

export type CreatorFeedbackWrite = {
  userId: string;
  editorialDecisionId: string;
  action: CreatorFeedbackAction;
  editedBody: string | null;
  reason: string | null;
};

/**
 * Records what somebody did about a decision. Once.
 *
 * **A single insert, so no transaction.** There is one row to write and the
 * database's own unique constraint is what makes it the only one — wrapping
 * that in a transaction would add a boundary with nothing inside it to protect.
 *
 * **A second answer is refused, not merged.** `CreatorFeedback` is append-only:
 * a row here says what happened at a moment, and a moment does not later become
 * a different moment. Two requests racing for the same decision both try the
 * insert and the constraint decides; the loser gets a named error rather than
 * Prisma's, so nothing above has to know what `P2002` means.
 *
 * **`ContentDraft.body` is never touched.** An edit is stored as `editedBody`
 * beside the original, because the pair is the signal.
 */
export async function createCreatorFeedback(
  { userId, editorialDecisionId, action, editedBody, reason }: CreatorFeedbackWrite,
  client: DbClient = prisma,
): Promise<{ id: string }> {
  try {
    return await client.creatorFeedback.create({
      data: { userId, editorialDecisionId, action, editedBody, reason },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CreatorFeedbackAlreadyRecordedError();
    }

    throw error;
  }
}
