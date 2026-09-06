import type { Metadata } from "next";
import Link from "next/link";
import { CreatorAnalysisForm } from "@/components/creator-analysis-form";
import { CreatorLearningContext } from "@/components/creator-learning-context";
import { DashboardNav } from "@/components/dashboard-nav";
import { isUsableStoredMemory } from "@/lib/creator/memory";
import {
  readCreatorMemory,
  readCreatorProfile,
  readRecentFeedbackContext,
} from "@/lib/creator/repository";
import { t } from "@/lib/i18n";
import { requireUserId } from "@/lib/session";
import { getUserLanguage } from "@/lib/users";

export const metadata: Metadata = {
  title: "Analyze content — Koqentra",
  description: "Have Koqentra read a piece of writing and say where it belongs.",
};

// The wording comes from the account row, so this page must not be prerendered.
export const dynamic = "force-dynamic";

/**
 * Where a piece of writing is handed over.
 *
 * **The description says that a skip is a real answer.** Somebody arriving here
 * expecting three posts out of every article would read a `skip` as a failure;
 * saying so first is the difference between an editor and a generator.
 *
 * `requireUserId` rather than the provisioning boundary: rendering a form
 * writes nothing, and the row is brought into being by the action once there is
 * something worth analysing.
 */
export default async function CreatorNewPage() {
  const userId = await requireUserId();

  // **Four reads and no writes.** The same functions the analyzer's context is
  // built from, so what the panel shows and what the model is told cannot drift
  // apart — `readCreatorProfile` answers with empty preferences rather than
  // creating a row, and `readCreatorMemory` with null rather than synthesising
  // one, which is what keeps looking at this page free of side effects.
  const [language, profile, memory, feedback] = await Promise.all([
    getUserLanguage(userId),
    readCreatorProfile(userId),
    // **The stored summary, read like everything else here.** Extending it is
    // something submitting does; opening this page makes no model call and
    // writes nothing.
    readCreatorMemory(userId),
    readRecentFeedbackContext(userId),
  ]);

  // **Shown only if the next analysis would actually be given it.** This panel
  // says what the model will be told; a summary displayed here that the
  // analysis refuses to send would make the page contradict the thing it
  // documents. The rule is the analysis's own — a row whose count disagrees
  // with what is recorded against it, or that stands for nothing yet, is not
  // this account's memory and there is nothing here to show.
  //
  // **Not repaired and not explained.** Nothing is written from this page, and
  // an inconsistency in derived context is not somebody's problem to read
  // about; the operator's log already carries it.
  const usableMemory = isUsableStoredMemory(memory) ? memory : null;

  // **Read from the values, never from the row.** A profile that was never
  // created and one saved empty are the same answer to the only question that
  // matters here, and asking the database to tell them apart would mean writing
  // a row to find out. Whitespace counts as nothing said, the same way the
  // panel below already reads it.
  //
  // **A derived summary is not a stated preference and does not count here.**
  // Somebody whose old answers have been summarised has still told Koqentra
  // nothing directly, and hiding the offer because a model wrote something
  // would be treating an inference as a statement.
  const hasStatedPreferences = [
    profile.audience,
    profile.goals,
    profile.voiceInstructions,
  ].some((value) => value.trim() !== "");

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "creator.new.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {t(language, "creator.new.description")}
        </p>

        {/* **Where somebody finds out these preferences exist.** Until this,
            the only sign of them was three lines reading "Not set" inside a
            panel that starts collapsed — which is not a way of finding
            anything.

            **Shown only when all three are empty.** That is the one state
            where "nothing has been said yet" is unambiguous; somebody who
            filled in one of them has told Koqentra what they wanted to, and
            calling that incomplete would be the product disagreeing with them.
            It disappears on its own the moment anything is saved, which is why
            there is nothing here to dismiss and no state remembering that
            somebody did.

            **Before the panel below, because it answers a different
            question.** This one says where the preferences are set; the panel
            says what the next analysis will actually be told.

            **Nothing about it blocks anything.** The form is right there and
            works exactly as well with none of this set — `preferencesOptional`
            says so, so that the callout reads as an offer rather than a
            gate. */}
        {hasStatedPreferences ? null : (
          <div className="mt-6 max-w-2xl rounded-lg border border-border bg-muted/30 px-4 py-4">
            <p className="text-sm leading-relaxed">
              {t(language, "creator.new.preferencesPrompt")}
            </p>
            <Link
              href="/dashboard/settings#creator-preferences"
              className="mt-3 inline-block text-sm underline underline-offset-4"
            >
              {t(language, "creator.new.preferencesAction")}
            </Link>
            <p className="mt-2 text-xs text-muted-foreground">
              {t(language, "creator.new.preferencesOptional")}
            </p>
          </div>
        )}

        {/* **Beside the form, not inside it.** What the next analysis will
            consider is worth being able to check before submitting — but it is
            a preview, and nothing here reaches the request. The form still
            submits a title and a body; the profile and the history are read
            again, server-side, from the session that submits. */}
        <CreatorLearningContext
          profile={profile}
          memory={usableMemory}
          feedback={feedback}
          language={language}
        />

        <CreatorAnalysisForm language={language} />
      </main>
    </div>
  );
}
