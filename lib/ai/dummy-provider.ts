import type {
  AIExecutionRequest,
  AIExecutionResult,
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
 *
 * **It reports no usage, because there is none.** Nothing was sent, nothing was
 * charged, and a row saying a call happened would be an invented cost in a
 * table whose only purpose is to say what things really cost. `usage: null` and
 * `provider: "dummy"` are both how a caller knows there is nothing to record —
 * see `recordAIExecution`, which refuses to write one.
 */
export class DummyProvider implements AIProvider {
  readonly mode: AIProviderMode = "dummy";

  async execute(request: AIExecutionRequest): Promise<AIExecutionResult> {
    void request;

    return {
      // The same sentence, unchanged. Anything reading `text` sees exactly
      // what it saw before the result had a shape around it.
      text: "Execution completed successfully.",
      provider: "dummy",
      // **A name, not a model.** Nothing was asked of anything, and putting a
      // real model's name here would make a fabricated answer look sourced.
      model: "stand-in",
      usage: null,
    };
  }
}
