import "server-only";

import { runRoutine } from "@/lib/runs";
import type { RunHistory } from "@/types";

/**
 * Entry point for executing a routine.
 *
 * Execution runs inline for now; the indirection exists so a real queue can be
 * introduced later without touching callers.
 *
 * **Hands off and reports back what happened — it does not judge it.** A run
 * that fails comes back as a `failed` record rather than an exception, because
 * recording the outcome belongs to `runRoutine` and reacting to it belongs to
 * whoever asked. Callers that care must read `status`; callers that only needed
 * the work started can ignore the result entirely.
 *
 * A real queue backend would keep that shape: accepting the work is what
 * succeeds or fails here, not the work itself.
 */
export async function enqueueRoutine(routineId: string): Promise<RunHistory> {
  return runRoutine(routineId);
}
