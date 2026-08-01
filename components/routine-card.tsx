import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { RunRoutineButton } from "@/components/run-routine-button";
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

function formatNextRun(value: Date) {
  return value.toISOString().slice(0, 16).replace("T", " ");
}

export function RoutineCard({ routine }: { routine: Routine }) {
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
        <CardDescription>{routine.schedule || "No schedule"}</CardDescription>
        <CardAction>
          <Badge variant={statusVariants[routine.status]}>
            {statusLabels[routine.status]}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="text-xs text-muted-foreground">
        Next Run:{" "}
        {routine.nextRunAt ? formatNextRun(routine.nextRunAt) : "Manual"}
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
