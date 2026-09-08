import "server-only";

import { creatorAnalysisLimits } from "@/lib/creator/analyzer";
import { excerptForHistory } from "@/lib/creator/repository";
import { type DbClient, prisma } from "@/lib/prisma";
import {
  type CreatorFeedbackAction,
  type CreatorTargetChannel,
  creatorTargetChannels,
  type EditorialVerdict,
  isCreatorFeedbackAction,
  isCreatorSourceKind,
  isCreatorTargetChannel,
  isEditorialVerdict,
} from "@/types";

/**
 * What is still waiting for somebody to answer.
 *
 * **A read model, and only that.** It turns rows into the smallest shape a
 * screen needs and does nothing else: no writes, no model, no session. The
 * owner arrives as an argument, exactly as it does in
 * `lib/creator/repository.ts`, because a row must never be able to nominate
 * whose data it belongs to.
 *
 * **Separate from the repository on purpose.** That file exists so the analyzer
 * can be given evidence and so a finished analysis can be stored; this one
 * exists so a person can look at what came back. The two read the same tables
 * and want different things from them, and merging them would mean a change
 * made for a screen reaching the prompt.
 */

/**
 * How many pieces the inbox shows at once.
 *
 * **A presentation bound, not an allowance.** Nothing is refused because of it
 * and nothing is counted against an account — it is what stops one screen from
 * loading a year of work, and the number to change when a list gets a
 * "show more". `creatorAnalysisLimits` is about what may be sent to a model and
 * has nothing to say here.
 */
export const CREATOR_REVIEW_ITEM_LIMIT = 10;

/** One channel's judgement, as much of it as a reviewer needs to see. */
export type CreatorReviewDecision = {
  id: string;
  targetChannel: CreatorTargetChannel;
  verdict: EditorialVerdict;
  reason: string;
  /**
   * The post itself when this recommends one, and null when it does not.
   *
   * **Named for what the reader sees, not for the column.** `ContentDraft` and
   * `draftBody` stay as they are in the schema; "draft" already means a
   * proposal for a worker's settings elsewhere in Koqentra, and a screen that
   * used the word for two things would make every sentence about either of them
   * ambiguous.
   */
  postText: string | null;
};

/** One piece of material, with whichever of its judgements are unanswered. */
export type CreatorReviewItem = {
  contentItemId: string;
  title: string | null;
  /**
   * Enough of the material to recognise it by.
   *
   * **The whole body never leaves the server.** A reviewer needs to know which
   * piece a judgement is about; sending the article itself to a browser to
   * achieve that would put every stored word into a page's payload for no gain.
   */
  sourceExcerpt: string;
  /**
   * When the analysis that produced these judgements was stored.
   *
   * **`ContentItem.createdAt`, because that row is the analysis.** It is
   * written once, inside the transaction that saves a successful analysis, so
   * it dates the judgements rather than any later edit. Two submissions of the
   * same piece are otherwise two identical headings, which is exactly the
   * confusion this answers.
   */
  analyzedAt: Date;
  /** Where the material came from — an address, when there was one. */
  source: CreatorReviewSource;
  decisions: CreatorReviewDecision[];
};

/**
 * A stored row that cannot be shown as it stands.
 *
 * **Raised rather than repaired.** A decision this version cannot read is not
 * turned into a plausible one — a guessed channel or an invented verdict would
 * be a claim about what Koqentra once decided, put in front of the person whose
 * work it was about. Nothing here is urgent enough to be worth guessing.
 *
 * **The message carries an id and a reason, never any of the writing.**
 */
export class InvalidCreatorReviewDataError extends Error {
  /** The decision the unusable row belongs to. */
  readonly decisionId: string;

  constructor(decisionId: string, reason: string) {
    super(`Stored review data cannot be read (${reason})`);
    this.name = "InvalidCreatorReviewDataError";
    this.decisionId = decisionId;
  }
}

export function isInvalidCreatorReviewData(error: unknown): boolean {
  return error instanceof InvalidCreatorReviewDataError;
}

/**
 * Where an analysis got its material, as a pair that cannot be half-set.
 *
 * **The address is on the analysis, not on a judgement.** Three decisions come
 * out of one page, so putting the URL on each of them would say the same thing
 * three times and invite somebody to wonder whether they could differ.
 */
