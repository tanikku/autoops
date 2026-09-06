import { formatDateTime } from "@/lib/datetime";
import type { CreatorHistoryDecision } from "@/lib/creator/review";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * One judgement that was answered, and what the answer was.
 *
 * **A record, so it has nothing to press.** No form, no button, no action:
 * feedback is append-only, and a screen offering to change an answer would be
 * offering something the rest of the product refuses. What it does is show the
 * pair worth looking back at — what Koqentra proposed, and what the person
 * actually took away.
 *
 * **A Server Component**, because none of that needs a browser. It renders
 * inside the history page and ships no client bundle of its own.
 */

const CHANNEL_KEYS = {
  x: "creator.channel.x",
  reddit: "creator.channel.reddit",
  longform: "creator.channel.longform",
} as const satisfies Record<string, TranslationKey>;

/**
 * What somebody chose, said the way they chose it.
 *
 * **The stored value is not the sentence**, and the pair is what carries the
 * meaning: `approve` is "post this" against a recommendation and "yes, leave
 * it" against a skip. These are the same five phrases the learning panel uses,
 * read from the same keys.
 *
 * **Deliberately not "copied and used".** Answers recorded before the clipboard
 * handoff existed are stored as `approve` as well, and calling those copied
 * would put an event in the record that never happened.
 */
const ACTION_KEYS = {
  "recommend:approve": "creator.learning.action.usedAsIs",
  "recommend:edit": "creator.learning.action.editedAndUsed",
  "recommend:reject": "creator.learning.action.rejected",
  "skip:approve": "creator.learning.action.agreedWithSkip",
  "skip:reject": "creator.learning.action.wouldPost",
} as const satisfies Record<string, TranslationKey>;

function humanAnswer(decision: CreatorHistoryDecision): TranslationKey | null {
  const key = `${decision.verdict}:${decision.action}` as keyof typeof ACTION_KEYS;
  return ACTION_KEYS[key] ?? null;
}

/**
 * A piece of writing, bounded on screen rather than cut in the data.
 *
 * The same viewport the review card uses: a long-form post is meant to be
 * readable, but one of them must not push everything else off the page, and an
 * unbroken URL must not widen it sideways on a phone.
 */
function PostText({ label, body }: { label: string; body: string }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm">
        {body}
      </div>
    </div>
  );
}

export function CreatorHistoryDecisionCard({
  decision,
  language,
  timezone,
}: {
  decision: CreatorHistoryDecision;
  language: string;
  /** The account's own zone, so the moment reads the way every other one does. */
  timezone: string;
}) {
  const recommended = decision.verdict === "recommend";
  const answerKey = humanAnswer(decision);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {t(language, CHANNEL_KEYS[decision.targetChannel])}
        </span>
        {/* A skip is a decision somebody may well have agreed with, and is not
            coloured like an error. */}
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            recommended
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {t(
            language,
            recommended ? "creator.verdict.recommend" : "creator.verdict.skip",
          )}
        </span>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {decision.reason}
      </p>

      {/* **What Koqentra proposed, kept as proposed.** An edit stores what the
          person wrote somewhere else entirely; this is still the original. */}
      {recommended && decision.postText !== null ? (
        <PostText
          label={t(language, "creator.postText")}
          body={decision.postText}
        />
      ) : null}

      {decision.editedPostText === null ? null : (
        <PostText
          label={t(language, "creator.history.yourPostText")}
          body={decision.editedPostText}
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {answerKey === null ? null : (
          <span>
            {t(language, "creator.learning.youLabel")}:{" "}
            <span className="font-medium text-foreground">
              {t(language, answerKey)}
            </span>
          </span>
        )}
        {/* Answered, not analysed — the two moments are different and the
            heading above carries the other one. */}
        <span>
          {t(language, "creator.history.answeredAt", {
            at: formatDateTime(decision.answeredAt, timezone),
          })}
        </span>
      </div>
    </div>
  );
}
