import "server-only";

import {
  type ProviderCallMetadata,
  providerAttemptOf,
} from "@/lib/ai/provider";
import { prisma } from "@/lib/prisma";
import { recordUsageObservation } from "@/lib/usage/observe";
import {
  type ProviderUsageEventInput,
  UNKNOWN_PROVIDER_USAGE,
  type UsageFeature,
} from "@/lib/usage/types";

/**
 * Writing down what one call to a model used.
 *
 * **Nothing calls this yet.** The provider adapters still discard what they are
 * told about a call's cost, and changing that is the next phase; what is here
 * is the write itself, so that when six call sites start recording they all
 * record the same way.
 *
 * **Best-effort, and that is a contract rather than a shortcut.** If this
 * throws, a run that succeeded would fail, a draft somebody is waiting for
 * would disappear, and an analysis that cost real money would be reported as
 * having not happened — all because a bookkeeping row could not be written.
 * Observation that changes what it observes is worth less than no observation,
 * so a failure here is logged and goes no further.
 *
 * **What is never written**: the prompt, the answer, the address a worker was
 * watching, the key, any header, the provider's raw response, or its error
 * text. `ProviderUsageEventInput` has nowhere to put any of them, which is the
 * only reliable way to keep them out.
 */
export async function recordProviderUsage(
  event: ProviderUsageEventInput,
): Promise<void> {
  try {
    await prisma.providerUsageEvent.create({
      data: {
        userId: event.userId,
        occurredAt: event.occurredAt,
        feature: event.feature,
        provider: event.provider,
        model: event.model,
        // Named one by one rather than spread: the normalised shape and the
        // column set are allowed to diverge, and a spread would carry whatever
        // a later field happened to be into a table with rules about that.
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        outcome: event.outcome,
        runId: event.runId,
      },
    });
  } catch (error) {
    // **Named, counted and no further.** The feature and outcome are enough to
    // tell whether recording is failing for everything or for one path; the
    // event itself is not logged, because a log line is a place material ends
    // up just as much as a column is.
    console.error(
      "[usage] provider usage event was not recorded —",
      event.feature,
      event.outcome,
      "—",
      error,
    );
  }
}

/** Who a call belonged to, which the provider never knows. */
export type AICallContext = {
  /** The owner, from the session or from the routine. Never from a form. */
  readonly userId: string;
  readonly feature: UsageFeature;
  /** The run this call belonged to, or null for the paths that have none. */
  readonly runId: string | null;
};

/**
 * Records a call that succeeded, if there was a call.
 *
 * **The stand-in writes nothing, and that refusal lives here rather than at
 * each call site.** Three features call a model today and three more will;
 * asking every one of them to remember that a fabricated answer is not a
 * purchase would eventually be six chances to forget. A result with no usage
 * came from nothing that could be billed, and this is where that is decided.
 *
 * Best-effort, like everything else in this file: see `recordProviderUsage`.
 */
export async function recordAIExecution(
  context: AICallContext,
  result: ProviderCallMetadata,
  occurredAt: Date = new Date(),
): Promise<void> {
  // Two conditions rather than one, and either alone is enough: a provider that
  // reached nothing, or a result that reports nothing. Neither is a cost.
  if (result.provider === "dummy" || result.usage === null) {
    return;
  }

  await recordProviderUsage({
    userId: context.userId,
    occurredAt,
    feature: context.feature,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    outcome: "ok",
    runId: context.runId,
  });

  await observeAIProcessing(context, occurredAt);
}

/**
 * Records a call that failed, if a call was actually made.
 *
 * **Most failures are not calls.** A missing key, an instruction too long, a
 * page that could not be fetched, an account out of allowance — every one of
 * them is a failed run that cost nothing, and a row for it would be an invented
 * charge. `providerAttemptOf` returns null for all of them, and this writes
 * nothing.
 *
 * **What is written when there was a call is deliberately thin**: the tokens if
 * the failure reported any, and nulls if it did not. Nothing is estimated from
 * `max_tokens`, from the size of the request, or from what a similar call cost
 * — a guess recorded as a measurement is worse than a gap.
 */
export async function recordAIFailure(
  context: AICallContext,
  error: unknown,
  occurredAt: Date = new Date(),
): Promise<void> {
  const attempt = providerAttemptOf(error);

  if (attempt === null || attempt.provider === "dummy") {
    return;
  }

  await recordProviderUsage({
    userId: context.userId,
    occurredAt,
    feature: context.feature,
    provider: attempt.provider,
    model: attempt.model,
    usage: attempt.usage ?? UNKNOWN_PROVIDER_USAGE,
    outcome: "error",
    runId: context.runId,
  });

  await observeAIProcessing(context, occurredAt);
}

/**
 * Counts one unit of AI processing against the account's month.
 *
 * **Placed here because here is where "a request was made" is already decided.**
 * The two functions above have exactly one job between them — telling a real
 * provider call from every refusal that never reached one — and duplicating that
 * judgement at six call sites would be six chances to draw the line differently.
 * A stand-in and a pre-provider refusal return before this is reached.
 *
 * **Independent of the event row, deliberately.** Neither write is inside the
 * other's `try`, so a failure to record the tokens does not silently skip the
 * count, and a failure to count does not hide the tokens. The two tables are
 * meant to be reconcilable against each other, which they cannot be if one can
 * only fail together with the other.
 *
 * **Never blocks.** `recordUsageObservation` reports rather than throws.
 */
async function observeAIProcessing(
  context: AICallContext,
  occurredAt: Date,
): Promise<void> {
  await recordUsageObservation(context.userId, "aiProcessing", 1, occurredAt);
}
