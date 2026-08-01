import { Card, CardContent } from "@/components/ui/card";
import type { WorkerOverview } from "@/lib/overview";

function formatTimestamp(value: Date) {
  return value.toISOString().slice(0, 16).replace("T", " ");
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-lg font-semibold tracking-tight">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

export function OverviewCards({ overview }: { overview: WorkerOverview }) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <SummaryCard label="Total Workers" value={String(overview.total)} />
      <SummaryCard label="Active Workers" value={String(overview.active)} />
      <SummaryCard label="Paused Workers" value={String(overview.paused)} />
      <SummaryCard
        label="Next Scheduled Run"
        value={
          overview.nextScheduledRun
            ? formatTimestamp(overview.nextScheduledRun)
            : "None scheduled"
        }
      />
      <SummaryCard
        label="Last Execution"
        value={
          overview.lastExecution
            ? formatTimestamp(overview.lastExecution)
            : "Never"
        }
      />
    </div>
  );
}
