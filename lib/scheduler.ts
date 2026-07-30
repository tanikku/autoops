import "server-only";

import { prisma } from "@/lib/prisma";
import { toRoutine } from "@/lib/routines";
import type { Routine, RoutineStatus } from "@/types";

/**
 * A worker is enabled when its status is `active`. Paused and draft workers are
 * never due, regardless of `nextRunAt`.
 */
const ENABLED_STATUS: RoutineStatus = "active";

/**
 * Returns the workers that should run at `now`.
 *
 * This decides *what* to run and nothing else — it does not execute workers,
 * enqueue them, or touch the AI provider. That keeps it usable from any
 * trigger (cron, a queue consumer, a manual call) without changes here.
 *
 * A worker is due when it is enabled and its `nextRunAt` has passed. Workers
 * with no `nextRunAt` (manual frequency) are never due: SQL comparisons
 * against NULL are never true, so they are excluded by the same predicate.
 */
export async function getDueWorkers(now: Date): Promise<Routine[]> {
  const records = await prisma.routine.findMany({
    where: {
      status: ENABLED_STATUS,
      nextRunAt: { lte: now },
    },
    orderBy: { nextRunAt: "asc" },
  });

  return records.map(toRoutine);
}
