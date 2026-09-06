import "server-only";

import type { CreatorMemoryRecord } from "@/lib/creator/memory";
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
 * The owner's stated preferences, as they wrote them.
 *
 * **The only place a profile is written from what somebody typed.** The row is
 * also created by `saveCreatorAnalysis`, but that one writes `update: {}` on
 * purpose — an analysis must never rewrite a stated preference. This is the
 * other direction: a person saying what they want, which is the one thing
 * allowed to change these three columns.
 *
 * **`userId` decides the row, and it is an argument.** No profile id is
 * accepted from anywhere; `where: { userId }` is the whole of the addressing,
 * so there is no shape of call that reaches somebody else's preferences.
 *
 * **Empty strings are a saved preference, not a missing one.** Clearing all
 * three is somebody withdrawing what they had stated, and the row stays —
 * nothing here deletes.
 */
export async function saveCreatorProfile(
  userId: string,
  profile: CreatorAnalysisProfile,
  client: DbClient = prisma,
): Promise<void> {
  const { audience, goals, voiceInstructions } = profile;

  await client.creatorProfile.upsert({
    where: { userId },
    create: { userId, audience, goals, voiceInstructions },
    update: { audience, goals, voiceInstructions },
    select: { id: true },
  });
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

/**
 * One analysis's view of the history, split at a boundary that cannot move.
 *
 * **The partition is the whole safety argument.** Recent raw answers and the
 * answers a summary stands for must never be the same answers, or one person's
 * opinion gets counted twice — once in full and once in prose — and the model
 * has no way to tell. Both sides here are defined against a single boundary
 * taken from one read, so an answer recorded while the analysis is running is
 * newer than the boundary and belongs to neither side of *this* analysis. It is
 * picked up by the next one.
 *
 * `olderBoundary` is null when nothing has aged out: there are twelve or fewer
 * answers, every one of them is in `recent`, and there is no older side at all.
 */
export type CreatorFeedbackPartition = {
  /** The newest answers, oldest first — exactly what the analyzer receives. */
  recent: CreatorFeedbackContext[];
  /**
   * The newest answer on the older side, as a cursor.
   *
   * Not a count and not an id alone: `createdAt` with `id` breaking ties is the
   * ordering the whole history is read in, and a boundary expressed any other
   * way would drift when two answers share a millisecond.
   */
  olderBoundary: { createdAt: Date; id: string } | null;
};

/** Every answer at or before the boundary — the older side, as a filter. */
function olderThanBoundary(
  userId: string,
  boundary: { createdAt: Date; id: string },
) {
  return {
    userId,
    editorialDecision: { userId, contentItem: { userId } },
    OR: [
      { createdAt: { lt: boundary.createdAt } },
      { createdAt: boundary.createdAt, id: { lte: boundary.id } },
    ],
  };
}

/**
 * The recent answers and the boundary behind them, from one read.
 *
 * **Thirteen rows, not twelve.** The extra one is not shown to anybody; it is
 * how the older side gets a first member to be defined against. Reading it in
 * the same query as the twelve is what makes the split atomic — two separate
 * reads could see different histories and put the same answer on both sides.
 */
export async function readCreatorFeedbackPartition(
  userId: string,
  client: DbClient = prisma,
): Promise<CreatorFeedbackPartition> {
  const rows = await client.creatorFeedback.findMany({
    where: {
      userId,
      editorialDecision: { userId, contentItem: { userId } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_LIMIT + 1,
    select: {
      id: true,
      createdAt: true,
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

  const recent = rows.slice(0, HISTORY_LIMIT);
  const boundaryRow = rows[HISTORY_LIMIT];

  return {
    // Newest first out of the database, oldest first into the analyzer.
    recent: recent.reverse().map((row) => toFeedbackContext(row, userId)),
    olderBoundary:
      boundaryRow === undefined
        ? null
        : { createdAt: boundaryRow.createdAt, id: boundaryRow.id },
  };
}

/** One answer on the older side, with the identity a membership row needs. */
export type CreatorFeedbackCandidate = {
  /**
   * The row a membership would be recorded against.
   *
   * **Identity, not position.** What a summary covers is recorded per answer;
   * an offset into an ordering would say "the oldest N", which is only the same
   * set for as long as the oldest N do not change, and nothing makes that true.
   */
  feedbackId: string;
  context: CreatorFeedbackContext;
};

/**
 * Older answers no summary has been shown yet, oldest first.
 *
 * **Membership, not an offset.** A row is a candidate when it sits on the older
 * side of this analysis's boundary and no `CreatorMemoryEvidence` points at it.
 * The previous version skipped as many rows as the summary claimed to stand
 * for, which assumed the ordering it skipped through was stable: `createdAt`
 * has millisecond resolution and `id` is a client-generated cuid, so a row can
 * become visible after another and still sort before it, and the offset then
 * pointed past an answer nobody had summarised — lost from the summary and from
 * the recent twelve at once. Asking for the rows with no membership cannot land
 * in the wrong place. An answer is either recorded as incorporated or it is not.
 *
 * `take` is one batch and no more — catching up on a long history is something
 * later analyses do, not something one of them pays for.
 */
export async function readUnsummarizedOlderFeedback(
  userId: string,
  boundary: { createdAt: Date; id: string },
  take: number,
  client: DbClient = prisma,
): Promise<CreatorFeedbackCandidate[]> {
  const rows = await client.creatorFeedback.findMany({
    where: {
      ...olderThanBoundary(userId, boundary),
      memoryEvidence: { is: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
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

  return rows.map((row) => ({
    feedbackId: row.id,
    context: toFeedbackContext(row, userId),
  }));
}

/**
 * A stored summary, with what it is supposed to stand for.
 *
 * `evidenceCount` is how many answers are actually recorded against it, which
 * `derivedFromCount` claims to equal. They are read together so a caller can
 * check rather than assume: the count is the displayed and locking value, and
 * the memberships are what it is a count of.
 */
export type StoredCreatorMemory = CreatorMemoryRecord & {
  id: string;
};

/**
 * The stored summary for this account, or null.
 *
 * **Scoped by the owner at both levels.** `CreatorMemory` carries a `userId` of
 * its own and hangs off a `CreatorProfile` that carries another; a row whose
 * two disagree describes something that cannot have happened, and reading it
 * would mean deciding which of the two to believe. There is no answer to that,
 * so the query requires both to be this account and a row that does not satisfy
 * it simply is not found.
 */
export async function readCreatorMemory(
  userId: string,
  client: DbClient = prisma,
): Promise<StoredCreatorMemory | null> {
  const row = await client.creatorMemory.findFirst({
    where: { userId, creatorProfile: { userId } },
    select: {
      id: true,
      summary: true,
      derivedFromCount: true,
      _count: { select: { evidence: true } },
    },
  });

  if (row === null) {
    return null;
  }

  return {
    id: row.id,
    summary: row.summary,
    derivedFromCount: row.derivedFromCount,
    evidenceCount: row._count.evidence,
  };
}

/**
 * Records a synthesis: the summary, the count, and which answers it covers.
 *
 * **The three are one write or none of them.** A summary stored without its
 * memberships would be re-derived from the same answers forever; memberships
 * stored without the summary would hide answers from every later synthesis with
 * nothing standing for them. Either half alone is worse than neither, so they
 * go in a single short transaction — opened *after* the provider has answered,
 * never around it.
 *
 * **`derivedFromCount` is still the version.** Two analyses that both read a
 * summary standing for five answers will both try to extend it; whichever
 * writes first has produced a summary the other has not seen, and overwriting
 * it would throw away a synthesis. The conditional update is the same shape
 * `claimRoutineSlot` and the execution lease use — the winner is whoever the
 * database says it is.
 *
 * **The unique index on `creatorFeedbackId` is the second lock.** Two analyses
 * that agree on the memory row but not on the batch collide there, and the
 * loser rolls the whole thing back rather than incorporating an answer twice.
 *
 * Returns whether this caller was the one that wrote.
 */
export async function saveCreatorMemory(
  {
    userId,
    memoryId,
    summary,
    expectedCount,
    feedbackIds,
  }: {
    userId: string;
    /** The row to extend, or null when this account has no summary yet. */
    memoryId: string | null;
    summary: string;
    expectedCount: number;
    feedbackIds: string[];
  },
  client: DbClient = prisma,
): Promise<boolean> {
  if (feedbackIds.length === 0) {
    // Nothing was summarised, so there is nothing to record. Storing a summary
    // here would move a count past evidence no membership names.
    return false;
  }

  const newCount = expectedCount + feedbackIds.length;

  const run = async (tx: DbClient): Promise<boolean> => {
    const creatorMemoryId = await claimCreatorMemoryRow(
      { userId, memoryId, summary, expectedCount, newCount },
      tx,
    );

    if (creatorMemoryId === null) {
      return false;
    }

    await tx.creatorMemoryEvidence.createMany({
      data: feedbackIds.map((creatorFeedbackId) => ({
        userId,
        creatorMemoryId,
        creatorFeedbackId,
      })),
    });

    return true;
  };

  try {
    // A `false` from `run` has written nothing, so there is nothing to undo;
    // what has to roll back is a collision on the memberships, and that throws.
    return client === prisma ? await prisma.$transaction(run) : await run(client);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Somebody else incorporated one of these answers, or created the first
      // summary. Their write stands and this whole transaction is undone.
      return false;
    }

    throw error;
  }
}

/** The memory row this synthesis may write to, or null if it lost the race. */
async function claimCreatorMemoryRow(
  {
    userId,
    memoryId,
    summary,
    expectedCount,
    newCount,
  }: {
    userId: string;
    memoryId: string | null;
    summary: string;
    expectedCount: number;
    newCount: number;
  },
  tx: DbClient,
): Promise<string | null> {
  if (memoryId === null) {
    const profile = await tx.creatorProfile.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (profile === null) {
      // No profile means no analysis has ever been stored, which means there is
      // no older side to summarise. Nothing to write, and nothing wrong.
      return null;
    }

    const created = await tx.creatorMemory.create({
      data: {
        userId,
        creatorProfileId: profile.id,
        summary,
        derivedFromCount: newCount,
      },
      select: { id: true },
    });

    return created.id;
  }

  const { count } = await tx.creatorMemory.updateMany({
    where: {
      id: memoryId,
      userId,
      creatorProfile: { userId },
      derivedFromCount: expectedCount,
    },
    data: { summary, derivedFromCount: newCount },
  });

  return count === 1 ? memoryId : null;
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
} & CreatorPersistedSource;

/**
 * Where the material came from, as a pair that cannot be half-set.
 *
 * **A union rather than two independent fields.** `sourceKind: "url"` with no
 * address, or `"text"` carrying one, are both rows that describe something that
 * did not happen — and a screen or a later analysis reading either would be
 * reading a fiction. Written this way, neither compiles.
 *
 * **Not the client's to state.** Which of the two this is follows from which
 * service function ran, and those are chosen by the server action, so a form
 * has no field that could claim provenance.
 */
export type CreatorPersistedSource =
  | { sourceKind: "text"; sourceUrl: null }
  | { sourceKind: "url"; sourceUrl: string };

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
  { userId, title, body, result, sourceKind, sourceUrl }: CreatorAnalysisPersistence,
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
        sourceKind,
        sourceUrl,
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
