import "server-only";

import { readPreTrialAiProcessing } from "@/lib/entitlements/start-trial";
import { getEffectiveEntitlement } from "@/lib/entitlements/index";
import { getPlanDefinition } from "@/lib/plans";
import { prisma } from "@/lib/prisma";
import { getUsageSnapshot, type UsageCounterSnapshot } from "@/lib/usage/snapshot";
import { usageKinds } from "@/lib/usage/types";

/**
 * What a screen needs to say about an account's trial, worked out once.
 *
 * **The arithmetic is here so that it is not in a component.** Which period
 * counts, what a counter is measured against, how close it is to its limit and
 * how much of the fortnight is left are all answers this codebase already has
 * — in `resolveUsageSnapshotWindow`, `usageStatusFor` and `computeEntitlement`.
 * A React component recomputing any of them would be a second opinion, and the
 * two would drift the day one of them was changed.
 *
 * **It reads and never writes.** Looking at a trial must not open a period,
 * start one, or touch a counter; an account that has done nothing has no rows,
 * which is the truth rather than a gap to fill in.
 *
 * **Nothing here enforces anything.** The statuses below are descriptions for
 * a screen. No run stops, no draft fails, and an account reading "over the
 * limit" works exactly as it did the day before — see `consumeUsage`, which is
 * the shape enforcement will need and which nothing calls.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How a number reads against the limit it is shown beside. */
export type TrialUsageStatus =
  | "normal"
  | "approaching"
  /** Exactly at the limit: spent, and spent by ordinary use. */
  | "reached"
  /** Past it. Only reachable through the carry-in — see `preTrialAiUsed`. */
  | "over";

/** One allowance, ready to render as `used / limit`. */
export type TrialUsageLine = {
  readonly kind: string;
  readonly used: number;
  readonly limit: number;
  readonly status: TrialUsageStatus;
};

/**
 * What to show, or that there is nothing to show.
 *
 * **Four cases and one of them is silence.** An account on the granted beta
 * allowance, or on a plan it bought, is not on a trial and must not be told
 * anything about one — see `hidden`, which is what every state that is not a
 * trial resolves to.
 */
export type TrialUsageView =
  /** Not a trial account. No trial wording anywhere. */
  | { readonly kind: "hidden" }
  /**
   * No entitlement yet, so the trial has not begun.
   *
   * `aiUsed` is what the account has already spent on AI processing, which
   * will arrive with the trial when it starts. It is read through the same
   * function the trial start uses, so the sentence on the form and the number
   * written into the counter cannot disagree.
   */
  | {
      readonly kind: "pre-trial";
      readonly aiUsed: number;
      readonly aiLimit: number;
    }
  | {
      readonly kind: "active";
      /** Whole days left, rounded up: a trial with an hour to run says one. */
      readonly daysRemaining: number;
      readonly lines: readonly TrialUsageLine[];
      readonly activeWorkers: number;
      readonly activeWorkerLimit: number;
      readonly activeWorkerStatus: TrialUsageStatus;
      /** Whether the AI line is past its limit because of the carry-in. */
      readonly carriedInOverLimit: boolean;
    }
  /** The fourteen days are over. Nothing was deleted and nobody was charged. */
  | { readonly kind: "expired" };

/**
 * Where a used-against-limit number falls, in the words a screen uses.
 *
 * **The thresholds are not chosen here.** `usageStatusFor` already decides
 * them — under four fifths, from four fifths, and at or past the limit — and
 * this only splits its last answer in two: spending exactly an allowance and
 * arriving already past it are the same arithmetic and very different things
 * to read.
 */
export function describeStatus(used: number, limit: number): TrialUsageStatus {
  if (used > limit) {
    return "over";
  }

  if (used === limit) {
    return "reached";
  }

  // Below the limit, so the only question left is how close — which is the
  // one `usageStatusFor` answers.
  return limit > 0 && used / limit >= 0.8 ? "approaching" : "normal";
}

/** Counters in the order the kinds are declared, with zeroes for any missing. */
function linesFrom(
  counters: readonly UsageCounterSnapshot[] | null,
): TrialUsageLine[] {
  const stored = new Map(counters?.map((counter) => [counter.kind, counter]));

  return usageKinds.map((kind) => {
    const counter = stored.get(kind);
    // A trial always opens all three at once, so a missing one means the
    // period has not been read rather than that a limit is unknown. The plan's
    // number is what the counter would have been opened with.
    const limit = counter?.limit ?? planLimit(kind);
    const used = counter?.used ?? 0;

    return { kind, used, limit, status: describeStatus(used, limit) };
  });
}

function planLimit(kind: (typeof usageKinds)[number]): number {
  const trial = getPlanDefinition("trial");

  switch (kind) {
    case "aiProcessing":
      return trial.aiProcessingLimit;
    case "manualRun":
      return trial.manualRunLimit;
    case "discovery":
      return trial.discoveryLimit;
  }
}

/**
 * How much of the fortnight is left, in whole days.
 *
 * **Rounded up, and never below zero.** A trial with six hours to run has a
 * day left rather than none: rounding down would show "0日" for the whole of
 * the last day, which reads as over while it is still running. A trial already
 * finished is not described by this — see the `expired` case.
 */
function daysRemaining(endsAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / MS_PER_DAY));
}

/**
 * Everything one account's trial surfaces need, in one read.
 *
 * **The state decides, not the plan name.** `computeEntitlement` is what knows
 * whether a fortnight is still running, and it works that out from the row and
 * the clock rather than from anything stored — so a trial that ended overnight
 * says so without anything having run at midnight.
 */
export async function getTrialUsageView(
  userId: string,
  now: Date = new Date(),
): Promise<TrialUsageView> {
  const entitlement = await getEffectiveEntitlement(userId, now);

  if (entitlement.state === "none") {
    return {
      kind: "pre-trial",
      aiUsed: await readPreTrialAiProcessing(prisma, userId),
      aiLimit: getPlanDefinition("trial").aiProcessingLimit,
    };
  }

  if (entitlement.state === "trial_expired") {
    return { kind: "expired" };
  }

  // **Everything else is somebody else's entitlement.** The granted beta
  // cohort, a plan somebody bought, a grant that has run out: none of them is
  // a trial, and none of them may be shown trial wording.
  if (entitlement.state !== "trialing" || entitlement.trial?.endsAt == null) {
    return { kind: "hidden" };
  }

  const snapshot = await getUsageSnapshot(userId, now);
  const activeWorkerLimit = snapshot.activeWorkerLimit;
  const lines = linesFrom(snapshot.counters);

  return {
    kind: "active",
    daysRemaining: daysRemaining(entitlement.trial.endsAt, now),
    lines,
    activeWorkers: snapshot.activeWorkers,
    activeWorkerLimit,
    // **Current state, not consumption.** How many workers are active is
    // however many there are right now; it goes up and down, and no counter
    // holds it.
    activeWorkerStatus: describeStatus(snapshot.activeWorkers, activeWorkerLimit),
    carriedInOverLimit:
      lines.find((line) => line.kind === "aiProcessing")?.status === "over",
  };
}
