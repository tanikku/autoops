import "server-only";

import { getPlanDefinition } from "@/lib/plans";
import { prisma } from "@/lib/prisma";
import {
  observationWindowFor,
  resolveUsageSnapshotWindow,
} from "@/lib/usage/observe";
import { usageKinds, type UsageKind } from "@/lib/usage/types";

/**
 * What an account has used in its current period, read rather than enforced.
 *
 * **Nothing calls this to decide anything.** It answers a question an operator
 * has — how close is anybody to what a plan would allow — and it is the only
 * place the counters and the yardstick are put side by side. No worker, no
 * action and no screen reads it to refuse something; see `lib/usage/observe.ts`
 * for why that separation is the point of this phase.
 *
 * **`overLimit` is a description, not an event.** An account past a limit is
 * still running exactly as it was, nobody is emailed, and nothing is shown.
 */

/** How close one counter is to the number it is compared against. */
export type UsageStatus = "normal" | "warning80" | "overLimit";

/** One allowance, as it stands. */
export type UsageCounterSnapshot = {
  readonly kind: UsageKind;
  readonly used: number;
  /** What a plan would allow. **A comparison, not a rule.** */
  readonly limit: number;
  /** `used / limit`, rounded to whole per cent. */
  readonly percent: number;
  readonly status: UsageStatus;
};

/** An account's current period, and what it spent in it. */
export type UsageSnapshot = {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /**
   * Which plan's numbers this was compared against.
   *
   * `trial` for an account inside its trial, and otherwise the observation
   * yardstick — see `OBSERVATION_PLAN` and `resolveUsageWindow`.
   */
  readonly planBaseline: string;
  /**
   * Whether the counters cover the whole period.
   *
   * **True until a period begins after observation did.** Counting started
   * part-way through a month, so this month's numbers are not that month's
   * total — and a number that looks like a total but is not would be worse than
   * no number. It is derived from when the period row was created rather than
   * from a column: a period whose row was written after its own start was
   * opened by the first use somebody made of it, which is exactly what partial
   * means.
   */
  readonly partialPeriod: boolean;
  /** Null when this account has done nothing observable this month. */
  readonly counters: readonly UsageCounterSnapshot[] | null;
  /**
   * How many workers are active right now.
   *
   * **Current state, not consumption**, which is why it has no counter: a month
   * does not accumulate active workers, it has however many it has at the
   * moment somebody asks.
   */
  readonly activeWorkers: number;
  readonly activeWorkerLimit: number;
};

/** Where a used-against-limit ratio falls. */
export function usageStatusFor(used: number, limit: number): UsageStatus {
  // A limit of nothing cannot be a fraction of anything; anything spent
  // against it is already past it.
  if (limit <= 0) {
    return used > 0 ? "overLimit" : "normal";
  }

  const ratio = used / limit;

  if (ratio >= 1) {
    return "overLimit";
  }

  return ratio >= 0.8 ? "warning80" : "normal";
}

/** What a plan allows for one kind. */
function limitFor(plan: string, kind: UsageKind): number {
  const definition = getPlanDefinition(plan);

  switch (kind) {
    case "aiProcessing":
      return definition.aiProcessingLimit;
    case "manualRun":
      return definition.manualRunLimit;
    case "discovery":
      return definition.discoveryLimit;
  }
}

/**
 * One account's observation month.
 *
 * **Reads and never writes.** Asking what somebody has used must not open a
 * period for them: a month with no row is an account that did nothing, and
 * creating one to answer a question would turn looking into using.
 */
export async function getUsageSnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<UsageSnapshot> {
  // **Which period to look at, which is not always where counting goes.** A
  // finished trial is written to no longer and read from still: its counters
  // are the record of the fortnight, and `50 / 20 / 14` has to stay answerable
  // after the fourteen days. See `resolveUsageSnapshotWindow`.
  const window = await resolveUsageSnapshotWindow(userId, now);

  // **Nothing is read at all when there is no period to read.** A trial whose
  // dates are unreadable must not have the calendar month looked up on its
  // behalf: the row that came back could be this account's own pre-trial
  // drafting, counted against beta's numbers, and returning it here would
  // present it as what the trial used.
  if (window.kind === "none") {
    return {
      // **The current month as a frame for the screen, not as a period.** It is
      // derivable without a row and obviously not a billing cycle; what says
      // nothing was counted is `counters: null`, immediately below.
      ...observationWindowFor(now),
      planBaseline: window.plan,
      partialPeriod: true,
      counters: null,
      activeWorkers: await prisma.routine.count({
        where: { userId, status: "active" },
      }),
      activeWorkerLimit: getPlanDefinition(window.plan).activeWorkerLimit,
    };
  }

  const { periodStart, periodEnd, plan } = window;

  const [period, activeWorkers] = await Promise.all([
    prisma.usagePeriod.findUnique({
      where: { userId_periodStart: { userId, periodStart } },
      select: {
        createdAt: true,
        planAtStart: true,
        counters: { select: { kind: true, used: true, limit: true } },
      },
    }),
    prisma.routine.count({ where: { userId, status: "active" } }),
  ]);

  const planBaseline = period?.planAtStart ?? plan;

  const base = {
    periodStart,
    periodEnd,
    planBaseline,
    activeWorkers,
    activeWorkerLimit: getPlanDefinition(planBaseline).activeWorkerLimit,
  };

  if (period === null) {
    return {
      ...base,
      // Nothing has been observed, which is not the same as nothing having
      // happened before observation existed.
      partialPeriod: true,
      counters: null,
    };
  }

  const stored = new Map(
    period.counters.map((counter) => [counter.kind, counter]),
  );

  return {
    ...base,
    partialPeriod: period.createdAt.getTime() > periodStart.getTime(),
    // Listed in the order the kinds are declared rather than the order the rows
    // came back, so a snapshot reads the same way every time.
    counters: usageKinds.map((kind) => {
      const counter = stored.get(kind);
      const used = counter?.used ?? 0;
      const limit = counter?.limit ?? limitFor(planBaseline, kind);

      return {
        kind,
        used,
        limit,
        percent: limit <= 0 ? 0 : Math.round((used / limit) * 100),
        status: usageStatusFor(used, limit),
      };
    }),
  };
}
