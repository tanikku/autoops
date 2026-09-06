"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  updateCreatorPreferencesAction,
  type UpdateCreatorPreferencesState,
} from "@/app/dashboard/settings/actions";
import { useActionResult } from "@/components/notification/use-action-result";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type CreatorAnalysisProfile,
  creatorAnalysisLimits,
} from "@/lib/creator/analyzer";
import { t } from "@/lib/i18n";

/**
 * Where somebody states what Koqentra should assume about their writing.
 *
 * **Three fields, and the form cannot say anything else.** No owner and no
 * profile id: the row is addressed by the session's account, so a field naming
 * one would be a claim the server would have to distrust anyway.
 *
 * **Its own save, beside the timezone and the language.** The same reason those
 * two are separate — a single result describing two writes has nothing sensible
 * to say when one lands and the other does not.
 *
 * **The lengths come from the analyzer contract**, so a box stops accepting
 * text at the point an analysis request would be refused. That is a courtesy
 * rather than a check; the action measures again, and its answer is the one
 * that decides.
 */

function SaveButton({ language }: { language: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {t(language, pending ? "common.saving" : "common.save")}
    </Button>
  );
}

export function CreatorPreferencesForm({
  profile,
  language,
}: {
  /** What is stored today. Empty strings where nothing has been stated. */
  profile: CreatorAnalysisProfile;
  language: string;
}) {
  const [state, formAction] = useActionState<
    UpdateCreatorPreferencesState,
    FormData
  >(updateCreatorPreferencesAction, null);

  // Settings has nowhere to go afterwards, so the toast is the only feedback.
  useActionResult(state);

  return (
    <form action={formAction} className="mt-8 flex max-w-2xl flex-col gap-6">
      <div>
        <Label htmlFor="creator-audience">
          {t(language, "settings.creator.audience")}
        </Label>
        <Textarea
          id="creator-audience"
          name="audience"
          rows={3}
          defaultValue={profile.audience}
          maxLength={creatorAnalysisLimits.profileAudience}
          placeholder={t(language, "settings.creator.audiencePlaceholder")}
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="creator-goals">
          {t(language, "settings.creator.goals")}
        </Label>
        <Textarea
          id="creator-goals"
          name="goals"
          rows={3}
          defaultValue={profile.goals}
          maxLength={creatorAnalysisLimits.profileGoals}
          placeholder={t(language, "settings.creator.goalsPlaceholder")}
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="creator-voice">
          {t(language, "settings.creator.voice")}
        </Label>
        <Textarea
          id="creator-voice"
          name="voiceInstructions"
          rows={5}
          defaultValue={profile.voiceInstructions}
          maxLength={creatorAnalysisLimits.profileVoiceInstructions}
          placeholder={t(language, "settings.creator.voicePlaceholder")}
          className="mt-1"
        />
      </div>

      {/* **Where these sit against everything else Koqentra is told.** Stated
          preferences are read above patterns in past answers, which is what the
          analyzer actually does. What this must never say is that a model will
          obey them, or that a post will do well — neither is something a call
          to a model can be held to. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(language, "settings.creator.priorityNote")}
      </p>

      <div>
        <SaveButton language={language} />
      </div>
    </form>
  );
}
