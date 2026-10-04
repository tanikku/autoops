import { allowanceRefusalOfRun } from "@/lib/usage/ai-allowance";
import { THROTTLED_MESSAGE } from "@/lib/watcher/errors";

/**
 * Whether a failure email would be the second one about the same trouble.
 *
 * **The worker's state, not the error's.** A fetch failure followed by a
 * provider failure is still a worker that has not worked since it was last
 * reported broken; mailing again because the wording changed would be exactly
 * the repeated email this exists to stop. A completed run of any kind — an
 * unchanged page, a change nobody waited for, a prompt answered — is a worker
 * that worked, and the next failure is news again.
 *
 * **Only the email.** Nothing here touches a run: every failure stays on the
 * worker's history exactly as it was recorded.
 */

/**
 * How many earlier runs are looked at, newest first.
 *
 * **A bound, not a guess at the answer.** Silent failures are skipped, so a
 * worker whose last twenty runs were all silent has said nothing about whether
 * it was working; that reads as "unknown", and unknown sends — a missed
 * failure email costs more than one extra.
 */
export const FAILURE_STREAK_LOOKBACK = 20;

export type EarlierRun = {
  readonly status: string;
  readonly errorMessage: string | null;
};

/**
 * A failure nobody is emailed about.
 *
 * An allowance refusal and a throttled fetch both end a run as `failed` only
 * because a run has no other way to finish. Neither starts a streak — the
 * worker may be fine — and neither ends one — it has not worked either.
 */
export function isSilentFailure(run: EarlierRun): boolean {
  return (
    run.status === "failed" &&
    (allowanceRefusalOfRun(run) !== null || run.errorMessage === THROTTLED_MESSAGE)
  );
}

/**
 * Whether the earlier runs, newest first, show the worker already failing.
 *
 * The first run that is not a silent failure decides: `failed` means the
 * owner was already told, anything else — completed, still running, or nothing
 * at all within the bound — means this failure is the first.
 */
export function continuesFailureStreak(earlier: readonly EarlierRun[]): boolean {
  const meaningful = earlier.find((run) => !isSilentFailure(run));

  return meaningful?.status === "failed";
}
