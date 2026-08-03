import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardNav } from "@/components/dashboard-nav";
import { DeleteWorkerButton } from "@/components/delete-worker-button";
import { RunRoutineButton } from "@/components/run-routine-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WorkerHealthSummary } from "@/components/worker-health";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { summarizeRuns } from "@/lib/health";
import { getRoutine } from "@/lib/routines";
import { listRunsForWorker } from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";
import type { RoutineFrequency, RoutineStatus } from "@/types";

export const metadata: Metadata = {
  title: "Worker — AutoOps",
  description: "A worker and its schedule.",
};

// Workers live in the database, so this page must not be prerendered.
export const dynamic = "force-dynamic";

const statusLabels: Record<RoutineStatus, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
};

const statusVariants: Record<
  RoutineStatus,
  React.ComponentProps<typeof Badge>["variant"]
> = {
  active: "default",
  paused: "secondary",
  draft: "outline",
};

const frequencyLabels: Record<RoutineFrequency, string> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};


function Detail({ label, value }: { label: string; value: string }) {
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
  const worker = await getRoutine(id, userId);

  if (!worker) {
    notFound();
  }

  // One query for the worker's runs, folded into the same summary the
  // dashboard card shows.
  const [runs, timezone] = await Promise.all([
    listRunsForWorker(worker.id, userId),
    getUserTimezone(userId),
  ]);
  const health = summarizeRuns(runs);

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <div className="max-w-2xl">
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← My AI Team
          </Link>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {worker.name}
            </h1>
            <Badge variant={statusVariants[worker.status]}>
              {statusLabels[worker.status]}
            </Badge>
          </div>

          <p className="mt-2 text-sm text-muted-foreground">
            {worker.description || "No description."}
          </p>

          <Card className="mt-8">
            <CardContent>
              <WorkerHealthSummary health={health} timezone={timezone} />
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardContent>
              <dl className="divide-y divide-border">
                {/* No separate Schedule row: it would restate the frequency in
                    other words. The card carries the phrased version, which is
                    the only place without a Frequency row of its own. */}
                <Detail
                  label="Frequency"
                  value={frequencyLabels[worker.frequency]}
                />
                <Detail
                  label="Next Run"
                  value={
                    worker.nextRunAt
                      ? formatDateTimeWithSeconds(worker.nextRunAt, timezone)
                      : "Manual"
                  }
                />
                <Detail
                  label="Last Run"
                  value={
                    health.lastRunAt
                      ? formatDateTimeWithSeconds(health.lastRunAt, timezone)
                      : "Never run"
                  }
                />
                <Detail
                  label="Created At"
                  value={formatDateTimeWithSeconds(worker.createdAt, timezone)}
                />
                <Detail
                  label="Updated At"
                  value={formatDateTimeWithSeconds(worker.updatedAt, timezone)}
                />
              </dl>
            </CardContent>
          </Card>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href={`/dashboard/workers/${worker.id}/edit`} />}
            >
              Edit
            </Button>
            <RunRoutineButton routineId={worker.id} />
          </div>

          <section className="mt-12 border-t border-border pt-8">
            <h2 className="text-sm font-medium tracking-tight text-destructive">
              Danger zone
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Deleting this worker also removes its activity history. This
              cannot be undone.
            </p>
            <div className="mt-4">
              {/* Leaving for the dashboard is part of the delete here: this
                  page cannot render a worker that no longer exists. */}
              <DeleteWorkerButton
                workerId={worker.id}
                workerName={worker.name}
                redirectTo="/dashboard"
              />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
