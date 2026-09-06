"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  analyzeCreatorTextAction,
  analyzeCreatorUrlAction,
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
 * Where somebody hands Koqentra a piece of writing, or says where to find one.
 *
 * **The form cannot say what kind of source this is.** The two modes submit to
 * two different server actions, so provenance follows from which one ran rather
 * than from a hidden field — and a field claiming it would be a claim the
 * server would have to distrust anyway. Nothing about the owner, the channels
 * or the model is here either, for the same reason.
 *
 * **URL mode sends an address, never a body.** What gets analysed is what
 * Koqentra read from that page; a body arriving alongside a URL would let
 * anybody attribute any text to any address.
 *
 * **The lengths come from the analyzer contract**, so a box stops accepting
 * text at the point a request would be refused. That is a courtesy rather than
 * a check — the server action and the service both measure again, and theirs
 * are the ones that decide.
 */

type SourceMode = "text" | "url";

function SubmitButton({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {t(language, pending ? "creator.new.submitting" : "creator.new.submit")}
    </Button>
  );
}

/**
 * Choosing between pasting and giving an address.
 *
 * **Buttons rather than a select, and `type="button"` rather than submit.**
 * Each one only changes which fields are on screen; a submit here would send
 * the form somebody was still filling in. `aria-pressed` is what says which is
 * chosen, so a screen reader gets the same answer the border gives.
 */
function ModeButton({
  language,
  mode,
  current,
  onSelect,
  labelKey,
}: {
  language: string;
  mode: SourceMode;
  current: SourceMode;
  onSelect: (mode: SourceMode) => void;
  labelKey: "creator.new.sourceText" | "creator.new.sourceUrl";
}) {
  const selected = mode === current;

  return (
    <Button
      type="button"
      size="sm"
      variant={selected ? "default" : "outline"}
      aria-pressed={selected}
      onClick={() => onSelect(mode)}
    >
      {t(language, labelKey)}
    </Button>
  );
}

function TitleField({ language }: { language: string }) {
  return (
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
  );
}

/**
 * What both modes say, and what one of them says differently.
 *
 * The privacy sentence is per mode because the two do different things: a paste
 * sends what somebody typed, while a URL also makes Koqentra's server fetch
 * somebody else's page. The note about past answers is the same either way.
 */
function Notes({ language, mode }: { language: string; mode: SourceMode }) {
  return (
    <>
      {/* **Said where the decision is made, not only in a policy page.** A
          sentence at the button is what somebody actually reads before they
          hand over something unpublished; the full description lives one link
          away rather than as a wall of text above the field. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          language,
          mode === "url"
            ? "creator.new.urlPrivacyNote"
            : "creator.new.privacyNote",
        )}{" "}
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
    </>
  );
}

export function CreatorAnalysisForm({ language }: { language: string }) {
  const [mode, setMode] = useState<SourceMode>("text");

  const [textState, textAction] = useActionState<CreatorAnalysisState, FormData>(
    analyzeCreatorTextAction,
    null,
  );
  const [urlState, urlAction] = useActionState<CreatorAnalysisState, FormData>(
    analyzeCreatorUrlAction,
    null,
  );

  // **The result of the analysis is not in the answer, so this goes to read
  // it.** What came back is in the database; the inbox is the screen that shows
  // it, and sending the decisions through a form's state would put unpublished
  // writing somewhere nobody asked for it to be.
  //
  // Each action keeps its own state, and only the one on screen is watched —
  // otherwise switching modes would re-raise a toast about the other.
  useActionResult(mode === "url" ? urlState : textState, {
    redirectTo: "/creator",
  });

  return (
    <div className="mt-6 max-w-2xl">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {t(language, "creator.new.sourceLabel")}
        </span>
        <ModeButton
          language={language}
          mode="text"
          current={mode}
          onSelect={setMode}
          labelKey="creator.new.sourceText"
        />
        <ModeButton
          language={language}
          mode="url"
          current={mode}
          onSelect={setMode}
          labelKey="creator.new.sourceUrl"
        />
      </div>

      {mode === "url" ? (
        <form action={urlAction} className="mt-5 flex flex-col gap-5">
          <TitleField language={language} />

          <div>
            <Label htmlFor="creator-url">
              {t(language, "creator.new.urlLabel")}
            </Label>
            <Input
              id="creator-url"
              name="url"
              type="url"
              required
              maxLength={creatorAnalysisLimits.contentSourceUrl}
              placeholder={t(language, "creator.new.urlPlaceholder")}
              className="mt-1 w-full"
            />
            {/* **Says what is not supported.** A bare address field promises
                that any URL works, and that is not true: a page behind a
                sign-in is never fetched, and a PDF is refused. */}
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t(language, "creator.new.urlHelp")}
            </p>
          </div>

          <Notes language={language} mode="url" />

          <div>
            <SubmitButton language={language} />
          </div>
        </form>
      ) : (
        <form action={textAction} className="mt-5 flex flex-col gap-5">
          <TitleField language={language} />

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

          <Notes language={language} mode="text" />

          <div>
            <SubmitButton language={language} />
          </div>
        </form>
      )}
    </div>
  );
}
