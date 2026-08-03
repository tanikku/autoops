import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { RunRoutineButton } from "@/components/run-routine-button";
import { WorkerHealthSummary } from "@/components/worker-health";
import { formatDateTime } from "@/lib/datetime";
import { NEVER_RUN, type WorkerHealth } from "@/lib/health";
import { scheduleLabel } from "@/lib/schedule-label";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Routine, RoutineStatus } from "@/types";

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

export function RoutineCard({
  routine,
  health = NEVER_RUN,
  timezone,
}: {
  routine: Routine;
  health?: WorkerHealth;
  timezone: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Link
            href={`/dashboard/workers/${routine.id}`}
            className="outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {routine.name}
          </Link>
        </CardTitle>
        <CardDescription>{scheduleLabel(routine.frequency)}</CardDescription>
        <CardAction>
          <Badge variant={statusVariants[routine.status]}>
            {statusLabels[routine.status]}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="text-xs text-muted-foreground">
        Next Run:{" "}
        {routine.nextRunAt
          ? formatDateTime(routine.nextRunAt, timezone)
          : "Manual"}
      </CardContent>

      <CardContent>
        <WorkerHealthSummary health={health} timezone={timezone} />
      </CardContent>

      <CardContent className="flex gap-2">
        {/* Edit and Delete moved to the detail page, which is now the hub for
            everything you can do to a worker. */}
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href={`/dashboard/workers/${routine.id}`} />}
        >
          View
        </Button>
        <RunRoutineButton routineId={routine.id} />
      </CardContent>
    </Card>
  );
}
