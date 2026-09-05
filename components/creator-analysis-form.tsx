"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  analyzeCreatorTextAction,
  type CreatorAnalysisState,
} from "@/app/creator/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { creatorAnalysisLimits } from "@/lib/creator/analyzer";
import { t } from "@/lib/i18n";

/**
 * Where somebody hands Koqentra a piece of writing.
 *
 * **Two fields, and the form cannot say anything else.** No owner, no source
 * kind, no channel, no model: each of those is either the session's to know or
 * the application's to decide, and a field naming one would be a claim the
 * server would have to distrust anyway.
 *
 * **The lengths come from the analyzer contract**, so the box stops accepting
 * text at the point a request would be refused. That is a courtesy rather than
 * a check — the server action and the service both measure again, and theirs
 * are the ones that decide.
 */

function SubmitButton({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {t(language, pending ? "creator.new.submitting" : "creator.new.submit")}
    </Button>
  );
}

export function CreatorAnalysisForm({ language }: { language: string }) {
  const [state, formAction] = useActionState<CreatorAnalysisState, FormData>(
    analyzeCreatorTextAction,
    null,
  );

  // **The result of the analysis is not in the answer, so this goes to read
  // it.** What came back is in the database; the inbox is the screen that shows
  // it, and sending the decisions through a form's state would put unpublished
  // writing somewhere nobody asked for it to be.
  useActionResult(state, { redirectTo: "/creator" });

  return (
    <form action={formAction} className="mt-6 flex max-w-2xl flex-col gap-5">
      <div>
        <Label htmlFor="creator-title">
          {t(language, "creator.new.titleLabel")}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            {t(language, "creator.new.titleOptional")}
          </span>
        </Label>
        <Input
          id="creator-title"
          name="title"
          maxLength={creatorAnalysisLimits.contentTitle}
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="creator-body">
          {t(language, "creator.new.bodyLabel")}
        </Label>
        <Textarea
          id="creator-body"
          name="body"
          required
          maxLength={creatorAnalysisLimits.contentBody}
          placeholder={t(language, "creator.new.bodyPlaceholder")}
          // Tall enough to paste an article into on a phone without the box
          // becoming a one-line slot the text scrolls through.
          rows={12}
          className="mt-1"
        />
      </div>

      {/* **Said where the decision is made, not only in a policy page.** A
          sentence at the button is what somebody actually reads before they
          hand over something unpublished; the full description lives one link
          away rather than as a wall of text above the field. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(language, "creator.new.privacyNote")}{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          {t(language, "creator.new.privacyLink")}
        </Link>
      </p>

      {/* **What past answers are actually used for.** Context on the next
          analysis — not a profile of somebody being built up, which is not
          something Koqentra does today. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(language, "creator.new.learningNote")}
      </p>

      <div>
        <SubmitButton language={language} />
      </div>
    </form>
  );
}
