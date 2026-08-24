import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { t, type TranslationKey } from "@/lib/i18n";
import type { RunHistoryEntry, RunStatus } from "@/types";

/** What a stored run status is called here. The values themselves do not move. */
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

export function RunHistoryList({
  runs,
  timezone,
  language,
}: {
  runs: RunHistoryEntry[];
  timezone: string;
  /**
   * The words around each run. **What a run produced is not among them** — an
   * output is the worker's own material and is shown exactly as it was stored.
   */
  language: string;
}) {
  if (runs.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {t(language, "dashboard.activityEmpty")}
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
                {formatDateTimeWithSeconds(run.startedAt, timezone)}
                {run.output ? ` — ${run.output}` : null}
              </p>
            </div>
            <Badge variant={statusVariants[run.status]}>
              {t(language, statusKeys[run.status])}
            </Badge>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
