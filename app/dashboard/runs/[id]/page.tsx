import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import { getRun } from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";
import type { RunStatus } from "@/types";

export const metadata: Metadata = {
  title: "Execution — AutoOps",
  description: "Details of a single worker execution.",
};

// Runs live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

const statusLabels: Record<RunStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
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
  const [run, timezone] = await Promise.all([
    getRun(id, userId),
    getUserTimezone(userId),
  ]);

  if (!run) {
    notFound();
  }

  // The rendered prompt is not stored, so it is reconstructed from the values
  // the run would have seen when it started.
  const renderedPrompt = renderPrompt(
    run.routinePrompt,
    promptVariables(run.startedAt),
  );

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
          ← Back to Dashboard
        </Button>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          Execution
        </h1>

        <dl className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Worker" value={run.routineName} />
          <Field
            label="Status"
            value={
              <Badge variant={statusVariants[run.status]}>
                {statusLabels[run.status]}
              </Badge>
            }
          />
          <Field
            label="Execution Time"
            value={formatDuration(run.startedAt, run.finishedAt)}
          />
          <Field
            label="Started At"
            value={formatTimestamp(run.startedAt, timezone)}
          />
          <Field
            label="Finished At"
            value={formatTimestamp(run.finishedAt, timezone)}
          />
        </dl>

        <Block label="Prompt" value={run.routinePrompt} />
        <Block label="Rendered Prompt" value={renderedPrompt} />
        {/*
          A failed run has no output, and calling its reason one was the older
          shape of this page: the two shared a column, so the heading described
          whichever had been written. They are separate now, and this is the
          one screen the diagnostic belongs on — it is the provider's wording,
          or a driver's, and it is read by someone who came here to find out
          what went wrong. The activity list deliberately shows neither.
        */}
        {run.status === "failed" ? (
          <Block label="Error" value={run.errorMessage ?? ""} />
        ) : (
          <Block label="Output" value={run.output} />
        )}
      </main>
    </div>
  );
}
