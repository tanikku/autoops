import "server-only";

import { getPlanDefinition } from "@/lib/plans";
import { prisma } from "@/lib/prisma";
import { resolveUsageWindow } from "@/lib/usage/observe";
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
  // **The same window the counting uses.** A trial's usage is written to the
  // trial's own period, so reading the calendar month would show an operator an
  // empty month for an account that is busy — the two must ask the same
  // question or the screen is a second opinion. See `resolveUsageWindow`.
  const { periodStart, periodEnd, plan } = await resolveUsageWindow(userId, now);

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
