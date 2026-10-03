import "server-only";

import { spendAllowances } from "@/lib/usage/consume";

/**
 * The AI processing allowance, as every caller of a model asks for it.
 *
 * **One unit, taken immediately before the request is sent.** Everything that
 * can refuse a request without sending it — an empty or oversized request, a
 * stand-in provider, nothing to summarise — is decided first and costs nothing.
 * What is taken here is not given back: a request that then fails, or never
 * leaves because something unexpected broke, has still spent the unit. See
 * `spendAllowances`.
 *
 * **This counter is the one the allowance is measured by.** The bookkeeping
 * after a call (`lib/usage/record.ts`) writes the provider ledger and no longer
 * moves it, so a call is counted once.
 */

/** Why a request was not allowed to be sent. Nothing was taken. */
export type AiAllowanceRefusal =
  /** The account's AI processing for this period, or before its trial, is spent. */
  | "exhausted"
  /** The account may not spend AI processing at all — a trial run out, a plan ended. */
  | "unavailable";

/**
 * What reserving AI processing came to.
 *
 * **Granted carries the period the unit was taken in**, so the provider call it
 * pays for can be recorded against exactly that period. It is the id the spend
 * itself used, not one looked up afterwards.
 */
export type AiAllowanceReservation =
  | { readonly granted: true; readonly usagePeriodId: string }
  | { readonly granted: false; readonly refusal: AiAllowanceRefusal };

/**
 * Takes one unit of AI processing for the account, or says why it cannot.
 *
 * Granted means the unit is taken and the request may be sent. Every refusal
 * that is not about the allowance being spent — not entitled, nowhere to count
 * it, no counter — is `unavailable`: each means the account cannot spend, and
 * none is a reason to send the request anyway.
 */
export async function reserveAiProcessing(
  userId: string,
): Promise<AiAllowanceReservation> {
  return reserveOne(userId, "aiProcessing");
}

/**
 * Takes one manual run from the account's period, or says why it cannot.
 *
 * **Taken where the run was accepted, as it was always counted.** A run that
 * then fails, or is refused by its AI allowance, has still spent it. Separate
 * from the hourly limit in `lib/rate-limit.ts`, which bounds bursts.
 */
export async function reserveManualRun(
  userId: string,
): Promise<AiAllowanceRefusal | null> {
  return refusalOf(await reserveOne(userId, "manualRun"));
}

/**
 * Takes one recommendation run from the account's period, or says why it
 * cannot. Counted where a discovery run was always counted — once its search is
 * known to exist, before the search — for manual and scheduled runs alike.
 */
export async function reserveDiscoveryRun(
  userId: string,
): Promise<AiAllowanceRefusal | null> {
  return refusalOf(await reserveOne(userId, "discovery"));
}

/**
 * **The one place production spends an allowance.** Every kind goes through
 * the same atomic primitive, so a limit means the same thing for each of them.
 */
async function reserveOne(
  userId: string,
  kind: "aiProcessing" | "manualRun" | "discovery",
): Promise<AiAllowanceReservation> {
  const result = await spendAllowances({
    userId,
    items: [{ kind, units: 1 }],
  });

  if (result.granted) {
    return { granted: true, usagePeriodId: result.usagePeriodId };
  }

  return {
    granted: false,
    refusal: result.reason === "exhausted" ? "exhausted" : "unavailable",
  };
}

function refusalOf(reservation: AiAllowanceReservation): AiAllowanceRefusal | null {
  return reservation.granted ? null : reservation.refusal;
}

/** Thrown where a refusal has to leave as an error — a Creator analysis. */
export class AiAllowanceRefusedError extends Error {
  readonly refusal: AiAllowanceRefusal;

  constructor(refusal: AiAllowanceRefusal) {
    super(`AI processing allowance refused: ${refusal}`);
    this.name = "AiAllowanceRefusedError";
    this.refusal = refusal;
  }
}

export function aiAllowanceRefusalOf(error: unknown): AiAllowanceRefusal | null {
  return error instanceof AiAllowanceRefusedError ? error.refusal : null;
}

/**
 * What a worker run that was refused says for itself.
 *
 * **Fixed, and recognised by exactly these strings.** A refused run is `failed`
 * because the schema has no other way to finish one, but it is not a failure of
 * the platform or the provider: nobody is emailed about it, and the person who
 * pressed Run is told about the allowance rather than that the worker failed.
 */
export const AI_ALLOWANCE_EXHAUSTED_MESSAGE = "AI processing limit reached.";
export const AI_ALLOWANCE_UNAVAILABLE_MESSAGE =
  "AI processing is not available for this account.";

export function aiAllowanceRunMessage(refusal: AiAllowanceRefusal): string {
  return refusal === "exhausted"
    ? AI_ALLOWANCE_EXHAUSTED_MESSAGE
    : AI_ALLOWANCE_UNAVAILABLE_MESSAGE;
}

/** The refusal a finished run records, or null for any other outcome. */
export function aiAllowanceRefusalOfRun(run: {
  readonly status: string;
  readonly errorMessage: string | null;
}): AiAllowanceRefusal | null {
  if (run.status !== "failed") {
    return null;
  }

  if (run.errorMessage === AI_ALLOWANCE_EXHAUSTED_MESSAGE) {
    return "exhausted";
  }

  return run.errorMessage === AI_ALLOWANCE_UNAVAILABLE_MESSAGE
    ? "unavailable"
    : null;
}

/** What a recommendation run refused by its period allowance says for itself. */
export const DISCOVERY_ALLOWANCE_EXHAUSTED_MESSAGE =
  "Recommendation run limit reached.";
export const DISCOVERY_ALLOWANCE_UNAVAILABLE_MESSAGE =
  "Recommendations are not available for this account.";

export function discoveryAllowanceRunMessage(refusal: AiAllowanceRefusal): string {
  return refusal === "exhausted"
    ? DISCOVERY_ALLOWANCE_EXHAUSTED_MESSAGE
    : DISCOVERY_ALLOWANCE_UNAVAILABLE_MESSAGE;
}

/** Which allowance refused a finished run, and how — or null for any other outcome. */
export function allowanceRefusalOfRun(run: {
  readonly status: string;
  readonly errorMessage: string | null;
}): { readonly kind: "aiProcessing" | "discovery"; readonly refusal: AiAllowanceRefusal } | null {
  const ai = aiAllowanceRefusalOfRun(run);

  if (ai !== null) {
    return { kind: "aiProcessing", refusal: ai };
  }

  if (run.status !== "failed") {
    return null;
  }

  if (run.errorMessage === DISCOVERY_ALLOWANCE_EXHAUSTED_MESSAGE) {
    return { kind: "discovery", refusal: "exhausted" };
  }

  return run.errorMessage === DISCOVERY_ALLOWANCE_UNAVAILABLE_MESSAGE
    ? { kind: "discovery", refusal: "unavailable" }
    : null;
}
