import type {
  AIExecutionRequest,
  AIProvider,
  AIProviderMode,
} from "@/lib/ai/provider";

/**
 * Stand-in provider used when no API key is configured.
 *
 * **It answers everything, and that is the danger it carries.** A run using it
 * is recorded as a success with a fixed sentence, and nothing downstream can
 * tell that sentence apart from a model's. Announcing what it is, rather than
 * hiding it, is why `mode` exists: a caller for whom a fabricated answer would
 * be worse than no answer can ask before calling.
 */
export class DummyProvider implements AIProvider {
  readonly mode: AIProviderMode = "dummy";

  async execute(request: AIExecutionRequest): Promise<string> {
    void request;
    return "Execution completed successfully.";
  }
}
