import "server-only";

import { prisma } from "@/lib/prisma";
import type { ProviderUsageEventInput } from "@/lib/usage/types";

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
