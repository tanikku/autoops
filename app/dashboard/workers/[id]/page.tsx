import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { DashboardNav } from "@/components/dashboard-nav";
import { DeleteWorkerButton } from "@/components/delete-worker-button";
import { RunRoutineButton } from "@/components/run-routine-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WorkerHealthSummary } from "@/components/worker-health";
import { WorkerRunList } from "@/components/worker-run-list";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { summarizeRuns } from "@/lib/health";
import { t, type TranslationKey } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { isRunOverdue } from "@/lib/overview";
import { getRoutineWithStoredKind } from "@/lib/routines";
import {
  listRunsForWorkerPage,
  summarizeRunsForWorker,
  type WorkerRunCursor,
} from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";
import { getWebsiteSource } from "@/lib/website-sources";
import type { RoutineFrequency, RoutineKind, RoutineStatus } from "@/types";

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
    title: `${t(language, "run.detail.worker")} — Koqentra`,
    description: t(language, "worker.detail.metadataDescription"),
  };
}

// Workers live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

/** The badge's words. The stored values are unchanged by any of this. */
const statusKeys: Record<RoutineStatus, TranslationKey> = {
  active: "common.status.active",
  paused: "common.status.paused",
  draft: "common.status.draft",
};

const statusVariants: Record<
  RoutineStatus,
  React.ComponentProps<typeof Badge>["variant"]
> = {
  active: "default",
  paused: "secondary",
  draft: "outline",
};

const frequencyKeys: Record<RoutineFrequency, TranslationKey> = {
  manual: "worker.manual",
  daily: "worker.frequency.daily",
  weekly: "worker.frequency.weekly",
  monthly: "worker.frequency.monthly",
};

/**
 * What this worker *is*, which is not the same question the hire form asks.
 *
 * There, somebody is deciding what they want done — "Run a prompt", "Watch a
 * page". Here it has been decided, and the row reports the answer.
 */
const kindKeys: Record<RoutineKind, TranslationKey> = {
  prompt: "worker.kind.prompt",
  website: "worker.kind.website",
};


