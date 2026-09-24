import type {
  EmailEntitlement,
  HistoryEntitlement,
  PlanId,
} from "@/lib/plans";
import type { SubscriptionState } from "@/lib/entitlements/states";

/**
 * What an account may do, as the rest of Koqentra would ask about it.
 *
 * **Nothing here is a database row, and that is the point of the file.** A
 * feature asking what somebody may do should not receive a `Subscription`: it
 * would arrive carrying a customer id, a provider subscription id and a
 * provider's timestamp, and from then on every module that asks a product
 * question also knows who bills. The types below are what crosses that line,
 * and the provider columns are not among them.
 */

/**
 * What the clock says about a stored state.
 *
 * The five stored values, plus the three that are only ever worked out:
 * `none` for an account with no row at all, `trial_expired` for a trial past
 * its end, and `expired` for a grant past `expiresAt`. See
 * `lib/entitlements/states.ts` for why those three are not columns.
 */
export type EntitlementState =
  | SubscriptionState
  | "none"
  | "trial_expired"
  | "expired";

/** A plan's allowances, as they apply to this account right now. */
export type EntitlementLimits = {
  readonly activeWorkerLimit: number;
  readonly aiProcessingLimit: number;
  readonly manualRunLimit: number;
  readonly discoveryLimit: number;
  readonly history: HistoryEntitlement;
  readonly email: EmailEntitlement;
};

/** When a trial ran, for an account that has had one. */
export type TrialWindow = {
  readonly startedAt: Date | null;
  readonly endsAt: Date | null;
  /** Whether this account has used its one trial, whatever became of it. */
  readonly consumed: boolean;
};

/** The billing cycle an allowance is measured over. */
export type BillingPeriod = {
  readonly start: Date;
  readonly end: Date;
};

/**
 * The answer to "what may this account do", worked out at a moment.
 *
 * **`entitled` is the one field a caller has to read.** The rest describes
 * *why*, for screens and for support; a feature deciding whether to act asks
 * this and nothing else, so there is one place the answer can come from rather
 * than a condition each caller assembles from a state name.
 *
 * `plan` and `limits` are null together, and only for `none` — an account with
 * no entitlement has no allowances, rather than allowances of zero. Zeroes
 * would be arithmetic somebody could accidentally compare against.
 */
export type EffectiveEntitlement = {
  readonly state: EntitlementState;
  readonly entitled: boolean;
  readonly plan: PlanId | null;
  readonly limits: EntitlementLimits | null;
  readonly trial: TrialWindow | null;
  readonly period: BillingPeriod | null;
  readonly expiresAt: Date | null;
  /**
   * The worker chosen to email its owner, on a plan that allows one.
   *
   * **Here because `email: "one-worker"` is unusable without it.** A value
   * object that can say one worker may send mail, but not which, would leave
   * every caller to find that out somewhere else.
   */
  readonly notificationWorkerId: string | null;
};

/**
 * A stored entitlement, reduced to what a product question needs.
 *
 * **What is missing is deliberate**: `providerCustomerId`,
 * `providerSubscriptionId` and `providerUpdatedAt` are absent, so the domain
 * below cannot read them even by accident. A billing adapter writes those
 * columns and is the only thing that ever reads them back.
 */
export type SubscriptionRecord = {
  readonly plan: string;
  readonly state: string;
  readonly trialStartedAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly trialConsumedAt: Date | null;
  /**
   * When this account stopped being able to be offered a trial.
   *
   * **A different question from `trialConsumedAt`.** That one says the account
   * took the offer up; this says the offer is no longer available to it. An
   * account given the beta allowance has the second without the first.
   */
  readonly trialForfeitedAt: Date | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly notificationWorkerId: string | null;
  readonly source: string;
  readonly expiresAt: Date | null;
};
