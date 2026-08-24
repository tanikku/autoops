import { TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/datetime";
import { t } from "@/lib/i18n";
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
  language,
}: {
  overview: WorkerOverview;
  timezone: string;
  /**
   * **The words, not the numbers.** Counts and timestamps read the same in
   * every language, and the timestamps keep the format `formatDateTime`
   * already gives them.
   */
  language: string;
}) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <SummaryCard
        label={t(language, "overview.total")}
        value={String(overview.total)}
      />
      <SummaryCard
        label={t(language, "overview.active")}
        value={String(overview.active)}
      />
      <SummaryCard
        label={t(language, "overview.paused")}
        value={String(overview.paused)}
      />
      <SummaryCard
        label={t(language, "overview.nextScheduledRun")}
        value={
          overview.nextScheduledRun
            ? formatDateTime(overview.nextScheduledRun, timezone)
            : t(language, "overview.noneScheduled")
        }
        warning={
          overview.nextScheduledRunOverdue
            ? t(language, "overview.overdue")
            : undefined
        }
      />
      <SummaryCard
        label={t(language, "overview.lastExecution")}
        value={
          overview.lastExecution
            ? formatDateTime(overview.lastExecution, timezone)
            : t(language, "overview.neverExecuted")
        }
      />
    </div>
  );
}
