import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "@/lib/ai/provider";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;

/**
 * How long one request may take.
 *
 * The same ten minutes the SDK would have worked out for itself from
 * `MAX_TOKENS`, stated here so it is a decision rather than a default. Shorter
 * would cut off generations that are still going: sixteen thousand tokens can
 * legitimately take minutes.
 *
 * Setting it does mean the SDK stops calculating one, and with it stops
 * refusing token counts too large to finish in ten minutes. Raising
 * `MAX_TOKENS` past roughly 21,000 would need this raised — or the request
 * streamed — rather than being told so.
 */
const TIMEOUT_MS = 600_000;

/**
 * **No retries.** The SDK would otherwise try three times, and nobody chose
 * that: a timed-out generation is billed whether or not it is used, so the
 * default quietly turns one late worker into thirty minutes and three charges.
 *
 * Retrying is a policy, and AutoOps holds none here — the dispatcher does not,
 * and this is not the layer to smuggle one in. A failure is recorded as a
 * `failed` run and the worker comes round again at its next slot, which is the
 * same answer every other kind of failure gets.
 *
 * The cost is that a rate limit or a passing 5xx now fails the run rather than
 * being absorbed. That is visible in the run history, which is where a decision
 * to add a retry policy should come from.
 */
const MAX_RETRIES = 0;

export class ClaudeProvider implements AIProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      timeout: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }

  async execute(prompt: string): Promise<string> {
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });

    if (message.stop_reason === "refusal") {
      throw new Error("Claude declined to answer this prompt.");
    }

    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
}
