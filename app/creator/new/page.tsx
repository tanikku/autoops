import type { Metadata } from "next";
import { CreatorAnalysisForm } from "@/components/creator-analysis-form";
import { CreatorLearningContext } from "@/components/creator-learning-context";
import { DashboardNav } from "@/components/dashboard-nav";
import {
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

  // **Three reads and no writes.** The same two functions the analyzer's
  // context is built from, so what the panel shows and what the model is told
  // cannot drift apart — `readCreatorProfile` answers with empty preferences
  // rather than creating a row, which is what keeps looking at this page free
  // of side effects.
  const [language, profile, feedback] = await Promise.all([
    getUserLanguage(userId),
    readCreatorProfile(userId),
    readRecentFeedbackContext(userId),
  ]);

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

        {/* **Beside the form, not inside it.** What the next analysis will
            consider is worth being able to check before submitting — but it is
            a preview, and nothing here reaches the request. The form still
            submits a title and a body; the profile and the history are read
            again, server-side, from the session that submits. */}
        <CreatorLearningContext
          profile={profile}
          feedback={feedback}
          language={language}
        />

        <CreatorAnalysisForm language={language} />
      </main>
    </div>
  );
}
