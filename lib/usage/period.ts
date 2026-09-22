import "server-only";

import { prisma } from "@/lib/prisma";
import { getPlanDefinition } from "@/lib/plans";
import { usageKinds, type UsageKind } from "@/lib/usage/types";

/**
 * The period an allowance is measured over, and the counters inside it.
 *
 * **Nothing calls this during ordinary use.** No period is opened when somebody
 * signs in, creates a worker or runs one; the function exists so that the phase
 * which does start counting has something to call rather than something to
 * design. Until then the table stays empty, which is the honest state of a
 * deployment that is not counting.
 *
 * **A period is the subscription's own cycle**, handed in by the caller rather
 * than worked out here. Whose cycle it is, and when it turns over, is a billing
 * question; what a period contains is this file's.
 */

/** Prisma's code for a unique constraint that would have been broken. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** What a period is opened for. */
export type UsagePeriodWindow = {
  readonly userId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** The plan in force as the period opens. Copied onto the row and counters. */
  readonly plan: string;
};

/** One allowance inside a period. */
export type UsageCounterState = {
  readonly kind: UsageKind;
  readonly used: number;
  readonly limit: number;
};

/** A period, and what it has spent. */
export type UsagePeriodState = {
  readonly id: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly planAtStart: string;
  readonly counters: readonly UsageCounterState[];
};

/**
 * A plan's allowance for one kind.
 *
 * **Exported because a period is not always opened here.** A trial's period is
 * created inside the transaction that activates the first worker, so it cannot
 * go through `openOrGetUsagePeriod` — but the limits it copies must be the same
 * numbers, worked out the same way, or a trial would silently be compared
 * against a second opinion of what a trial allows.
 */
export function planLimitFor(plan: string, kind: UsageKind): number {
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

/** Reads the counters back in the shape callers work with. */
function toState(row: {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  planAtStart: string;
  counters: { kind: string; used: number; limit: number }[];
}): UsagePeriodState {
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    planAtStart: row.planAtStart,
    // Narrowed on the way out rather than trusted: a kind this version does not
    // know is a row a later version wrote, and silently reporting it as an
    // allowance would be inventing one.
    counters: row.counters
      .filter((counter): counter is { kind: UsageKind; used: number; limit: number } =>
        (usageKinds as readonly string[]).includes(counter.kind),
      )
      .map(({ kind, used, limit }) => ({ kind, used, limit })),
  };
}

const PERIOD_SELECT = {
  id: true,
  periodStart: true,
  periodEnd: true,
  planAtStart: true,
  counters: { select: { kind: true, used: true, limit: true } },
} as const;

/**
 * The period covering this window, opening it if it is not there.
 *
 * **The period and its counters are created together, in one transaction.** A
 * period without counters would be an allowance nobody could spend against,
 * and the first call to arrive would have to decide whether to finish somebody
 * else's half-built period — which is exactly the read-then-write this whole
 * design avoids elsewhere.
 *
 * **A collision is read, not retried.** `@@unique([userId, periodStart])` means
 * two simultaneous first calls produce one period and one constraint failure;
 * the one that failed wanted the period rather than the creating of it, so it
 * reads back what the other made.
 *
 * The counters' limits are the plan's numbers **as of now**, copied. What
 * happens to them when a plan changes mid-period is a decision for the phase
 * that enforces them; this only records what they were.
 */
export async function openOrGetUsagePeriod(
  window: UsagePeriodWindow,
): Promise<UsagePeriodState> {
  const existing = await prisma.usagePeriod.findUnique({
    where: {
      userId_periodStart: {
        userId: window.userId,
        periodStart: window.periodStart,
      },
    },
    select: PERIOD_SELECT,
  });

  if (existing !== null) {
    return toState(existing);
  }

  try {
    const created = await prisma.usagePeriod.create({
      data: {
        userId: window.userId,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        planAtStart: window.plan,
        counters: {
          create: usageKinds.map((kind) => ({
            kind,
            used: 0,
            limit: planLimitFor(window.plan, kind),
          })),
        },
      },
      select: PERIOD_SELECT,
    });

    return toState(created);
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  const raced = await prisma.usagePeriod.findUnique({
    where: {
      userId_periodStart: {
        userId: window.userId,
        periodStart: window.periodStart,
      },
    },
    select: PERIOD_SELECT,
  });

  // The constraint said the row exists, so this reads it. If it does not, the
  // failure was something else wearing the same code, and inventing a period
  // here would hand out an allowance nobody opened.
  if (raced === null) {
    throw new Error("Usage period was reported to exist but could not be read");
  }

  return toState(raced);
}
