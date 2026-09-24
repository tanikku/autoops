import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { DashboardNav } from "@/components/dashboard-nav";
import { RunOutputMarkdown } from "@/components/run-output-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { formatRunOutputForDisplay } from "@/lib/run-display";
import { isRunStuck } from "@/lib/health";
import { t, type TranslationKey } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import { getRun } from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUserLanguage, getUserTimezone } from "@/lib/users";
import type { RunStatus } from "@/types";

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
    title: `${t(language, "run.detail.title")} — Koqentra`,
    description: t(language, "run.detail.metadataDescription"),
  };
}

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

function Block({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <section className={className ?? "mt-8"}>
      <h2 className="text-sm font-medium tracking-tight">{label}</h2>
      {/* **`break-words` and `leading-relaxed` are the mobile fix.** A long URL
          or an unbroken run of characters used to push the panel wider than the
          phone, and the default line height made several screens of model
          output hard to follow. Wrapping is still preserved — what a model
          wrote is shown as it wrote it. */}
      <pre className="mt-2 overflow-x-auto rounded-xl bg-muted p-4 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {value || "—"}
      </pre>
    </section>
  );
}

/**
 * What a model wrote, rendered rather than displayed as source.
 *
 * **Separate from `Block` because the two carry different things.** A stored
 * diagnostic is shown exactly as it was recorded; a model's answer was written
 * to be read, and showing its `##` and `|` as literal characters was the
 * complaint this fixes.
 *
 * **Empty output keeps the dash.** A run that produced nothing is a run that
 * produced nothing, and sending an empty string through a Markdown renderer
 * would show an empty panel instead of saying so.
 */
function OutputBlock({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <section className={className ?? "mt-8"}>
      <h2 className="text-sm font-medium tracking-tight">{label}</h2>
      <div className="mt-2 rounded-xl bg-muted p-4">
        {value ? <RunOutputMarkdown>{value}</RunOutputMarkdown> : <p className="text-sm">—</p>}
      </div>
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

  // One reading of the clock, as the pages that list runs do.
  const now = new Date();

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

        {/* **The result first, because the result is why anybody is here.**
            A notification said something happened; the next question is what.
            The metadata and the instructions used to come first and pushed the
            answer below the fold on a phone — they are still here, further
            down, where an audit looks for them. */}
        {/* **A failure's reason stays plain text, and that is deliberate.** It
            is a provider's sentence or a driver's — a diagnostic, not something
            written to be read as a document — and putting it through a Markdown
            renderer would let its own punctuation restructure it. An underscore
            in a stack trace is not emphasis. */}
        {run.status === "failed" ? (
          <Block
            className="mt-6"
            label={t(language, "run.detail.error")}
            value={run.errorMessage ?? ""}
          />
        ) : (
          <OutputBlock
            className="mt-6"
            label={t(language, "run.detail.output")}
            /* The same reading as the activity list makes: Koqentra' own two
               sentences are shown in the account's language, and a model's
               answer is shown as it was written — now rendered rather than
               displayed as source. */
            value={formatRunOutputForDisplay(
              run.output,
              run.routineKind,
              language,
            )}
          />
        )}

        {/* Directly under the result, where somebody who has just read that a
            page changed will look for the page. Absent entirely for a worker
            that watches nothing. */}
        {/* **The point of the whole screen, for a watcher.** Somebody who came
            here from a notification saying a page moved is usually going to
            that page next; sending them back through the worker's settings to
            recover an address they configured weeks ago is friction charged
            against the thing they came to do.

            **`noreferrer` as well as `noopener`.** The destination is a page
            the owner chose, and it has no business learning which run of which
            worker sent somebody to it.

            **Written inline rather than as a component** so that the address
            and its `rel` are visible in the page's own element tree — which is
            what this screen's tests read. */}
        {run.monitoredUrl === null ? null : (
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={
                <a
                  href={run.monitoredUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                />
              }
            >
              <ExternalLink className="size-4 shrink-0" aria-hidden />
              {t(language, "run.detail.openMonitored")}
            </Button>
            {/* The address itself, because somebody deciding whether to follow
                a link is owed the chance to see where it goes. */}
            <p className="mt-2 text-xs break-all text-muted-foreground">
              {run.monitoredUrl}
            </p>
          </div>
        )}

        {/* **Compact, and below the answer.** Two columns on a phone rather
            than one long stack: these are short values, and giving each its own
            full-width row was most of the scrolling. */}
        <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          <Field
            label={t(language, "run.detail.worker")}
            value={run.routineName}
          />
          {/* **A note beside the status, not a status of its own.** The run
              is still `running` and is still recorded that way: nothing here
              writes a finish time, invents a reason, or calls it failed. What
              it says is that the row has been in this state for longer than a
              run reasonably takes — which is the same thing the worker's health
              summary says about it, from the same threshold. */}
          <Field
            label={t(language, "common.statusLabel")}
            value={
              <span className="flex flex-col items-start gap-1">
                <Badge variant={statusVariants[run.status]}>
                  {t(language, statusKeys[run.status])}
                </Badge>
                {isRunStuck(run.status, run.startedAt, now) ? (
                  <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                    {t(language, "health.stuck")}
                  </span>
                ) : null}
              </span>
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
            accurate for one of them.

            **Last, because it is the audit rather than the answer.** It does
            not change between runs, and somebody who has just been notified
            almost never wants it — but somebody checking why a run said what
            it said always does, so it stays on the page. */}
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
      </main>
    </div>
  );
}
