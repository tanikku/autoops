import "server-only";

import { ClaudeCreatorAnalyzer } from "@/lib/creator/claude-creator-analyzer";
import { ClaudeCreatorMemorySynthesizer } from "@/lib/creator/claude-memory-synthesizer";
import type { CreatorAnalyzer } from "@/lib/creator/analyzer";
import type { CreatorMemorySynthesizer } from "@/lib/creator/memory";

/**
 * The analyzer, or nothing at all.
 *
 * **No stand-in.** `createAIProvider` falls back to `DummyProvider` because a
 * worker recording a fixed line is visibly a placeholder and costs a run
 * nothing. An editorial judgement is not like that: a made-up recommendation
 * reads exactly like a real one, and somebody would publish it. Returning null
 * makes the missing key a feature that is absent rather than a feature that
 * lies, which is what `createWorkerDraftGenerator` already does.
 *
 * The key is read on each call rather than at import: nothing is built to hold
 * on to, so an environment that gains the variable starts working on the next
 * request instead of the next restart.
 *
 * **`server-only`, like the implementation it builds.** Reading
 * `ANTHROPIC_API_KEY` is a server act; a Client Component that imported this
 * would find the variable undefined and quietly get null, which reads as "no
 * key configured" rather than as the mistake it is. Failing the build says so.
 */
export function createCreatorAnalyzer(): CreatorAnalyzer | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new ClaudeCreatorAnalyzer(apiKey);
}

/**
 * The memory synthesizer, or nothing at all.
 *
 * **Its absence is not the analyzer's absence.** Without a key neither exists,
 * and the analyzer being null is what makes Creator unavailable — but the two
 * are asked for separately so that a deployment which can judge a piece of
 * writing is never stopped from doing so by the optional step that summarises
 * old answers. A missing synthesizer means the summary stays where it was; a
 * missing analyzer means there is nothing to say.
 *
 * **No stand-in, for the same reason as above.** An invented summary would be
 * fed back into every later analysis as though it had been derived from
 * something.
 */
export function createCreatorMemorySynthesizer(): CreatorMemorySynthesizer | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new ClaudeCreatorMemorySynthesizer(apiKey);
}
