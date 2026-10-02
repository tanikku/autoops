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
 * Takes one unit of AI processing for the account, or says why it cannot.
 *
 * Null means the unit is taken and the request may be sent. Every refusal that
 * is not about the allowance being spent — not entitled, nowhere to count it, no
 * counter — is `unavailable`: each means the account cannot spend, and none is
 * a reason to send the request anyway.
 */
export async function reserveAiProcessing(
  userId: string,
): Promise<AiAllowanceRefusal | null> {
  const result = await spendAllowances({
    userId,
    items: [{ kind: "aiProcessing", units: 1 }],
  });

  if (result.granted) {
    return null;
  }

  return result.reason === "exhausted" ? "exhausted" : "unavailable";
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
