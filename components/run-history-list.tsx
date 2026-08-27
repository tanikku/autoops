import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { isRunStuck } from "@/lib/health";
import { t, type TranslationKey } from "@/lib/i18n";
import type { RecentRun, RunStatus } from "@/types";

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
  now,
}: {
  runs: RecentRun[];
  timezone: string;
  /**
   * The words around each run. **What a run produced is not among them** — an
   * output is the worker's own material and is shown exactly as it was stored.
   */
  language: string;
  /**
   * The instant every row is judged against.
   *
   * Decided once by the page rather than read per row, so two rows a
   * millisecond apart cannot land on opposite sides of the threshold — and so
   * the boundary can be tested at all.
   */
  now: Date;
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
            <div className="flex shrink-0 items-center gap-2">
              {/* **The badge still says `running`, because the row still is.**
                  Nothing here changes what is stored or what the run will be
                  recorded as; this only says that it has been running for
                  longer than one reasonably takes. */}
              {isRunStuck(run.status, run.startedAt, now) ? (
                <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                  {t(language, "health.stuck")}
                </span>
              ) : null}
              <Badge variant={statusVariants[run.status]}>
                {t(language, statusKeys[run.status])}
              </Badge>
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
