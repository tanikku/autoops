import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { RoutineForm } from "@/components/routine-form";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { getTrialUsageView } from "@/lib/usage/trial-view";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

/**
 * The title and description in the language the screen itself is in.
 *
 * **The document already declares a language.** `app/layout.tsx` writes the
 * account's onto `<html>`, and everything visible here follows it — so a title
 * left in English would be the one part of the page contradicting the
 * attribute a screen reader chooses its voice from.
 *
 * **The heading is reused, and it is generic on purpose.** No id is read and
 * no owned record is fetched to build a title: what a browser tab says must
 * not depend on a row this request has not been shown it may see.
 *
 * **Read-only.** `getDocumentLanguage` decodes the session and falls back to
 * English; no account row is read into existence to render a title.
 */
export async function generateMetadata(): Promise<Metadata> {
  const language = await getDocumentLanguage();

  return {
    title: `${t(language, "dashboard.hireWorker")} — Koqentra`,
    description: t(language, "worker.create.metadataDescription"),
  };
}

// The zone comes from the account row, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function NewRoutinePage() {
  // Read, never written: this only decides what the form says about the
  // schedule it is about to create. The action reads the same value again when
  // it works out the first slot.
  const userId = await requireUserId();
  const [timezone, language, trial] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguage(userId),
    // **Read to explain, never to start.** Nothing here begins a trial or
    // opens a period; an account that has done nothing still has no rows after
    // looking at this page.
    getTrialUsageView(userId),
  ]);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        {/* The dashboard's button and this heading are the same act under
            the same words, so they share a key rather than drifting apart. */}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "dashboard.hireWorker")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(language, "worker.create.description")}
        </p>

        {/* **Said here because here is where a trial starts.** Activating the
            first Worker begins the fourteen days, and somebody who learns that
            only afterwards has been surprised by their own account.

            **The carried-in line appears only when there is something to
            carry.** An account that has used no AI processing is told nothing
            about a number that is zero. */}
        {trial.kind === "pre-trial" ? (
          <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
            <p className="text-sm text-muted-foreground">
              {t(language, "trial.preStart.explanation")}
            </p>
            {trial.aiUsed > 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(language, "trial.preStart.carryIn", {
                  used: trial.aiUsed,
                  limit: trial.aiLimit,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        <RoutineForm timezone={timezone} language={language} />
      </main>
    </div>
  );
}
