import "server-only";

import { prisma } from "@/lib/prisma";
import type { UsageKind } from "@/lib/usage/types";

/**
 * Spending part of an allowance.
 *
 * **Nothing calls this.** No run, no server action, no scheduler: a deployment
 * on this version counts nothing, and a counter that moved would be a number
 * nobody had decided the meaning of yet. What is fixed here is the *shape* of
 * the spend, so that the phase which starts counting inherits the concurrency
 * rule rather than inventing one.
 *
 * **`units`, not requests.** A counter holds product units; what one call to a
 * model is worth in units is decided by the caller, from a table that can
 * change without a migration. The raw provider numbers live in
 * `ProviderUsageEvent`, where re-weighting cannot rewrite them.
 *
 * **Spent on the way in, and never given back.** This is the same rule the
 * hourly allowances follow, for the same reason: a call that failed was still
 * made, and a refund path would be a second way for two callers to disagree
 * about what is left. There is deliberately no function that returns units.
 */

/** What happened when an allowance was asked for. */
export type UsageConsumption =
  /**
   * Taken. **It does not say how much is left**, on purpose: a number read
   * back here would already be somebody else's past, and a caller acting on it
   * would be doing the read-then-write the write above exists to avoid.
   */
  | { readonly granted: true; readonly limit: number }
  /** The allowance is spent. Nothing was taken. */
  | { readonly granted: false; readonly reason: "exhausted" }
  /** No counter for this period and kind. Nothing was taken. */
  | { readonly granted: false; readonly reason: "unknown-counter" };

/**
 * Takes `units` from one allowance, or takes nothing.
 *
 * **The decision is inside the write.** The condition `used <= limit - units`
 * travels with the `UPDATE`, so two calls arriving together are resolved by
 * PostgreSQL rather than by whichever read the smaller number first. A version
 * that read the row, compared, and then wrote would let both through at the
 * boundary, and the account would end the period over its allowance.
 *
 * **The limit is read first, and then checked again inside the write.** Prisma
 * cannot compare two columns in a `where`, so the number has to come from
 * somewhere — and matching it again in the condition is what makes that safe:
 * if the stored limit changed between the read and the write, nothing is taken
 * and the caller sees an ordinary refusal. It can never grant against a limit
 * that is no longer there.
 */
export async function consumeUsage(
  periodId: string,
  kind: UsageKind,
  units: number,
): Promise<UsageConsumption> {
  if (!Number.isInteger(units) || units < 1) {
    throw new Error(`Usage units must be a positive integer, received ${units}`);
  }

  const counter = await prisma.usageCounter.findUnique({
    where: { periodId_kind: { periodId, kind } },
    select: { limit: true },
  });

  if (counter === null) {
    return { granted: false, reason: "unknown-counter" };
  }

  const { count } = await prisma.usageCounter.updateMany({
    where: {
      periodId,
      kind,
      // The limit this decision was made against. See above.
      limit: counter.limit,
      used: { lte: counter.limit - units },
    },
    data: { used: { increment: units } },
  });

  if (count !== 1) {
    return { granted: false, reason: "exhausted" };
  }

  return { granted: true, limit: counter.limit };
}
