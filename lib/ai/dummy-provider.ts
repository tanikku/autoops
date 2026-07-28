import type { AIProvider } from "@/lib/ai/provider";

/** Stand-in provider used until a real AI integration lands. */
export class DummyProvider implements AIProvider {
  async execute(prompt: string): Promise<string> {
    void prompt;
    return "Execution completed successfully.";
  }
}
