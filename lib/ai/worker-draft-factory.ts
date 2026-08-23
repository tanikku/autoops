import { ClaudeWorkerDraftGenerator } from "@/lib/ai/claude-worker-draft-generator";
import type { WorkerDraftGenerator } from "@/lib/ai/worker-draft";

/**
 * The generator, or nothing.
 *
 * **Null is the fail-closed answer, and it is why there is no stand-in.**
 * `createAIProvider` falls back to `DummyProvider` because a worker's run has
 * to produce *something* for a developer with no key, and the danger of that —
 * a fabricated answer recorded as a success — is met by callers asking `mode`
 * before they trust it.
 *
 * Drafting cannot take that shape. A stand-in here would not return a fixed
 * sentence to be looked at and dismissed: it would return **settings**, filled
 * into a form, ready to be saved by somebody who reasonably assumed a model
 * wrote them. The worker created from it would be real. So an unconfigured
 * deployment gets no generator, and the caller has one thing it can do with
 * that — say so.
 *
 * The absence is checked by the caller rather than announced here. Unlike the
 * execution factory, this is reached only when somebody presses a button, so a
 * warning at process start would describe a feature nobody had asked for yet.
 */
export function createWorkerDraftGenerator(): WorkerDraftGenerator | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new ClaudeWorkerDraftGenerator(apiKey);
}
