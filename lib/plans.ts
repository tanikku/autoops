/**
 * What each plan allows, as numbers this deployment holds rather than numbers a
 * billing provider reports.
 *
 * **A catalogue in code, not rows in a table.** The limits below change when
 * somebody decides they should and ships that decision; they do not change
 * because a webhook arrived. Storing them would make a second place for the
 * same truth to live and a second thing to keep in step — the same argument
 * that keeps `TOTAL_WORKER_LIMIT` a constant rather than a column.
 *
 * **Nothing here is enforced yet.** These values are read by
 * `lib/entitlements/`, which is imported by nothing that runs a worker. A plan
 * existing and a plan being applied are separate changes, and this is the
 * first of them.
 *
 * **No provider identifiers and no prices.** A price id belongs to whoever
 * bills, and the moment one appears here every module that asks what a plan
 * allows also knows who charges for it. Prices are absent for the same reason:
 * no code below this line needs one to decide what somebody may do.
 */

/**
 * The plans that exist.
 *
 * `beta` is one of them rather than a special case: the accounts carried over
 * from the Closed Beta have an allowance, and describing it as a plan means the
 * code that reads an allowance has one shape instead of two. What makes it
 * different is that it is granted rather than bought, and that it ends — but
 * **the date it ends on is not here**, because it is per account. See
 * `Subscription.expiresAt`.
 */
export const planIds = ["trial", "lite", "standard", "pro", "beta"] as const;

export type PlanId = (typeof planIds)[number];

/** Whether a stored string names a plan this version knows. */
export function isPlan(value: unknown): value is PlanId {
  return (
    typeof value === "string" && (planIds as readonly string[]).includes(value)
  );
}

/**
 * Which workers may email their owner when they finish.
 *
 * **Three states rather than a number**, because "one" is not a quantity here.
 * A plan allowing one worker to send mail has to know *which* worker, and that
 * choice belongs to the account rather than to the plan — see
 * `Subscription.notificationWorkerId`. Writing it as `1` would invite code that
 * counts workers with notifications switched on and decides the first two are
 * fine.
 */
export type EmailEntitlement = "none" | "one-worker" | "all-workers";

/**
 * How far back a run history reaches.
 *
 * **Trial's answer is not a number of days.** A trial's history is its own
 * length: asking how many days it covers before knowing when it started would
 * be answering a question about an account with a fact about a plan.
 */
export type HistoryEntitlement =
  | { readonly kind: "days"; readonly days: number }
  | { readonly kind: "trial-period" };

/**
 * One plan's allowances.
 *
 * The three counted allowances are **product units per period**, not provider
 * requests: what a unit costs is decided where usage is spent, and a plan says
 * only how many there are. See `lib/usage/`.
 */
export type PlanDefinition = {
  readonly id: PlanId;
  /** How many of an account's workers may be active at once. */
  readonly activeWorkerLimit: number;
  /** AI processing units per period. */
  readonly aiProcessingLimit: number;
  /** Hand-started runs per period. */
  readonly manualRunLimit: number;
  /** Discovery runs per period. */
  readonly discoveryLimit: number;
  readonly history: HistoryEntitlement;
  readonly email: EmailEntitlement;
  /**
   * How long a trial lasts, in days. Null on every plan that is not a trial.
   *
   * **On the plan rather than in the trial code** so that changing the length
   * cannot silently change a trial already running: what a trial ends at is
   * written down when it starts. See `computeTrialEnd`.
   */
  readonly trialDurationDays: number | null;
};

const definitions: Readonly<Record<PlanId, PlanDefinition>> = {
  trial: {
    id: "trial",
    activeWorkerLimit: 3,
    aiProcessingLimit: 50,
    manualRunLimit: 20,
    discoveryLimit: 14,
    history: { kind: "trial-period" },
    email: "all-workers",
    trialDurationDays: 14,
  },
  lite: {
    id: "lite",
    activeWorkerLimit: 2,
    aiProcessingLimit: 30,
    manualRunLimit: 20,
    discoveryLimit: 10,
    history: { kind: "days", days: 7 },
    email: "one-worker",
    trialDurationDays: null,
  },
  standard: {
    id: "standard",
    activeWorkerLimit: 8,
    aiProcessingLimit: 150,
    manualRunLimit: 100,
    discoveryLimit: 60,
    history: { kind: "days", days: 90 },
    email: "all-workers",
    trialDurationDays: null,
  },
  pro: {
    id: "pro",
    activeWorkerLimit: 15,
    aiProcessingLimit: 300,
    manualRunLimit: 300,
    discoveryLimit: 150,
    history: { kind: "days", days: 365 },
    email: "all-workers",
    trialDurationDays: null,
  },
  beta: {
    id: "beta",
    activeWorkerLimit: 10,
    aiProcessingLimit: 300,
    manualRunLimit: 300,
    discoveryLimit: 150,
    history: { kind: "days", days: 365 },
    email: "all-workers",
    trialDurationDays: null,
  },
};

/**
 * **Frozen, because a definition is handed out by reference.**
 *
 * `readonly` is a promise the compiler keeps and the runtime does not: a caller
 * that assigned through the object it was given would change what every later
 * reader sees, and the catalogue would quietly stop being what was shipped.
 * Copying on each read would hide the mistake instead of refusing it.
 */
for (const definition of Object.values(definitions)) {
  Object.freeze(definition.history);
  Object.freeze(definition);
}

Object.freeze(definitions);

/** Raised when a stored plan is one this version does not know. */
export class UnknownPlanError extends Error {
  constructor(plan: string) {
    super(`Unknown plan: ${plan}`);
    this.name = "UnknownPlanError";
  }
}

/**
 * What a plan allows.
 *
 * **Throws rather than falling back**, and the fallback it refuses is the
 * dangerous one: a stored plan nobody recognises would otherwise become
 * whatever the default happened to be, and the account would quietly be given
 * an allowance it was never granted. A name this version does not know means
 * the row was written by a version that knew more, and guessing is worse than
 * stopping.
 */
export function getPlanDefinition(plan: string): PlanDefinition {
  if (!isPlan(plan)) {
    throw new UnknownPlanError(plan);
  }

  return definitions[plan];
}
