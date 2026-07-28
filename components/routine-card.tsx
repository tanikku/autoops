import { Badge } from "@/components/ui/badge";
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

export function RoutineCard({ routine }: { routine: Routine }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{routine.name}</CardTitle>
        <CardDescription>{routine.schedule}</CardDescription>
        <CardAction>
          <Badge variant={statusVariants[routine.status]}>
            {statusLabels[routine.status]}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex gap-2">
        <Button variant="outline" size="sm" disabled>
          Edit
        </Button>
        <Button size="sm" disabled>
          Run
        </Button>
      </CardContent>
    </Card>
  );
}
