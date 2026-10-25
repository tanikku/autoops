import "server-only";

import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Whether billing is broken in a way somebody has to act on.
 *
 * **The sweep answers 200 for trouble it can retry**, and that stays true: one
 * unreachable read, one refusal, one checkout still being paid for are each
 * their own row's business. What this adds is the trouble no retry will fix and
 * nobody would otherwise hear about — a deployment whose provider configuration
 * cannot be used, work that has stayed owing for an hour, a checkout left open
 * for a day. Any of those makes the billing route answer 503, the cron's
 * `--fail-with-body` stops the chain before the heartbeat, and the existing
 * dead man's switch raises the alarm. Nothing new watches anything.
 *
 * **Read after the sweep, from rows alone.** Nothing is remembered between
 * ticks: once the configuration is fixed, the work answered, or the checkout
 * closed, the next tick is healthy again by itself.
 */

/** How long work may stay owing before it is somebody's problem. */
export const BILLING_CRITICAL_PENDING_AGE_MS = 60 * 60 * 1000;

/**
 * How long a checkout may stay open before it is somebody's problem.
 *
 * A session is payable for twelve hours and an attempt holds its slot for
 * eighteen; a paid one is closed by the activation and a lapsed one by the
 * sweep's own recovery. An attempt still open after a day is one of those not
 * having happened — paid but never activated, refused, or a close that keeps
 * failing.
 */
export const BILLING_CRITICAL_OPEN_CHECKOUT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Outcomes that mean a provider cannot be used as configured.
 *
 * The reasons `resolveProviderReader` and the checkout session reader give
 * instead of a reader. **None of them is transient**: the next tick will say
 * the same thing until somebody changes the deployment.
 */
export const PROVIDER_CONFIG_OUTCOMES = [
  "no-secret-key",
  "no-price-catalogue",
  "no-livemode-flag",
  "bad-livemode-flag",
  "key-mode-mismatch",
  "unsupported-provider",
] as const;

export type BillingHealth = {
  readonly critical: boolean;
  /** How many of each kind of critical finding. Zero means none. */
  readonly findings: {
    readonly "provider-config": number;
    readonly "stale-pending": number;
    readonly "stale-open-checkout": number;
  };
  /** Age of the oldest owing row, or null when nothing is owing that long. */
  readonly oldestStalePendingMs: number | null;
  /** Age of the oldest stale open checkout, or null when there is none. */
  readonly oldestStaleOpenCheckoutMs: number | null;
};

function countConfigOutcomes(counts: Readonly<Record<string, number>>): number {
  return PROVIDER_CONFIG_OUTCOMES.reduce((sum, outcome) => sum + (counts[outcome] ?? 0), 0);
}

/**
 * Decides whether this tick is critical.
 *
 * **A query that fails is not a healthy answer.** It is left to throw, so the
 * route answers 500 and the heartbeat stops — not knowing is not "fine".
 *
 * @param sweep the outcome counts the sweep just produced
 */
export async function evaluateBillingHealth(input: {
  readonly sweep: {
    readonly outcomes: Readonly<Record<string, number>>;
    readonly checkoutRecovery: Readonly<Record<string, number>>;
  };
  readonly now: Date;
  readonly client?: DbClient;
}): Promise<BillingHealth> {
  const client = input.client ?? prisma;
  const now = input.now.getTime();

  const providerConfig =
    countConfigOutcomes(input.sweep.outcomes) + countConfigOutcomes(input.sweep.checkoutRecovery);

  const stalePendingWhere = {
    pendingSince: { not: null, lte: new Date(now - BILLING_CRITICAL_PENDING_AGE_MS) },
  };
  const staleOpenWhere = {
    state: "open",
    createdAt: { lte: new Date(now - BILLING_CRITICAL_OPEN_CHECKOUT_AGE_MS) },
  };

  const [stalePending, oldestPending, staleOpen, oldestOpen] = await Promise.all([
    client.billingReconciliation.count({ where: stalePendingWhere }),
    client.billingReconciliation.findFirst({
      where: stalePendingWhere,
      orderBy: { pendingSince: "asc" },
      select: { pendingSince: true },
    }),
    client.checkoutAttempt.count({ where: staleOpenWhere }),
    client.checkoutAttempt.findFirst({
      where: staleOpenWhere,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  const findings = {
    "provider-config": providerConfig,
    "stale-pending": stalePending,
    "stale-open-checkout": staleOpen,
  };

  return {
    critical: Object.values(findings).some((count) => count > 0),
    findings,
    oldestStalePendingMs:
      oldestPending?.pendingSince == null ? null : now - oldestPending.pendingSince.getTime(),
    oldestStaleOpenCheckoutMs: oldestOpen === null ? null : now - oldestOpen.createdAt.getTime(),
  };
}
