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
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { summarizeRuns } from "@/lib/health";
import { t, type TranslationKey } from "@/lib/i18n";
import { isRunOverdue } from "@/lib/overview";
import { getRoutineWithStoredKind } from "@/lib/routines";
import { summarizeRunsForWorker } from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";
import { getWebsiteSource } from "@/lib/website-sources";
import type { RoutineFrequency, RoutineKind, RoutineStatus } from "@/types";

export const metadata: Metadata = {
  title: "Worker — AutoOps",
  description: "A worker and its schedule.",
};

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

export default async function WorkerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
  const [runSummary, timezone, language] = await Promise.all([
    summarizeRunsForWorker(worker.id, userId),
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);
  const health = summarizeRuns(runSummary);
  const overdue = isRunOverdue(worker);

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
