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
        <CardTitle>{routine.name}</CardTitle>
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
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href={`/dashboard/workers/${routine.id}/edit`} />}
        >
          Edit
        </Button>
        <RunRoutineButton routineId={routine.id} />
      </CardContent>
    </Card>
  );
}
