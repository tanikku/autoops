/**
 * The vocabularies the usage tables are written in.
 *
 * **Strings in the database, narrowed here.** Adding a kind, a feature or a
 * provider should be a line in this file and the code that reads it, not a
 * migration — the same choice `RoutineKind`, `RoutineStatus` and
 * `User.language` already made.
 */

/**
 * The allowances a plan counts.
 *
 * **Three, and they mean different things.** A hand-started run is an operation
 * somebody asked for; a discovery run is that plus a search somebody else's
 * service answered; AI processing is a call to a model. One run can spend more
 * than one of them, and a run that never reaches a model spends none of the
 * third — which is the whole reason they are not one number.
 */
export const usageKinds = ["aiProcessing", "manualRun", "discovery"] as const;

export type UsageKind = (typeof usageKinds)[number];

export function isUsageKind(value: unknown): value is UsageKind {
  return (
    typeof value === "string" && (usageKinds as readonly string[]).includes(value)
  );
}

/**
 * Which part of Koqentra called a model.
 *
 * **Six, deliberately not collapsed.** Three of them are a worker running and
 * three are not, and telling them apart is the question this exists to answer:
 * `draft` and the two Creator features write no run history at all, so without
 * a name here their cost would be invisible — which is exactly what happened
 * the last time somebody tried to work out what a call costs.
 */
export const usageFeatures = [
  "prompt",
  "website",
  "discovery",
  "draft",
  "creator-analysis",
  "creator-memory",
] as const;

export type UsageFeature = (typeof usageFeatures)[number];

export function isUsageFeature(value: unknown): value is UsageFeature {
  return (
    typeof value === "string" &&
    (usageFeatures as readonly string[]).includes(value)
  );
}

/** Who was called. One so far, named rather than assumed. */
export const usageProviders = ["anthropic"] as const;

export type UsageProvider = (typeof usageProviders)[number];

export function isUsageProvider(value: unknown): value is UsageProvider {
  return (
    typeof value === "string" &&
    (usageProviders as readonly string[]).includes(value)
  );
}

/**
 * How a call ended.
 *
 * **Only two, and neither of them is "refused" or "timed out".** Why a call
 * failed is a question `ProviderErrorKind` already answers, in the run history
 * and the logs; what this table is for is what a call used, and for that
 * purpose every failure is the same failure.
 */
export const usageOutcomes = ["ok", "error"] as const;

export type UsageOutcome = (typeof usageOutcomes)[number];

export function isUsageOutcome(value: unknown): value is UsageOutcome {
  return (
    typeof value === "string" &&
    (usageOutcomes as readonly string[]).includes(value)
  );
}

/**
 * What a provider said a call used, in Koqentra's own words.
 *
 * **Null is not zero, and the distinction is the reason every field is
 * nullable.** A provider that reports no cached reads has said something; a
 * failed call that reports nothing at all has not. Writing the second down as
 * `0` would make a call whose cost is unknown indistinguishable from one that
 * cost nothing, and no later analysis could separate them again.
 */
export type NormalizedProviderUsage = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
};

/** Usage from a call that reported none. */
export const UNKNOWN_PROVIDER_USAGE: NormalizedProviderUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

/**
 * One call to a model, as it is written down.
 *
 * **What a caller may not supply is as important as what it must.** There is no
 * field for the prompt, the answer, the address a worker was watching, a key, a
 * header, the provider's raw response, or its error text. Knowing what a call
 * cost has never required keeping what it said, and a shape that made room for
 * it would eventually be filled.
 */
export type ProviderUsageEventInput = {
  /** The owner, from the session. Never from a form. */
  readonly userId: string;
  readonly occurredAt: Date;
  readonly feature: UsageFeature;
  readonly provider: UsageProvider;
  /** The model as the provider names it. */
  readonly model: string;
  readonly usage: NormalizedProviderUsage;
  readonly outcome: UsageOutcome;
  /** The run this belonged to, when it belonged to one. Null for the rest. */
  readonly runId: string | null;
};
