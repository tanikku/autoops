"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
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
 *
 * **Adopting a recommendation copies it first.** Koqentra posts nothing, so the
 * clipboard is the whole of the handoff — and an answered decision leaves the
 * inbox, which used to mean the post text went with it before anybody had taken
 * it anywhere. Copy and answer are therefore one action, in that order.
 */

const CHANNEL_KEYS = {
  x: "creator.channel.x",
  reddit: "creator.channel.reddit",
  longform: "creator.channel.longform",
} as const satisfies Record<string, TranslationKey>;

/** Which button, in the form the action already understands. */
type FeedbackAction = "approve" | "edit" | "reject";

/**
 * Puts the post on the clipboard, saying only whether it got there.
 *
 * **A boolean rather than an error, deliberately.** What somebody is about to
 * publish is theirs; a rejection carrying the text, or a caller free to log the
 * exception it arrived in, would be the one way this could leak it. Nothing
 * that comes back from here can hold it.
 *
 * **An unavailable API is a failure, not a reason to fall back.**
 * `document.execCommand` would paper over the one case worth noticing — a
 * context where copying does not work — and answering "adopted" there would
 * record a handoff that never happened.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;

  if (typeof clipboard?.writeText !== "function") {
    return false;
  }

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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
 * Adopting a recommendation: the clipboard first, the answer second.
 *
 * **`type="button"`, because the order is the point.** A submit button would
 * send the answer and copy afterwards, and a copy that then failed would leave
 * "adopted" on record for a post nobody ever received. Submitting is what this
 * does *after* the write resolves — through `requestSubmit`, so the form that
 * goes is the same form the server action already owns.
 *
 * It sits inside that form, so `useFormStatus` still reports it: the label and
 * the disabled state cover the copy and the save as one wait, which is what it
 * is to whoever pressed it.
 */
function CopyAndUseButton({
  language,
  disabled,
  onCopyAndUse,
}: {
  language: string;
  disabled?: boolean;
  onCopyAndUse: () => Promise<void>;
}) {
  const { pending } = useFormStatus();
  const [copying, setCopying] = useState(false);
  const busy = pending || copying;

  return (
    <Button
      type="button"
      size="sm"
      disabled={busy || disabled}
      onClick={() => {
        setCopying(true);
        // It resolves either way — the handler deals with its own failure — so
        // the button is released whether or not a submission followed.
        void onCopyAndUse().finally(() => setCopying(false));
      }}
    >
      {busy
        ? t(language, "creator.feedback.sending")
        : t(language, "creator.feedback.copyAndUse")}
    </Button>
  );
}

/**
 * One answer, as its own form.
 *
 * Each button carries its own `action` value, so nothing has to be held in
 * state to know which one was pressed — and `useFormStatus` can disable only
 * the control that is actually working.
 *
 * **It carries the two hidden fields and nothing else.** It used to append a
 * submit button of its own as well, which read as a convenience and was a bug:
 * the edit branch passes its own button in `children`, so that branch rendered
 * two. A form component that quietly adds a control cannot be composed with one
 * that supplies its own, and the three answers here genuinely differ. **Every
 * call site passes exactly one control that submits.**
 */
function FeedbackForm({
  decisionId,
  action,
  formAction,
  formRef,
  children,
}: {
  decisionId: string;
  action: FeedbackAction;
  formAction: (payload: FormData) => void;
  /** Given only where a button has to submit the form itself, after copying. */
  formRef?: React.RefObject<HTMLFormElement | null>;
  children: React.ReactNode;
}) {
  return (
    <form ref={formRef} action={formAction} className="contents">
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
  // **Held here so the clipboard gets what is on screen.** An uncontrolled box
  // was enough while the only reader was the form, but what gets copied is the
  // text as edited — and going back to the DOM to find that out would make a
  // second source for a value the form already has.
  const [editedBody, setEditedBody] = useState(decision.postText ?? "");
  // **Said beside the button rather than in a toast.** A toast is for what the
  // server answered, and nothing was sent here — the decision is still on
  // screen, and the sentence explaining why belongs next to the control that
  // did not work.
  const [copyFailed, setCopyFailed] = useState(false);
  const approveFormRef = useRef<HTMLFormElement | null>(null);
  const editFormRef = useRef<HTMLFormElement | null>(null);
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

  /**
   * Copy, and answer only if that worked.
   *
   * **A failed copy submits nothing.** "Adopted" is a claim that the post left
   * Koqentra, and the history the next analysis reads would be wrong if it held
   * one that did not. The decision stays in the inbox, where it can be tried
   * again.
   */
  async function copyAndSubmit(
    text: string,
    form: React.RefObject<HTMLFormElement | null>,
  ): Promise<void> {
    if (await copyToClipboard(text)) {
      setCopyFailed(false);
      form.current?.requestSubmit();
      return;
    }

    // What did not happen, and nothing about what was in it.
    setCopyFailed(true);
  }

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
          formRef={editFormRef}
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
              value={editedBody}
              onChange={(event) => setEditedBody(event.target.value)}
              maxLength={creatorAnalysisLimits.feedbackEditedBody}
              rows={8}
              className="mt-1"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* **Blank is refused here because it is refused there.** The
                service rejects an edit whose text is empty, so offering to copy
                nothing and then save it would be offering a round trip that
                ends in an error. The same rule, not a new one. */}
            <CopyAndUseButton
              language={language}
              disabled={editedBody.trim() === ""}
              onCopyAndUse={() => copyAndSubmit(editedBody, editFormRef)}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditRequested(false);
                // Cancel discards the edit, the way closing the box always has.
                setEditedBody(decision.postText ?? "");
              }}
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
            formRef={approveFormRef}
          >
            {recommended && decision.postText !== null ? (
              <CopyAndUseButton
                language={language}
                onCopyAndUse={() =>
                  copyAndSubmit(decision.postText ?? "", approveFormRef)
                }
              />
            ) : (
              /* Agreeing with a skip copies nothing, because nothing was
                 proposed to take anywhere. The recommendation branch of this
                 label is unreachable — `listCreatorReviewItems` refuses a
                 recommendation with no post — and is kept so that removing a
                 guard here cannot silently change what the button says. */
              <ActionButton
                language={language}
                labelKey={
                  recommended
                    ? "creator.feedback.useAsIs"
                    : "creator.feedback.agreeWithSkip"
                }
              />
            )}
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

      {/* One sentence for both branches: whichever button tried to copy, the
          answer was not sent and the decision is still here to try again. */}
      {copyFailed ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {t(language, "creator.feedback.copyFailed")}
        </p>
      ) : null}
    </div>
  );
}
