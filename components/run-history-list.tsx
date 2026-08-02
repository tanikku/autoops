import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { RunHistoryEntry, RunStatus } from "@/types";

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

function formatTimestamp(value: Date) {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

export function RunHistoryList({ runs }: { runs: RunHistoryEntry[] }) {
  if (runs.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        No activity yet. Use Run on a worker to execute it.
      </p>
    );
  }

  return (
    <Card className="mt-4">
      <CardContent className="divide-y divide-border">
        {runs.map((run) => (
          <Link
            key={run.id}
            href={`/dashboard/runs/${run.id}`}
            className="flex flex-col gap-1 py-3 outline-none first:pt-0 last:pb-0 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{run.routineName}</p>
              <p className="text-xs text-muted-foreground">
                {formatTimestamp(run.startedAt)}
                {run.output ? ` — ${run.output}` : null}
              </p>
            </div>
            <Badge variant={statusVariants[run.status]}>
              {statusLabels[run.status]}
            </Badge>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
