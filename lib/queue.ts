import "server-only";

import { runRoutine } from "@/lib/runs";
import type { RunHistory } from "@/types";

/**
 * Entry point for executing a routine.
 *
 * Execution runs inline for now; the indirection exists so a real queue can be
 * introduced later without touching callers.
 */
export async function enqueueRoutine(routineId: string): Promise<RunHistory> {
  return runRoutine(routineId);
}
