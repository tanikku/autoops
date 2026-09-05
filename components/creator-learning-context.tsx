import Link from "next/link";
import {
  type CreatorAnalysisProfile,
  creatorAnalysisLimits,
  type CreatorFeedbackContext,
} from "@/lib/creator/analyzer";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * What the next analysis will be told, shown before it happens.
 *
 * **Human facts, never a conclusion drawn from them.** Everything here is
 * either something the person typed into their profile or something they did
 * to an earlier decision. Nothing summarises it, because Koqentra does not
 * derive a preference — a panel saying "we have learned you like short posts"
 * would describe a feature that does not exist, and would be believed.
 *
 * **The same values the analyzer receives.** They come from
 * `readCreatorProfile` and `readRecentFeedbackContext`, read once by the page
 * and passed down — not rebuilt here from a second query. A preview assembled
 * by different code could disagree with what is actually sent, which is the one
 * way a transparency panel can be worse than none.
 *
 * **A Server Component with no state.** `<details>` collapses it natively, so
 * nothing here needs hydration, a client bundle, or a `"use client"` boundary
 * to stay out of the way on a phone.
 */

const CHANNEL_KEYS = {
  x: "creator.channel.x",
  reddit: "creator.channel.reddit",
  longform: "creator.channel.longform",
} as const satisfies Record<string, TranslationKey>;

/**
 * What somebody actually chose, said the way they chose it.
 *
 * **The stored value alone does not carry the meaning.** `approve` is "post
 * this" against a recommendation and "yes, leave it" against a skip; printing
 * the column would make the reader translate a database value to recognise
 * their own decision. The pair is what means something, so the pair is what is
 * read.
 *
 * `skip` + `edit` is absent because it cannot happen — `toFeedbackContext`
 * refuses a history containing one, so there is nothing to render.
 */
const ACTION_KEYS = {
  "recommend:approve": "creator.learning.action.usedAsIs",
  "recommend:edit": "creator.learning.action.editedAndUsed",
  "recommend:reject": "creator.learning.action.rejected",
  "skip:approve": "creator.learning.action.agreedWithSkip",
  "skip:reject": "creator.learning.action.wouldPost",
} as const satisfies Record<string, TranslationKey>;

function humanAnswer(entry: CreatorFeedbackContext): TranslationKey | null {
  const key = `${entry.verdict}:${entry.action}` as keyof typeof ACTION_KEYS;
  return ACTION_KEYS[key] ?? null;
}

function ProfileRow({
  label,
  value,
  language,
}: {
  label: string;
  value: string;
  language: string;
}) {
  // **Trimmed to decide, never to store.** An entry of only spaces reads as
  // nothing set; what the analyzer receives is untouched by this.
  const written = value.trim() !== "";

  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 text-sm break-words whitespace-pre-wrap ${
          written ? "" : "text-muted-foreground"
        }`}
      >
        {written ? value : t(language, "creator.learning.notSet")}
      </dd>
    </div>
  );
}

export function CreatorLearningContext({
  profile,
  feedback,
  language,
}: {
  profile: CreatorAnalysisProfile;
  /**
   * Oldest first, exactly as the analyzer receives it.
   *
   * **Not re-ordered here.** The position in the list is what carries recency —
   * no dates are sent to the model and none are shown — so a panel that sorted
   * it would be describing a different history from the one used.
   */
  feedback: CreatorFeedbackContext[];
  language: string;
}) {
  return (
    /* Collapsed by default: this answers a question somebody may not be
       asking, and the form below is what they came for. */
    <details className="mt-6 rounded-lg border border-border bg-muted/30">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        {t(language, "creator.learning.title")}
      </summary>

      <div className="border-t border-border px-4 py-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(language, "creator.learning.description")}
        </p>

        <section className="mt-4">
          <h3 className="text-xs font-semibold">
            {t(language, "creator.learning.profileHeading")}
          </h3>
          <dl className="mt-2 flex flex-col gap-3">
            <ProfileRow
              label={t(language, "creator.learning.audience")}
              value={profile.audience}
              language={language}
            />
            <ProfileRow
              label={t(language, "creator.learning.goals")}
              value={profile.goals}
              language={language}
            />
            <ProfileRow
              label={t(language, "creator.learning.voice")}
              value={profile.voiceInstructions}
              language={language}
            />
          </dl>
        </section>

        <section className="mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-xs font-semibold">
              {t(language, "creator.learning.answersHeading")}
            </h3>
            {/* The ceiling comes from the analyzer contract rather than being
                written here, so the number shown is the one applied. */}
            <span className="text-xs text-muted-foreground">
              {t(language, "creator.learning.answerCount", {
                count: String(feedback.length),
                limit: String(creatorAnalysisLimits.feedbackItems),
              })}
            </span>
          </div>

          {feedback.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(language, "creator.learning.noAnswers")}
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {feedback.map((entry, index) => {
                const answerKey = humanAnswer(entry);

                return (
                  // The list has no stable id — ids are deliberately absent
                  // from `CreatorFeedbackContext` — and its order is the
                  // contract, so the position is the key.
                  <li
                    key={index}
                    className="rounded-md border border-border bg-background px-3 py-2"
                  >
                    {/* **Which piece it was about, and nothing of what was
                        written about it.** A title when there is one, the
                        bounded excerpt otherwise — the excerpt is already
                        shortened by the repository, so nothing is cut again
                        here. */}
                    <p className="line-clamp-2 text-xs break-words whitespace-pre-wrap text-muted-foreground">
                      {entry.contentTitle ??
                        (entry.contentExcerpt.trim() === ""
                          ? t(language, "creator.learning.untitled")
                          : entry.contentExcerpt)}
                    </p>

                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="font-medium">
                        {t(language, CHANNEL_KEYS[entry.targetChannel])}
                      </span>
                      {/* **The brand name is written, not translated.** It is
                          the same word in every language, so a dictionary key
                          for it would be two identical entries and an exception
                          in the parity check that keeps the two dictionaries
                          honest. The verdict beside it *is* translated, because
                          that one is a sentence rather than a name. */}
                      <span className="text-muted-foreground">
                        Koqentra:{" "}
                        {t(
                          language,
                          entry.verdict === "recommend"
                            ? "creator.verdict.recommend"
                            : "creator.verdict.skip",
                        )}
                      </span>
                      {answerKey === null ? null : (
                        <span>
                          {t(language, "creator.learning.youLabel")}:{" "}
                          {t(language, answerKey)}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* **The list above is shorter than what is sent, and says so.**
            Somebody who read it as exhaustive would think their edits were
            being ignored. The full description lives one link away rather than
            being restated here. */}
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {t(language, "creator.learning.detailNote")}{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            {t(language, "creator.new.privacyLink")}
          </Link>
        </p>
      </div>
    </details>
  );
}
