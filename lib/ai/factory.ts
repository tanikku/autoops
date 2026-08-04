import { ClaudeProvider } from "@/lib/ai/claude-provider";
import { DummyProvider } from "@/lib/ai/dummy-provider";
import type { AIProvider } from "@/lib/ai/provider";

/**
 * Uses Claude when an API key is configured, and the stand-in otherwise.
 *
 * **The fallback is the dangerous half.** A missing key does not fail: the
 * stand-in answers every prompt, so runs are recorded as successes and the
 * health summary stays green. Nothing downstream can tell the difference — by
 * the time a run is written, the provider that produced it is gone.
 *
 * So the choice is announced where it is made. One line, once per process,
 * naming what will happen rather than only what was picked. It is not
 * conditional on the environment: a developer wanting to know their output is
 * fabricated has the same question as an operator wanting to know their
 * deployment is misconfigured.
 */
export function createAIProvider(): AIProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn(
      "[ai] ANTHROPIC_API_KEY is not configured — using the stand-in provider. " +
        "Workers will record successful runs with a fixed response, without calling a model.",
    );

    return new DummyProvider();
  }

  return new ClaudeProvider(apiKey);
}
