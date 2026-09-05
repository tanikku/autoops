"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  type CreatorFeedbackState,
  recordCreatorFeedbackAction,
} from "@/app/creator/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { creatorAnalysisLimits } from "@/lib/creator/analyzer";
import type { CreatorReviewDecision } from "@/lib/creator/review";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * One channel's judgement, and the three things a person can say back.
 *
 * **The words differ by verdict because the questions do.** Agreeing with a
 * recommendation means "post this"; agreeing with a skip means "yes, leave it".
 * Labelling both "approve" would ask the reader to translate an internal value
 * before they could answer — and the internal value is what the action still
 * receives, unchanged.
 *
 * **A skip has nothing to edit**, so it offers no way to. Rewriting a post that
 * was never proposed is not a thing that can happen.
 */

const CHANNEL_KEYS = {
  x: "creator.channel.x",
  reddit: "creator.channel.reddit",
  longform: "creator.channel.longform",
} as const satisfies Record<string, TranslationKey>;

/** Which button, in the form the action already understands. */
type FeedbackAction = "approve" | "edit" | "reject";

function ActionButton({
  language,
  labelKey,
  variant,
}: {
  language: string;
  labelKey: TranslationKey;
  variant?: "default" | "outline" | "ghost";
}) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? t(language, "creator.feedback.sending") : t(language, labelKey)}
    </Button>
  );
}

/**
 * One answer, as its own form.
 *
 * Each button submits its own `action` value, so nothing has to be held in
 * state to know which one was pressed — and `useFormStatus` can disable only
 * the button that is actually working.
 *
 * **It carries the two hidden fields and nothing else.** It used to append a
 * submit button of its own as well, which read as a convenience and was a bug:
 * the edit branch passes its own Save button in `children`, so that branch
 * rendered two. A form component that quietly adds a control cannot be composed
 * with one that supplies its own, and the three answers here genuinely differ —
 * approve and reject are a lone button, edit is a textarea with Save and
 * Cancel. **Every call site passes exactly one submit button.**
 */
function FeedbackForm({
  decisionId,
  action,
  formAction,
  children,
}: {
  decisionId: string;
  action: FeedbackAction;
  formAction: (payload: FormData) => void;
  children: React.ReactNode;
}) {
  return (
    <form action={formAction} className="contents">
      {/* **The decision, and nothing about who is asking.** The owner comes
          from the session inside the action; a form that carried one would be
          naming a tenant the server would then have to distrust anyway. */}
      <input type="hidden" name="editorialDecisionId" value={decisionId} />
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}

export function CreatorDecisionCard({
  decision,
  language,
}: {
  decision: CreatorReviewDecision;
  language: string;
}) {
  const [state, formAction] = useActionState<CreatorFeedbackState, FormData>(
    recordCreatorFeedbackAction,
    null,
  );
  const [editRequested, setEditRequested] = useState(false);
  const router = useRouter();

  useActionResult(state);

  // **Whether the box is open is derived, not stored twice.** Somebody asked
  // for it, and a saved answer closes it — computing that here rather than
  // resetting a second piece of state from an effect keeps one fact in one
  // place, and the two cannot disagree while a refresh is in flight.
  const saved = state?.status === "success";
  const editing = editRequested && !saved;

  // **An answered decision leaves the inbox.** The list is a Server Component
  // reading the database, so asking the router to refresh is what makes the
  // card disappear — there is no client-side copy of the list to remove it
  // from, and none is wanted.
  useEffect(() => {
    if (saved) {
      router.refresh();
    }
  }, [saved, router]);

  const recommended = decision.verdict === "recommend";

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {t(language, CHANNEL_KEYS[decision.targetChannel])}
        </span>
        {/* **A skip is not an error, and is not coloured like one.** It is a
            decision somebody may well agree with. */}
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

      {recommended && decision.postText !== null ? (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground">
            {t(language, "creator.postText")}
          </p>
          {/* **Kept scrollable rather than shortened.** A long-form piece is
              meant to be read before it is agreed to, so nothing is cut — but
              one of them must not push every other card off the screen.
              `whitespace-pre-wrap` keeps the paragraphs the model wrote, and
              `break-words` stops an unbroken URL widening the page on a
              phone. */}
          <div className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm">
            {decision.postText}
          </div>
        </div>
      ) : null}

      {editing && recommended && decision.postText !== null ? (
        <FeedbackForm
          decisionId={decision.id}
          action="edit"
          formAction={formAction}
        >
          <div className="mt-4 w-full">
            <Label htmlFor={`edited-${decision.id}`}>
              {t(language, "creator.feedback.editLabel")}
            </Label>
            {/* **The proposal is where the edit starts, and the proposal is
                not overwritten by it.** What the person writes travels as
                `editedBody`; `ContentDraft.body` keeps what was suggested,
                because the pair is the signal the next analysis reads. */}
            <Textarea
              id={`edited-${decision.id}`}
              name="editedBody"
              defaultValue={decision.postText}
              maxLength={creatorAnalysisLimits.feedbackEditedBody}
              rows={8}
              className="mt-1"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton
              language={language}
              labelKey="creator.feedback.save"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditRequested(false)}
            >
              {t(language, "creator.feedback.cancel")}
            </Button>
          </div>
        </FeedbackForm>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <FeedbackForm
            decisionId={decision.id}
            action="approve"
            formAction={formAction}
          >
            <ActionButton
              language={language}
              labelKey={
                recommended
                  ? "creator.feedback.useAsIs"
                  : "creator.feedback.agreeWithSkip"
              }
            />
          </FeedbackForm>

          {recommended ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditRequested(true)}
            >
              {t(language, "creator.feedback.editAndUse")}
            </Button>
          ) : null}

          <FeedbackForm
            decisionId={decision.id}
            action="reject"
            formAction={formAction}
          >
            <ActionButton
              language={language}
              variant="ghost"
              labelKey={
                recommended
                  ? "creator.feedback.reject"
                  : "creator.feedback.wouldPost"
              }
            />
          </FeedbackForm>
        </div>
      )}
    </div>
  );
}
