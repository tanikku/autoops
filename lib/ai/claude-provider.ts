import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "@/lib/ai/provider";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 16000;

export class ClaudeProvider implements AIProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
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
