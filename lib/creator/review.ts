import "server-only";

import { creatorAnalysisLimits } from "@/lib/creator/analyzer";
import { excerptForHistory } from "@/lib/creator/repository";
import { type DbClient, prisma } from "@/lib/prisma";
import {
  type CreatorTargetChannel,
  creatorTargetChannels,
  type EditorialVerdict,
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
      decisions,
    };
  });
}