export type CreatorReviewSource =
  | { kind: "text" }
  | { kind: "url"; url: string };

/**
 * Reads the stored pair, or refuses.
 *
 * **Two columns that only mean something together.** `"url"` with no address
 * cannot be linked to, and `"text"` carrying one describes a fetch that never
 * happened — both are rows this version cannot show honestly, and a screen
 * guessing at either would be making a claim about where somebody's work came
 * from. Falling back to `"text"` would be the worst of the options: it reads as
 * ordinary and hides the contradiction.
 */
function toReviewSource(
  contentItemId: string,
  sourceKind: string,
  sourceUrl: string | null,
): CreatorReviewSource {
  const refuse = (reason: string): never => {
    throw new InvalidCreatorReviewDataError(contentItemId, reason);
  };

  if (!isCreatorSourceKind(sourceKind)) {
    refuse("unknown-source-kind");
  }

  if (sourceKind === "text") {
    if (sourceUrl !== null) {
      refuse("text-source-with-url");
    }

    return { kind: "text" };
  }

  if (sourceUrl === null || sourceUrl.trim() === "") {
    refuse("url-source-without-url");
  }

  // **Not re-parsed and never re-fetched.** This address came back from the
  // Safe Fetch that actually read the page, so it was validated at the one
  // moment validation meant anything. Checking it again here would be checking
  // it against a network state nobody is looking at.
  return { kind: "url", url: sourceUrl as string };
}

/**
 * Where a channel sits in the list.
 *
 * Read from `creatorTargetChannels` so the order is the one the rest of the
 * application already agrees on, and so adding a channel is a change in one
 * place. **Not the database's order** — that is whatever the rows came back in.
 */
function channelPosition(channel: CreatorTargetChannel): number {
  return creatorTargetChannels.indexOf(channel);
}

type DecisionRow = {
  id: string;
  targetChannel: string;
  verdict: string;
  reason: string;
  userId: string;
  draft: { body: string; userId: string } | null;
  feedback: { id: string } | null;
};

type ItemRow = {
  id: string;
  title: string | null;
  body: string;
  createdAt: Date;
  sourceKind: string;
  sourceUrl: string | null;
  userId: string;
  decisions: DecisionRow[];
};

/**
 * Turns one stored judgement into something a screen may show, or refuses.
 *
 * The checks are the same ones `toFeedbackContext` makes for the model's
 * benefit, for the same reason: a `recommend` with nothing to publish and a
 * `skip` carrying a post are both descriptions of something that cannot have
 * happened, and a screen showing either would be showing a fiction.
 */
function toReviewDecision(
  row: DecisionRow,
  userId: string,
): CreatorReviewDecision {
  const refuse = (reason: string): never => {
    throw new InvalidCreatorReviewDataError(row.id, reason);
  };

  // **Belt as well as braces.** The query already scopes every level by the
  // owner; this catches a future edit that loosens it, where being wrong means
  // another account's unpublished writing on somebody's screen.
  if (row.userId !== userId) {
    refuse("owner-mismatch");
  }

  if (row.draft !== null && row.draft.userId !== userId) {
    refuse("draft-owner-mismatch");
  }

  // The query asks only for unanswered decisions. One arriving with an answer
  // means the filter no longer means what it says, and showing it would invite
  // a second answer to something already decided.
  if (row.feedback !== null) {
    refuse("already-answered");
  }

  if (!isCreatorTargetChannel(row.targetChannel)) {
    refuse("unknown-channel");
  }

  if (!isEditorialVerdict(row.verdict)) {
    refuse("unknown-verdict");
  }

  const targetChannel = row.targetChannel as CreatorTargetChannel;
  const verdict = row.verdict as EditorialVerdict;

  if (row.reason.trim() === "") {
    refuse("empty-reason");
  }

  if (verdict === "recommend" && row.draft === null) {
    refuse("recommend-without-post-text");
  }

  if (verdict === "skip" && row.draft !== null) {
    refuse("skip-with-post-text");
  }

  return {
    id: row.id,
    targetChannel,
    verdict,
    reason: row.reason,
    postText: row.draft?.body ?? null,
  };
}

