import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";
import { WorkerEditForm } from "@/components/worker-edit-form";
import { getRoutineForEdit } from "@/lib/routines";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";
import { getWebsiteSource } from "@/lib/website-sources";
import { minutesToTimeValue } from "@/lib/worker-input";

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
    title: `${t(language, "worker.edit.title")} — Koqentra`,
    description: t(language, "worker.edit.metadataDescription"),
  };
}

// Workers live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function EditWorkerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await requireUserId();
  // A worker owned by someone else is indistinguishable from one that does not
  // exist: both 404, so the id is never confirmed. So is one stored with a kind
  // this version cannot read — offering a form for a worker nobody can describe
  // would end in saving an answer that was never given.
  const worker = await getRoutineForEdit(id, userId);

  if (!worker) {
    notFound();
  }

  // What the form says about the schedule it is editing, and the words it
  // says it in. Read only, both of them.
  const [timezone, language] = await Promise.all([
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);

  // **Only a website worker has a page, and only it is asked for one.**
  const source =
    worker.kind === "website" ? await getWebsiteSource(id, userId) : null;

  // A website worker with nothing to watch is a state that should not exist.
  // Rendering it as a prompt worker would hide that, and saving the form would
  // then be a conversion nobody asked for — so it is treated as no worker.
  if (worker.kind === "website" && !source) {
    notFound();
  }

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "worker.edit.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(language, "worker.edit.description")}
        </p>

        <WorkerEditForm
          worker={{
            id: worker.id,
            kind: worker.kind,
            name: worker.name,
            description: worker.description,
            prompt: worker.prompt,
            websiteUrl: source?.url,
            frequency: worker.frequency,
            status: worker.status,
            runAt: minutesToTimeValue(worker.runAtMinutes),
            runAtWeekday: worker.runAtWeekday,
            runAtDay: worker.runAtDay,
            emailNotificationsEnabled: worker.emailNotificationsEnabled,
          }}
          timezone={timezone}
          language={language}
        />
      </main>
    </div>
  );
}
