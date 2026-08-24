import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { t, type TranslationKey } from "@/lib/i18n";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import { getRun } from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";
import type { RunStatus } from "@/types";

export const metadata: Metadata = {
  title: "Execution — AutoOps",
  description: "Details of a single worker execution.",
};

// Runs live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

/** What one execution ended as. The stored values are unchanged by any of this. */
const statusKeys: Record<RunStatus, TranslationKey> = {
  running: "common.runStatus.running",
  completed: "common.runStatus.completed",
  failed: "common.runStatus.failed",
};

const statusVariants: Record<
  RunStatus,
  React.ComponentProps<typeof Badge>["variant"]
> = {
  running: "secondary",
  completed: "default",
  failed: "destructive",
};

function formatTimestamp(value: Date | null, timezone: string) {
  return value ? formatDateTimeWithSeconds(value, timezone) : "—";
}

function formatDuration(startedAt: Date, finishedAt: Date | null) {
  if (!finishedAt) {
    return "—";
  }
  return `${((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(2)}s`;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{value}</dd>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium tracking-tight">{label}</h2>
      <pre className="mt-2 overflow-x-auto rounded-xl bg-muted p-4 text-sm whitespace-pre-wrap">
        {value || "—"}
      </pre>
    </section>
  );
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await requireUserId();
  // A run owned by someone else is indistinguishable from one that does not
  // exist: both 404, so the id is never confirmed.
  // **The language names the sections and nothing inside them.** What a run
  // produced, and the reason a failed one gives, are stored text — the
  // provider's words or a driver's — and are shown exactly as recorded.
  const [run, timezone, language] = await Promise.all([
    getRun(id, userId),
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);

  if (!run) {
    notFound();
  }

  // **Only a prompt run has a rendered prompt to show.**
  //
  // What a prompt run sends is the worker's prompt with its variables filled
  // in, and nothing else — so reconstructing it from the values the run would
  // have seen when it started reproduces the request faithfully, which is why
  // it is not stored.
  //
  // A website run sends something else entirely: a system instruction the
  // platform writes, the worker's instructions inside it, and a bounded
  // excerpt of what actually changed on the page. **None of that is stored**,
  // and the excerpt could not be reconstructed at any price — the page has
  // moved on. Running the same reconstruction here would produce a plausible
  // block of text under a heading claiming it is what was sent, which is worse
  // than showing nothing: it would be wrong in a way nobody could detect.
  //
  // A kind this version does not recognise gets the same silence, for the same
  // reason — a guess about which of the two it was is still a guess.
  const renderedPrompt =
    run.routineKind === "prompt"
      ? renderPrompt(run.routinePrompt, promptVariables(run.startedAt))
      : null;

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 sm:px-10">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/dashboard" />}
          className="-ml-2.5"
        >
          ← {t(language, "run.detail.back")}
        </Button>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "run.detail.title")}
        </h1>

        <dl className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label={t(language, "run.detail.worker")}
            value={run.routineName}
          />
          <Field
            label={t(language, "common.statusLabel")}
            value={
              <Badge variant={statusVariants[run.status]}>
                {t(language, statusKeys[run.status])}
              </Badge>
            }
          />
          <Field
            label={t(language, "run.detail.executionTime")}
            value={formatDuration(run.startedAt, run.finishedAt)}
          />
          <Field
            label={t(language, "run.detail.startedAt")}
            value={formatTimestamp(run.startedAt, timezone)}
          />
          <Field
            label={t(language, "run.detail.finishedAt")}
            value={formatTimestamp(run.finishedAt, timezone)}
          />
        </dl>

        {/* The same column, and two different things in it. A prompt worker's
            is the instruction the run sends; a website worker's is what to do
            about a change once one has been found. Naming both "Prompt" was
            accurate for one of them. */}
        {run.routineKind === null ? null : (
          <Block
            label={t(
              language,
              run.routineKind === "website"
                ? "worker.changeInstructions"
                : "worker.prompt",
            )}
            value={run.routinePrompt}
          />
        )}
        {renderedPrompt === null ? null : (
          <Block
            label={t(language, "run.detail.renderedPrompt")}
            value={renderedPrompt}
          />
        )}
        {/*
          A failed run has no output, and calling its reason one was the older
          shape of this page: the two shared a column, so the heading described
          whichever had been written. They are separate now, and this is the
          one screen the diagnostic belongs on — it is the provider's wording,
          or a driver's, and it is read by someone who came here to find out
          what went wrong. The activity list deliberately shows neither.
        */}
        {run.status === "failed" ? (
          <Block
            label={t(language, "run.detail.error")}
            value={run.errorMessage ?? ""}
          />
        ) : (
          <Block label={t(language, "run.detail.output")} value={run.output} />
        )}
      </main>
    </div>
  );
}