/**
 * The pieces this account has not finished reviewing, newest first.
 *
 * **"Pending" means no feedback exists**, which is what makes the inbox empty
 * itself as somebody works through it: answering a decision removes it, and a
 * piece whose three decisions have all been answered stops appearing at all.
 * There is no history screen yet, so nothing here has to serve one.
 *
 * **Ordered and bounded deterministically.** `createdAt` descending with `id`
 * breaking ties, so two pieces stored in the same millisecond do not swap
 * places between one load and the next; `take` keeps a long-running account
 * from loading everything it has ever written into one page.
 *
 * **Every level is scoped by the owner** — the item, its decisions, and the
 * post text behind them. The denormalised `userId` columns are an application
 * invariant rather than a database one, so each is named rather than inferred
 * from its parent.
 */
export async function listCreatorReviewItems(
  userId: string,
  client: DbClient = prisma,
): Promise<CreatorReviewItem[]> {
  const rows = (await client.contentItem.findMany({
    where: {
      userId,
      decisions: { some: { userId, feedback: { is: null } } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CREATOR_REVIEW_ITEM_LIMIT,
    select: {
      id: true,
      title: true,
      body: true,
      createdAt: true,
      sourceKind: true,
      sourceUrl: true,
      userId: true,
      decisions: {
        where: { userId, feedback: { is: null } },
        select: {
          id: true,
          targetChannel: true,
          verdict: true,
          reason: true,
          userId: true,
          draft: { select: { body: true, userId: true } },
          feedback: { select: { id: true } },
        },
      },
    },
  })) as ItemRow[];

  return rows.map((row) => {
    if (row.userId !== userId) {
      throw new InvalidCreatorReviewDataError(row.id, "item-owner-mismatch");
    }

    const decisions = row.decisions
      .map((decision) => toReviewDecision(decision, userId))
      // X, then Reddit, then long-form — the order the product speaks in,
      // rather than whatever the rows arrived in.
      .sort((a, b) => channelPosition(a.targetChannel) - channelPosition(b.targetChannel));

    return {
      contentItemId: row.id,
      // **Bounded for the same reason the excerpt is.** A title is stored at up
      // to the length a request may carry, which is longer than a heading
      // should ever be on a phone.
      title:
        row.title === null
          ? null
          : excerptForHistory(row.title, creatorAnalysisLimits.feedbackContentTitle),
      // **The same helper the history uses, for a different audience.** It is
      // deterministic, bounded, and cuts on a character rather than between the
      // halves of one — all of which a preview wants as much as a prompt does.
      sourceExcerpt: excerptForHistory(
        row.body,
        creatorAnalysisLimits.feedbackContentExcerpt,
      ),
      analyzedAt: row.createdAt,
      source: toReviewSource(row.id, row.sourceKind, row.sourceUrl),
      decisions,
    };
  });
}

/**
 * How many answered analyses the history shows at once.
 *
 * **A presentation bound, exactly like `CREATOR_REVIEW_ITEM_LIMIT`.** Nothing
 * is deleted, nothing expires, and no account is refused anything because of
 * it — it is what stops one screen from loading a year of work, and the number
 * a "show more" would move. Larger than the inbox because the inbox is a queue
 * somebody is working through, and this is a record they are looking back at.
 */
export const CREATOR_HISTORY_ITEM_LIMIT = 20;

/** One judgement that has been answered, and what the answer was. */
export type CreatorHistoryDecision = {
  id: string;
  targetChannel: CreatorTargetChannel;
  verdict: EditorialVerdict;
  reason: string;
  /** What Koqentra proposed, when it proposed anything. */
  postText: string | null;
  /**
   * The stored answer.
   *
   * **Not a label.** `approve` means "post this" against a recommendation and
   * "yes, leave it" against a skip, so the pair is what a screen reads — the
   * same mapping the learning panel uses. In particular it does **not** mean
   * the post was copied: answers recorded before the clipboard handoff existed
   * are `approve` too, and a history that called them "copied and used" would
   * be inventing an event.
   */
  action: CreatorFeedbackAction;
  /**
   * What the person wrote instead, on an edit, and null on anything else.
   *
   * The proposal above is kept alongside it: the pair is the whole point of
   * looking back, and it is what the next analysis is shown.
   */
  editedPostText: string | null;
  answeredAt: Date;
};

/** One analysis, with the judgements somebody has already answered. */
export type CreatorHistoryItem = {
  contentItemId: string;
  title: string | null;
  sourceExcerpt: string;
  analyzedAt: Date;
  /** Where the material came from — an address, when there was one. */
  source: CreatorReviewSource;
  decisions: CreatorHistoryDecision[];
};

type HistoryDecisionRow = {
  id: string;
  targetChannel: string;
  verdict: string;
  reason: string;
  userId: string;
  draft: { body: string; userId: string } | null;
  feedback: {
    id: string;
    userId: string;
    action: string;
    editedBody: string | null;
    createdAt: Date;
  } | null;
};

type HistoryItemRow = {
  id: string;
  title: string | null;
  body: string;
  createdAt: Date;
  sourceKind: string;
  sourceUrl: string | null;
  userId: string;
  decisions: HistoryDecisionRow[];
};

/**
 * Turns one answered judgement into something a screen may show, or refuses.
 *
 * **The same rules as the inbox, plus the answer's own.** A row describing
 * something that cannot have happened — an edit with nothing written, an
 * approval carrying a rewrite — is refused rather than rendered, because a
 * history is a record and a plausible guess in one is worse than a blank page.
 */
function toHistoryDecision(
  row: HistoryDecisionRow,
  userId: string,
): CreatorHistoryDecision {
  const refuse = (reason: string): never => {
    throw new InvalidCreatorReviewDataError(row.id, reason);
  };

  // Belt as well as braces, at every level the query already scopes.
  if (row.userId !== userId) {
    refuse("owner-mismatch");
  }

  if (row.draft !== null && row.draft.userId !== userId) {
    refuse("draft-owner-mismatch");
  }

  // The query asks only for answered decisions, so an unanswered one arriving
  // means the filter no longer means what it says.
  if (row.feedback === null) {
    refuse("not-answered");
  }

  const feedback = row.feedback as NonNullable<HistoryDecisionRow["feedback"]>;

  if (feedback.userId !== userId) {
    refuse("feedback-owner-mismatch");
  }

  if (!isCreatorTargetChannel(row.targetChannel)) {
    refuse("unknown-channel");
  }

  if (!isEditorialVerdict(row.verdict)) {
    refuse("unknown-verdict");
  }

  if (!isCreatorFeedbackAction(feedback.action)) {
    refuse("unknown-feedback-action");
  }

  const targetChannel = row.targetChannel as CreatorTargetChannel;
  const verdict = row.verdict as EditorialVerdict;
  const action = feedback.action as CreatorFeedbackAction;

  if (row.reason.trim() === "") {
    refuse("empty-reason");
  }

  if (verdict === "recommend" && row.draft === null) {
    refuse("recommend-without-post-text");
  }

  if (verdict === "skip" && row.draft !== null) {
    refuse("skip-with-post-text");
  }

  // The three rules the service applies when an edit is recorded, read back.
  if (action === "edit") {
    if (verdict !== "recommend") {
      refuse("edit-of-skip");
    }

    if (feedback.editedBody === null || feedback.editedBody.trim() === "") {
      refuse("edit-without-edited-body");
    }
  } else if (feedback.editedBody !== null) {
    // Approving *and* rewriting are two different answers, and the service
    // stores null on everything that is not an edit.
    refuse("edited-body-without-edit");
  }

  return {
    id: row.id,
    targetChannel,
    verdict,
    reason: row.reason,
    postText: row.draft?.body ?? null,
    action,
    editedPostText: action === "edit" ? feedback.editedBody : null,
    answeredAt: feedback.createdAt,
  };
}

/**
 * The analyses this account has already answered something about, newest first.
 *
 * **Answered decisions only, which is the mirror of the inbox.** A piece whose
 * three judgements are half answered appears on both screens, showing different
 * halves of itself — that is the two views working, not a duplicate.
 *
 * **Ordered by the analysis, not by the answer.** What somebody is looking for
 * is *which analysis* a judgement came from, especially when two carry the same
 * title; sorting by when each was answered would interleave them.
 *
 * **One bounded query.** Everything a card shows is selected here, so rendering
 * twenty analyses costs one read rather than one per item.
 *
 * **Bounded is not the same as final.** The page shows twenty, which is what
 * keeps the read small; what it did not have was a way to the twenty-first.
 * Those rows were in the database with nothing on any screen naming them — the
 * record of an answer somebody gave, kept and unreachable.
 *
 * **Seek, not offset.** A `skip` of twenty means "past the twenty newest *at
 * the moment of asking*", and this list grows at the top: an analysis run
 * between two pages would shift everything down and repeat a row. A cursor
 * names a position in the ordering instead, so something new appearing above
 * it changes nothing about where the older page begins.
 *
 * **Two keys, because one is not unique.** Two analyses can share a
 * `createdAt`, and ordering on it alone leaves the database free to return
 * same-instant rows in either order — a page boundary inside such a group
 * would show one twice and lose another. `id` breaks the tie in the same
 * direction.
 *
 * **The cursor is a position, not a permission.** `userId` stays at the top of
 * the filter and is never derived from the cursor, so values copied from
 * another account name a place in *this* account's ordering and nothing more.
 * That is also why the cursor row is never looked up first: there is no
 * ownership to establish, and one query per page is the whole cost.
 */
export type CreatorHistoryCursor = {
  analyzedAt: Date;
  contentItemId: string;
};

/** One page of answered analyses, and where the next one starts. */
export type CreatorHistoryPage = {
  items: CreatorHistoryItem[];
  nextCursor: CreatorHistoryCursor | null;
};

export async function listCreatorHistoryPage(
  userId: string,
  cursor: CreatorHistoryCursor | null = null,
  client: DbClient = prisma,
): Promise<CreatorHistoryPage> {
  const rows = (await client.contentItem.findMany({
    where: {
      userId,
      decisions: { some: { userId, feedback: { isNot: null } } },
      ...(cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.analyzedAt } },
              {
                createdAt: cursor.analyzedAt,
                id: { lt: cursor.contentItemId },
              },
            ],
          }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One more than is shown: the extra row is never rendered, it only answers
    // whether anything older exists.
    take: CREATOR_HISTORY_ITEM_LIMIT + 1,
    select: {
      id: true,
      title: true,
      body: true,
      createdAt: true,
      sourceKind: true,
      sourceUrl: true,
      userId: true,
      decisions: {
        where: { userId, feedback: { isNot: null } },
        select: {
          id: true,
          targetChannel: true,
          verdict: true,
          reason: true,
          userId: true,
          draft: { select: { body: true, userId: true } },
          feedback: {
            select: {
              id: true,
              userId: true,
              action: true,
              editedBody: true,
              createdAt: true,
            },
          },
        },
      },
    },
  })) as HistoryItemRow[];

  const visible = rows.slice(0, CREATOR_HISTORY_ITEM_LIMIT);

  const items = visible.map((row) => {
    if (row.userId !== userId) {
      throw new InvalidCreatorReviewDataError(row.id, "item-owner-mismatch");
    }

    const decisions = row.decisions
      .map((decision) => toHistoryDecision(decision, userId))
      .sort((a, b) => channelPosition(a.targetChannel) - channelPosition(b.targetChannel));

    return {
      contentItemId: row.id,
      title:
        row.title === null
          ? null
          : excerptForHistory(row.title, creatorAnalysisLimits.feedbackContentTitle),
      // **An excerpt here too.** Looking back at a decision does not need the
      // article that prompted it; the whole body never leaves the server.
      sourceExcerpt: excerptForHistory(
        row.body,
        creatorAnalysisLimits.feedbackContentExcerpt,
      ),
      analyzedAt: row.createdAt,
      source: toReviewSource(row.id, row.sourceKind, row.sourceUrl),
      decisions,
    };
  });

  // **The last analysis shown, not the one beyond it.** Pointing at the
  // twenty-first row would make the next page start after it, and the analysis
  // in between would be skipped entirely.
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      rows.length > CREATOR_HISTORY_ITEM_LIMIT && last !== undefined
        ? { analyzedAt: last.analyzedAt, contentItemId: last.contentItemId }
        : null,
  };
}