function Detail({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

/**
 * Where in this worker's history to continue from, or null for the newest.
 *
 * **Both halves or neither.** The pair names a position in an ordering whose
 * tie-break is the id; one without the other is not a position, so it is not
 * used as one. A malformed value is a broken link rather than an attack — the
 * filter is scoped by worker and account regardless — so the answer is the
 * first page, not a 404 and not an error.
 */
function readRunCursor(
  query: Record<string, string | string[] | undefined>,
): WorkerRunCursor | null {
  const startedAt = typeof query.runBefore === "string" ? query.runBefore : "";
  const id = typeof query.runBeforeId === "string" ? query.runBeforeId.trim() : "";

  if (startedAt === "" || id === "") {
    return null;
  }

  const at = new Date(startedAt);

  return Number.isNaN(at.getTime()) ? null : { startedAt: at, id };
}

export default async function WorkerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const runCursor = readRunCursor(await searchParams);
  const userId = await requireUserId();
  // A worker owned by someone else is indistinguishable from one that does not
  // exist: both 404, so the id is never confirmed.
  //
  // **The kind arrives unrepaired.** Everything below that says what this
  // worker *is* — the type it reports, whether it names a page — is a claim,
  // and `getRoutine` would have answered "prompt" for a row nothing can read.
  // A page is allowed to say it does not know; it is not allowed to guess.
  const found = await getRoutineWithStoredKind(id, userId);

  if (!found) {
    notFound();
  }

  const { routine: worker, kind } = found;

  // **Only a website worker has a page, and only it is asked for one.**
  const source =
    kind === "website" ? await getWebsiteSource(worker.id, userId) : null;

  // A website worker with nothing to watch is a state that should not exist.
  // Falling back to the prompt worker's surface would hide it behind a screen
  // that looks perfectly ordinary — so it gets the same answer as a worker
  // that is not here, which is what it effectively is.
  if (kind === "website" && !source) {
    notFound();
  }

  // One query for the worker's runs, folded into the same summary the
  // dashboard card shows.
  //
  // **The language reaches the labels and stops there.** The worker's name, its
  // description, the address it watches and the instructions it carries are its
  // owner's material and are shown exactly as stored, in whichever language
  // they were written.
  // **Two reads of this worker's history, and neither grows with it.** The
  // summary is counted by the database over every run there is; the list is the
  // newest few, and exists so that a run older than the dashboard's activity
  // list still has somewhere to be reached from.
  const [runSummary, runPage, timezone, language] = await Promise.all([
    summarizeRunsForWorker(worker.id, userId),
    listRunsForWorkerPage(worker.id, userId, runCursor),
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);
  // One reading of the clock for the whole page, as the dashboard does.
  const now = new Date();
  const health = summarizeRuns(runSummary, now);
  const overdue = isRunOverdue(worker, now);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <div className="max-w-2xl">
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← {t(language, "dashboard.title")}
          </Link>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {worker.name}
            </h1>
            <Badge variant={statusVariants[worker.status]}>
              {t(language, statusKeys[worker.status])}
            </Badge>
          </div>

          <p className="mt-2 text-sm text-muted-foreground">
            {worker.description || t(language, "worker.detail.noDescription")}
          </p>

          <Card className="mt-8">
            <CardContent>
              <WorkerHealthSummary
                health={health}
                timezone={timezone}
                language={language}
              />
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardContent>
              <dl className="divide-y divide-border">
                {/* No separate Schedule row: it would restate the frequency in
                    other words. The card carries the phrased version, which is
                    the only place without a Frequency row of its own. */}
                {/* **Shown, never offered**, the same as on the edit form:
                    what a worker does is decided when it is hired and the rest
                    of it is built on that answer. A kind this version does not
                    recognise says so rather than picking one — the row exists,
                    and nothing here can honestly describe it. */}
                <Detail
                  label={t(language, "worker.detail.workerType")}
                  value={t(
                    language,
                    kind === null
                      ? "worker.detail.unrecognised"
                      : kindKeys[kind],
                  )}
                />
                <Detail
                  label={t(language, "worker.field.frequency")}
                  value={t(language, frequencyKeys[worker.frequency])}
                />
                <Detail
                  label={t(language, "worker.nextRun")}
                  value={
                    worker.nextRunAt ? (
                      <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                        {formatDateTimeWithSeconds(worker.nextRunAt, timezone)}
                        {overdue ? (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <TriangleAlert
                              className="size-3.5 shrink-0"
                              aria-hidden
                            />
                            {t(language, "overview.overdue")}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      t(language, "worker.manual")
                    )
                  }
                />
                <Detail
                  label={t(language, "worker.detail.lastRun")}
                  value={
                    health.lastRunAt
                      ? formatDateTimeWithSeconds(health.lastRunAt, timezone)
                      : t(language, "health.neverRun")
                  }
                />
                <Detail
                  label={t(language, "worker.detail.createdAt")}
                  value={formatDateTimeWithSeconds(worker.createdAt, timezone)}
                />
                <Detail
                  label={t(language, "worker.detail.updatedAt")}
                  value={formatDateTimeWithSeconds(worker.updatedAt, timezone)}
                />
              </dl>
            </CardContent>
          </Card>

          {/* **What it watches, and what it is told to do about it** — the two
              things a website worker has that the card above cannot describe.
              Nothing here fetches the address: it is the stored canonical
              string, shown as text. Whether it can be reached is asked on
              every run, in `lib/watcher`, and never by a page.

              `break-all` because an address may be thousands of characters and
              carries no spaces to wrap at; the whole of it stays selectable
              rather than being cut short. */}
          {source ? (
            <Card className="mt-4">
              <CardContent>
                <h2 className="text-sm font-medium tracking-tight">
                  {t(language, "worker.detail.watchedPage")}
                </h2>
                {/* The address is the worker's, not the product's: it is the
                    stored canonical string in either language. */}
                <p className="mt-2 text-sm break-all">{source.url}</p>

                <h2 className="mt-6 text-sm font-medium tracking-tight">
                  {t(language, "worker.changeInstructions")}
                </h2>
                <p className="mt-2 text-sm whitespace-pre-wrap break-words">
                  {worker.prompt || "—"}
                </p>
              </CardContent>
            </Card>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href={`/dashboard/workers/${worker.id}/edit`} />}
            >
              {t(language, "common.edit")}
            </Button>
            <RunRoutineButton routineId={worker.id} language={language} />
          </div>

          <section className="mt-10">
            <h2 className="text-sm font-medium tracking-tight">
              {t(language, "worker.detail.runHistory")}
            </h2>
            <WorkerRunList
              runs={runPage.runs}
              timezone={timezone}
              language={language}
              now={now}
            />

            {/* **Navigation, not an append.** Each of these loads a different
                page of the same history on the server, which is why the words
                say "older" and "latest" rather than "load more" — the list
                below is replaced, not extended.

                Kept quieter than Run, Edit and the danger zone: reaching an
                older execution is a way through the history, not a task on
                this page. */}
            {runPage.nextCursor === null && runCursor === null ? null : (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {runCursor === null ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/dashboard/workers/${worker.id}`} />}
                  >
                    {t(language, "worker.detail.backToLatestRuns")}
                  </Button>
                )}
                {runPage.nextCursor === null ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    nativeButton={false}
                    render={
                      /* Built as a query object so the timestamp's colons and
                         the id are escaped by the framework rather than by
                         hand. */
                      <Link
                        href={{
                          pathname: `/dashboard/workers/${worker.id}`,
                          query: {
                            runBefore:
                              runPage.nextCursor.startedAt.toISOString(),
                            runBeforeId: runPage.nextCursor.id,
                          },
                        }}
                      />
                    }
                  >
                    {t(language, "worker.detail.olderRuns")}
                  </Button>
                )}
              </div>
            )}
          </section>

          <section className="mt-12 border-t border-border pt-8">
            <h2 className="text-sm font-medium tracking-tight text-destructive">
              {t(language, "worker.detail.dangerZone")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(language, "worker.detail.deleteWarning")}
            </p>
            <div className="mt-4">
              {/* Leaving for the dashboard is part of the delete here: this
                  page cannot render a worker that no longer exists. */}
              <DeleteWorkerButton
                workerId={worker.id}
                workerName={worker.name}
                redirectTo="/dashboard"
                language={language}
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
