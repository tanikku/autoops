import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav } from "@/components/dashboard-nav";
import { OverviewCards } from "@/components/overview-cards";
import { RoutineCard } from "@/components/routine-card";
import { RunHistoryList } from "@/components/run-history-list";
import { Button } from "@/components/ui/button";
import { groupHealthByWorker, NEVER_RUN } from "@/lib/health";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { latestExecution, summarizeWorkers } from "@/lib/overview";
import { listRoutines } from "@/lib/routines";
import { listRecentRuns, summarizeRunsByWorker } from "@/lib/runs";
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
    title: `${t(language, "nav.dashboard")} — Koqentra`,
    description: t(language, "dashboard.description"),
  };
}

// Routines live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userId = await requireUserId();
  // Joined to the reads this page already makes rather than added after them:
  // the language is another column on the account row, and asking for it
  // alongside the rest costs a query rather than a round trip.
  // **Two reads of run history, and neither grows with it.** The activity list
  // takes the newest few rows; the summaries are counted by the database over
  // every run there is. One query cannot answer both without one of them being
  // wrong — a bounded list cannot say how many runs a worker has had, and a
  // count cannot say what the last one produced.
  const [routines, recentRuns, runSummaries, timezone, language] =
    await Promise.all([
      listRoutines(userId),
      listRecentRuns(userId),
      summarizeRunsByWorker(userId),
      getUserTimezone(userId),
      getUserLanguage(userId),
    ]);

  // **One reading of the clock for the whole page.** The summaries and every
  // activity row are judged against the same instant, so nothing on screen can
  // disagree with the rest of it about what "now" was.
  const now = new Date();

  // Both are already in memory, so the summaries below add no queries.
  const overview = summarizeWorkers(routines, latestExecution(runSummaries), now);
  const healthByWorker = groupHealthByWorker(runSummaries, now);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t(language, "dashboard.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(language, "dashboard.description")}
            </p>
          </div>
          <Button
            className="w-full sm:w-auto"
            nativeButton={false}
            render={<Link href="/dashboard/new" />}
          >
            {t(language, "dashboard.hireWorker")}
          </Button>
        </div>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "dashboard.overview")}
          </h2>
          <OverviewCards
            overview={overview}
            timezone={timezone}
            language={language}
          />
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "dashboard.workers")}
          </h2>

          {routines.length === 0 ? (
            <div className="mt-4 flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                {t(language, "dashboard.empty")}
              </p>
              <Button
                nativeButton={false}
                render={<Link href="/dashboard/new" />}
              >
                {t(language, "dashboard.hireFirstWorker")}
              </Button>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {routines.map((routine) => (
                <RoutineCard
                  key={routine.id}
                  routine={routine}
                  health={healthByWorker.get(routine.id) ?? NEVER_RUN}
                  timezone={timezone}
                  language={language}
                />
              ))}
            </div>
          )}
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "dashboard.activity")}
          </h2>
          <RunHistoryList
            runs={recentRuns}
            timezone={timezone}
            language={language}
            now={now}
          />
        </section>
      </main>
    </div>
  );
}
