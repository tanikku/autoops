import { TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/datetime";
import type { WorkerOverview } from "@/lib/overview";

function SummaryCard({
  label,
  value,
  warning,
}: {
  label: string;
  value: string;
  warning?: string;
}) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-lg font-semibold tracking-tight">
          {value}
        </p>
        {warning ? (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {warning}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function OverviewCards({
  overview,
  timezone,
}: {
  overview: WorkerOverview;
  timezone: string;
}) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <SummaryCard label="Total Workers" value={String(overview.total)} />
      <SummaryCard label="Active Workers" value={String(overview.active)} />
      <SummaryCard label="Paused Workers" value={String(overview.paused)} />
      <SummaryCard
        label="Next Scheduled Run"
        value={
          overview.nextScheduledRun
            ? formatDateTime(overview.nextScheduledRun, timezone)
            : "None scheduled"
        }
        warning={
          overview.nextScheduledRunOverdue
            ? "Scheduled run is overdue"
            : undefined
        }
      />
      <SummaryCard
        label="Last Execution"
        value={
          overview.lastExecution
            ? formatDateTime(overview.lastExecution, timezone)
            : "Never"
        }
      />
    </div>
  );
}
