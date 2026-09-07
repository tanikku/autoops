import type { Metadata } from "next";
import { DashboardNav } from "@/components/dashboard-nav";
import { RoutineForm } from "@/components/routine-form";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
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
  const [timezone, language] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguage(userId),
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

        <RoutineForm timezone={timezone} language={language} />
      </main>
    </div>
  );
}
