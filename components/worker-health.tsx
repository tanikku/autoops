import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Loader,
  TriangleAlert,
} from "lucide-react";
import { formatDateTime } from "@/lib/datetime";
import type { WorkerHealth } from "@/lib/health";
import type { RunStatus } from "@/types";

const resultStyles: Record<
  RunStatus,
  { label: string; className: string; Icon: typeof CircleCheck }
> = {
  completed: {
    label: "Success",
    className: "text-emerald-600 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  failed: {
    label: "Failed",
    className: "text-destructive",
    Icon: CircleAlert,
  },
  running: {
    label: "Running",
    className: "text-muted-foreground",
    Icon: Loader,
  },
};

const neverRun = {
  label: "Never run",
  className: "text-muted-foreground",
  Icon: CircleDashed,
};

export function WorkerHealthSummary({
  health,
  timezone,
}: {
  health: WorkerHealth;
  timezone: string;
}) {
  const { label, className, Icon } = health.lastResult
    ? resultStyles[health.lastResult]
    : neverRun;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="font-medium text-muted-foreground">Health</p>

      <p className={`flex items-center gap-1.5 ${className}`}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">{label}</span>
        {health.lastRunAt ? (
          <span className="text-muted-foreground">
            {formatDateTime(health.lastRunAt, timezone)}
          </span>
        ) : null}
      </p>

      {health.stuck ? (
        <p className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          Running for longer than expected
        </p>
      ) : null}

      <p className="text-muted-foreground">
        {health.totalRuns} run{health.totalRuns === 1 ? "" : "s"} ·{" "}
        {health.totalFailures} failure{health.totalFailures === 1 ? "" : "s"}
      </p>
    </div>
  );
}
