import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { RunRoutineButton } from "@/components/run-routine-button";
import { WorkerHealthSummary } from "@/components/worker-health";
import { formatDateTime } from "@/lib/datetime";
import { NEVER_RUN, type WorkerHealth } from "@/lib/health";
import { t, type TranslationKey } from "@/lib/i18n";
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

/**
 * What a stored status is called on screen.
 *
 * **The values are the contract and the words are not.** `active` stays
 * `active` in the column, in the scheduler's `where`, and in every validator;
 * this only decides what a badge says about it.
 */
const statusKeys: Record<RoutineStatus, TranslationKey> = {
  active: "common.status.active",
  paused: "common.status.paused",
  draft: "common.status.draft",
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
  language,
}: {
  routine: Routine;
  health?: WorkerHealth;
  timezone: string;
  /** The words around the worker. Its name and description are its owner's. */
  language: string;
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
        <CardDescription>
          {scheduleLabel(
            routine.frequency,
            routine.runAtMinutes,
            routine.runAtWeekday,
            routine.runAtDay,
            language,
          )}
        </CardDescription>
        <CardAction>
          <Badge variant={statusVariants[routine.status]}>
            {t(language, statusKeys[routine.status])}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="text-xs text-muted-foreground">
        {t(language, "worker.nextRun")}:{" "}
        {routine.nextRunAt
          ? formatDateTime(routine.nextRunAt, timezone)
          : t(language, "worker.manual")}
      </CardContent>

      <CardContent>
        <WorkerHealthSummary
          health={health}
          timezone={timezone}
          language={language}
        />
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
          {t(language, "worker.view")}
        </Button>
        <RunRoutineButton routineId={routine.id} language={language} />
      </CardContent>
    </Card>
  );
}
