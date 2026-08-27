import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeWithSeconds } from "@/lib/datetime";
import { t, type TranslationKey } from "@/lib/i18n";
import type { RunStatus, WorkerRun } from "@/types";

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

/**
 * A worker's own runs, newest first.
 *
 * **A route rather than a report.** Everything worth knowing about a run — what
 * it produced, and the reason a failed one gives — is on the execution's own
 * page, and this exists because that page had become unreachable: the account's
 * activity list is bounded to the newest twenty, so a failure older than that
 * was still recorded and no longer named anywhere somebody could click.
 *
 * **Deliberately not `RunHistoryList`.** That one is the dashboard's, and it
 * carries the two things this must not: the worker's name, which is the heading
 * of the page this sits on, and the run's output, which belongs to the run.
 * The lists look alike because they are both lists of runs; what they are for
 * is different, and sharing one component would mean deciding which of the two
 * jobs it does.
 */
export function WorkerRunList({
  runs,
  timezone,
  language,
}: {
  runs: WorkerRun[];
  timezone: string;
  language: string;
}) {
  if (runs.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {t(language, "worker.detail.runHistoryEmpty")}
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
            className="flex items-center justify-between gap-4 py-3 outline-none first:pt-0 last:pb-0 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <p className="min-w-0 truncate text-sm">
              {formatDateTimeWithSeconds(run.startedAt, timezone)}
            </p>
            <Badge variant={statusVariants[run.status]}>
              {t(language, statusKeys[run.status])}
            </Badge>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
