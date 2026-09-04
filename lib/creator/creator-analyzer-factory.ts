import "server-only";

import { ClaudeCreatorAnalyzer } from "@/lib/creator/claude-creator-analyzer";
import type { CreatorAnalyzer } from "@/lib/creator/analyzer";

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
