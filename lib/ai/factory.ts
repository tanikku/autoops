import { ClaudeProvider } from "@/lib/ai/claude-provider";
import { DummyProvider } from "@/lib/ai/dummy-provider";
import type { AIProvider } from "@/lib/ai/provider";

/** Uses Claude when an API key is configured, and the stand-in otherwise. */
export function createAIProvider(): AIProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? new ClaudeProvider(apiKey) : new DummyProvider();
}
