import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PROMPT_AI_MAX_TOKENS, PROMPT_AI_TIMEOUT_MS } from "@/lib/runs";
import { DISCOVERY_AI_MAX_TOKENS, DISCOVERY_AI_TIMEOUT_MS } from "@/lib/discovery/select";
import {
  WEBSITE_AI_MAX_TOKENS,
  WEBSITE_AI_TIMEOUT_MS,
} from "@/lib/watcher/website-request";

/**
 * Every model call's model, output limit, deadline and retry count, in one
 * place.
 *
 * **What a cost decision rests on, fixed so it cannot drift by accident.** The
 * three callers of the shared provider each name their own output limit; the
 * three adapters with their own client keep theirs. Changing any of these is a
 * pricing decision, and this is where it has to be made on purpose.
 *
 * **Read off the sources for the adapters' private constants**, which nothing
 * exports and nothing should.
 */

vi.mock("server-only", () => ({}));

/** The value of `const NAME = …;` in an adapter's source. */
function constant(file: string, name: string): string {
  const match = new RegExp(`^const ${name} = (.+);$`, "m").exec(
    readFileSync(file, "utf8"),
  );

  expect(match, `${file} declares ${name}`).not.toBeNull();

  return match?.[1] ?? "";
}

describe("the shared provider's callers", () => {
  it.each([
    ["prompt", PROMPT_AI_MAX_TOKENS, 10_000, PROMPT_AI_TIMEOUT_MS, 180_000],
    ["website", WEBSITE_AI_MAX_TOKENS, 2_000, WEBSITE_AI_TIMEOUT_MS, 120_000],
    ["discovery", DISCOVERY_AI_MAX_TOKENS, 4_000, DISCOVERY_AI_TIMEOUT_MS, 120_000],
  ])("%s names its own limit and keeps its deadline", (_feature, limit, expected, timeout, expectedTimeout) => {
    expect(limit).toBe(expected);
    expect(timeout).toBe(expectedTimeout);
  });
});

describe("the adapters", () => {
  it.each([
    ["lib/ai/claude-provider.ts", '"claude-opus-5"', "16000", "600_000"],
    ["lib/ai/claude-worker-draft-generator.ts", '"claude-opus-5"', "2_000", "30_000"],
    ["lib/creator/claude-creator-analyzer.ts", '"claude-sonnet-5"', "12_000", "60_000"],
    ["lib/creator/claude-memory-synthesizer.ts", '"claude-sonnet-5"', "4_000", "30_000"],
  ])("%s keeps its model, limit, deadline and no retries", (file, model, maxTokens, timeout) => {
    expect(constant(file, "MODEL")).toBe(model);
    expect(constant(file, "MAX_TOKENS")).toBe(maxTokens);
    expect(constant(file, "TIMEOUT_MS")).toBe(timeout);
    expect(constant(file, "MAX_RETRIES")).toBe("0");
  });
});
