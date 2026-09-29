import "server-only";

import { computeEntitlement } from "@/lib/entitlements/index";
import { readPreTrialAiProcessing } from "@/lib/entitlements/start-trial";
import { InvalidSubscriptionError } from "@/lib/entitlements/states";
import { UnknownPlanError } from "@/lib/plans";
import { type DbClient, prisma } from "@/lib/prisma";
import { resolveUsageWriteWindow } from "@/lib/usage/observe";
import { openOrGetUsagePeriodLocked, planLimitFor } from "@/lib/usage/period";
import { type UsageKind, usageKinds } from "@/lib/usage/types";

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

  return incrementWithinLimit(prisma, periodId, kind, units);
}

/**
 * The conditional write both spenders share.
 *
 * **One definition of "take it if it fits".** `consumeUsage` and
 * `spendAllowances` must agree exactly on what an allowance permits, so they do
 * not each carry a copy: the limit is read, then matched again inside the
 * `UPDATE` together with `used <= limit - units`, and the row count says which
 * of the two answers PostgreSQL gave.
 */
async function incrementWithinLimit(
  client: DbClient,
  periodId: string,
  kind: UsageKind,
  units: number,
): Promise<UsageConsumption> {
  const counter = await client.usageCounter.findUnique({
    where: { periodId_kind: { periodId, kind } },
    select: { limit: true },
  });

  if (counter === null) {
    return { granted: false, reason: "unknown-counter" };
  }

  const { count } = await client.usageCounter.updateMany({
    where: {
      periodId,
      kind,
      // The limit this decision was made against. See `consumeUsage`.
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

/**
 * Spending several allowances at once, for an account, at an instant.
 *
 * **Nothing calls this yet.** It is the primitive enforcement will be built on;
 * each place that starts refusing work connects to it in its own change. Until
 * then no counter moves because of it, and observation goes on exactly as
 * before.
 *
 * **All or nothing.** Every allowance named in one call is taken together in
 * one transaction, or none is. A run that needs two of them either gets both or
 * leaves both untouched — never one spent and one refused.
 *
 * **Spent, never given back.** A unit taken here stays taken whatever happens
 * afterwards, the same rule `consumeUsage` states. Allowances needed at
 * different moments are separate calls, and a later refusal does not return
 * what an earlier call took.
 *
 * **Who may spend is `computeEntitlement`'s answer, not a second one.** An
 * account with no row is on its way to a trial: it may spend AI processing from
 * a lifetime pool the size of the trial's own AI allowance, and nothing else. An
 * entitled account spends from the period its plan is counted over. Every other
 * account — a trial run out, a grant expired, a subscription ended, a row this
 * version cannot read — spends nothing.
 */

/** One allowance and how much of it to take. */
export type AllowanceItem = {
  readonly kind: UsageKind;
  readonly units: number;
};

/** Where an exhausted allowance was measured. */
export type AllowanceScope =
  /** The period the account's plan is counted over. */
  | "period"
  /** The lifetime pool an account draws on before its trial starts. */
  | "pre-trial";

/** What spending came to. Nothing was taken unless it says `granted`. */
export type SpendAllowancesResult =
  | { readonly granted: true }
  /** One of the allowances did not have room. Nothing was taken. */
  | {
      readonly granted: false;
      readonly reason: "exhausted";
      readonly kind: UsageKind;
      readonly scope: AllowanceScope;
    }
  /** The account is entitled, but there is no period to count this in. */
  | { readonly granted: false; readonly reason: "not-counted" }
  /** The account may not spend this at all. */
  | { readonly granted: false; readonly reason: "not-entitled" }
  /** The period has no counter for this kind. Nothing was taken. */
  | {
      readonly granted: false;
      readonly reason: "unknown-counter";
      readonly kind: UsageKind;
    };

/** A refusal: every answer that is not `granted`. */
export type AllowanceRefusal = Exclude<SpendAllowancesResult, { granted: true }>;

/**
 * Thrown inside the transaction to undo it, and caught to become an answer.
 *
 * **Not exported.** Outside this module a refusal is a value — see
 * `allowanceRefusalOf` for the one case where it has to travel as an error.
 */
class AllowanceRefused extends Error {
  readonly refusal: AllowanceRefusal;

  constructor(refusal: AllowanceRefusal) {
    super(`Allowance refused: ${refusal.reason}`);
    this.name = "AllowanceRefused";
    this.refusal = refusal;
  }
}

/**
 * The refusal carried by an error thrown from `spendAllowances`, if it is one.
 *
 * **Only for a caller that passed its own transaction.** A refusal has to undo
 * whatever it had already written, and in somebody else's transaction the only
 * way to do that is to abort it — so it is thrown, and the caller's
 * transaction ends with it. **Catching it and carrying on inside the same
 * transaction is not supported**: PostgreSQL will not let the transaction
 * continue, and a counter taken before the refusal would otherwise stay taken.
 * Read it after the transaction has failed, to say why.
 */
export function allowanceRefusalOf(error: unknown): AllowanceRefusal | null {
  return error instanceof AllowanceRefused ? error.refusal : null;
}

/** The order counters are always taken in, so two spenders never cross. */
const KIND_ORDER: readonly UsageKind[] = usageKinds;

/** The one allowance an account may spend before it has a trial. */
const PRE_TRIAL_KIND: UsageKind = "aiProcessing";

/** What the pre-trial pool is measured against: the trial's own AI allowance. */
const PRE_TRIAL_PLAN = "trial" as const;

const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** Which columns the entitlement is worked out from. */
const SUBSCRIPTION_FIELDS = {
  plan: true,
  state: true,
  source: true,
  trialStartedAt: true,
  trialEndsAt: true,
  trialConsumedAt: true,
  trialForfeitedAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  notificationWorkerId: true,
  expiresAt: true,
} as const;

/**
 * Checks the request before anything is opened.
 *
 * **Mistakes are thrown, not answered.** An empty list, a fraction of a unit or
 * the same allowance named twice is a caller's bug, and turning it into a
 * refusal would let it look like an account out of room.
 */
function validateItems(items: readonly AllowanceItem[]): AllowanceItem[] {
  if (items.length === 0) {
    throw new Error("spendAllowances needs at least one allowance");
  }

  const seen = new Set<UsageKind>();

  for (const item of items) {
    if (!KIND_ORDER.includes(item.kind)) {
      throw new Error(`Unknown usage kind: ${String(item.kind)}`);
    }

    if (!Number.isInteger(item.units) || item.units < 1) {
      throw new Error(
        `Usage units must be a positive integer, received ${item.units}`,
      );
    }

    if (seen.has(item.kind)) {
      throw new Error(`Usage kind named twice: ${item.kind}`);
    }

    seen.add(item.kind);
  }

  return [...items].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/**
 * Takes the account's own row for the rest of the transaction.
 *
 * **The same lock the worker quota, checkout coordination and reconciliation
 * take, taken the same way.** Updating a column to the value it already has is
 * a real `UPDATE` and holds the row; `data: {}` would become a `SELECT` and hold
 * nothing. Everything that opens a period or starts a trial for this account
 * therefore waits for this transaction — which is what keeps a pre-trial spend
 * from slipping past a trial start that is carrying the pool over.
 */
async function lockAccount(client: DbClient, userId: string): Promise<void> {
  await client.user.update({ where: { id: userId }, data: { id: userId } });
}

/** Whether the account may spend at all, and from which pool. */
type Lane = "pre-trial" | "entitled" | "not-entitled";

async function readLane(
  client: DbClient,
  userId: string,
  now: Date,
): Promise<Lane> {
  const row = await client.subscription.findUnique({
    where: { userId },
    select: SUBSCRIPTION_FIELDS,
  });

  if (row === null) {
    return "pre-trial";
  }

  try {
    return computeEntitlement(row, now).entitled ? "entitled" : "not-entitled";
  } catch (error) {
    // A row written by a version that knew more is not spent against.
    if (error instanceof InvalidSubscriptionError || error instanceof UnknownPlanError) {
      return "not-entitled";
    }

    throw error;
  }
}

/** The whole spend, inside whichever transaction it was given. */
async function spendWithin(
  client: DbClient,
  userId: string,
  items: readonly AllowanceItem[],
  explicitNow: Date | undefined,
): Promise<void> {
  await lockAccount(client, userId);

  // **The clock is read once the lock is held, not before.** A trial start that
  // took the lock first has committed by now, and its start instant is in the
  // past of a clock read here — so this spend lands inside the trial rather
  // than just before it, where no period would take it. A clock read before
  // waiting would describe a moment the account has already moved on from. An
  // explicit instant is a caller's own snapshot and is used as given.
  const now = explicitNow ?? new Date();

  const lane = await readLane(client, userId, now);

  if (lane === "not-entitled") {
    throw new AllowanceRefused({ granted: false, reason: "not-entitled" });
  }

  if (lane === "pre-trial" && items.some((item) => item.kind !== PRE_TRIAL_KIND)) {
    throw new AllowanceRefused({ granted: false, reason: "not-entitled" });
  }

  const window = await resolveUsageWriteWindow(userId, now, client);

  if (window.kind === "skip") {
    throw new AllowanceRefused({ granted: false, reason: "not-counted" });
  }

  const period = await openOrGetUsagePeriodLocked(client, {
    userId,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    plan: window.plan,
  });

  if (lane === "pre-trial") {
    // **The whole of what the account has used, not this month's.** The trial
    // it is heading for carries exactly this sum in when it starts, so the pool
    // is the trial's own AI allowance, spent early.
    const used = await readPreTrialAiProcessing(client, userId);
    const units = items[0].units;

    if (used + units > planLimitFor(PRE_TRIAL_PLAN, PRE_TRIAL_KIND)) {
      throw new AllowanceRefused({
        granted: false,
        reason: "exhausted",
        kind: PRE_TRIAL_KIND,
        scope: "pre-trial",
      });
    }
  }

  for (const item of items) {
    const taken = await incrementWithinLimit(client, period.id, item.kind, item.units);

    if (!taken.granted) {
      throw new AllowanceRefused(
        taken.reason === "exhausted"
          ? { granted: false, reason: "exhausted", kind: item.kind, scope: "period" }
          : { granted: false, reason: "unknown-counter", kind: item.kind },
      );
    }
  }
}

/**
 * Takes every allowance named, or none of them.
 *
 * **Given no transaction, it owns one** and answers with a value: a refusal
 * rolls everything back and comes back as `granted: false`. A collision with
 * observation opening the same period surfaces as a unique violation that has
 * already aborted the transaction; that one case is tried once more from the
 * beginning, which is safe because nothing from the first try was kept.
 *
 * **Given a transaction, it joins it** and never retries, commits or rolls
 * back. A refusal is thrown so that the caller's transaction aborts with it —
 * see `allowanceRefusalOf`.
 */
export async function spendAllowances(input: {
  readonly userId: string;
  readonly items: readonly AllowanceItem[];
  readonly now?: Date;
  readonly client?: DbClient;
}): Promise<SpendAllowancesResult> {
  const items = validateItems(input.items);
  // Not defaulted here: see `spendWithin`, which reads the clock under the lock
  // — and, on a retry, reads it again rather than reusing the first attempt's.
  const now = input.now;
  const client = input.client ?? prisma;

  const owned = "$transaction" in client && typeof client.$transaction === "function";

  if (!owned) {
    await spendWithin(client, input.userId, items, now);
    return { granted: true };
  }

  const attempt = async (): Promise<SpendAllowancesResult> => {
    try {
      await (client as typeof prisma).$transaction((tx) =>
        spendWithin(tx, input.userId, items, now),
      );
      return { granted: true };
    } catch (error) {
      const refusal = allowanceRefusalOf(error);

      if (refusal !== null) {
        return refusal;
      }

      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    console.warn("[usage] allowance period conflict — retried");

    return await attempt();
  }
}
