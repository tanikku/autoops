import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeWorkerDraftGenerator } from "@/lib/ai/claude-worker-draft-generator";
import { ProviderError } from "@/lib/ai/provider";
import {
  isInvalidWorkerDraftResponse,
  workerDraftToolNames,
} from "@/lib/ai/worker-draft";

/**
 * What this does with what comes back, including everything that is not an
 * answer.
 *
 * The request asks for exactly one tool call. **Nothing guarantees it gets
 * one** — that is the whole reason these tests exist. A model may answer in
 * prose, call two tools, call a tool nobody offered, or stop halfway through
 * because the token limit arrived. Each has a plausible-looking shape, and each
 * has to end with no draft rather than with a partial one.
 */

/**
 * **A wall, not a stub**, copied from the execution provider's tests for the
 * same reason: a spy that lapses sends a real request to somebody else's
 * server. Anything that gets past the replacement below fails here instead.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = () => {
  throw new Error("no network in tests");
};

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Never restored: restoring it would put the real call back on the prototype. */
const create = vi.spyOn(Anthropic.Messages.prototype, "create");

/** The key is never used — the one call that would carry it is replaced. */
const generator = new ClaudeWorkerDraftGenerator("not-a-real-key");

const CANDIDATES = ["https://example.com/news"];

function request(overrides: Partial<Parameters<typeof generator.generate>[0]> = {}) {
  return {
    request: "Watch https://example.com/news every day and tell me what changed",
    urlCandidates: CANDIDATES,
    ...overrides,
  };
}

function toolUse(name: string, input: unknown) {
  return {
    type: "tool_use" as const,
    id: "toolu_1",
    name,
    input,
    caller: { type: "direct" as const },
  };
}

function text(value: string) {
  return { type: "text" as const, text: value, citations: null };
}

/** A response as the SDK types it, with only the fields this reads. */
function reply(content: unknown[], stopReason = "tool_use") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {},
  } as unknown as Anthropic.Messages.Message;
}

const draftInput = {
  name: "Council notices",
  description: "Watches the notices page.",
  prompt: "Tell me what changed.",
  frequency: "daily",
  runAtMinutes: 540,
};

beforeEach(() => {
  create.mockClear();
});

/** What actually reaches the SDK — the half of the contract callers cannot see. */
function sentRequest() {
  return create.mock.calls[create.mock.calls.length - 1][0] as unknown as Record<
    string,
    unknown
  >;
}

describe("what it asks for", () => {
  beforeEach(() => {
    create.mockResolvedValue(
      reply([toolUse(workerDraftToolNames.prompt, draftInput)]),
    );
  });

  it("offers exactly the three answers it knows how to read", async () => {
    await generator.generate(request());

    const tools = sentRequest().tools as { name: string }[];

    expect(tools.map((tool) => tool.name)).toEqual([
      workerDraftToolNames.prompt,
      workerDraftToolNames.website,
      workerDraftToolNames.unsupported,
    ]);
  });

  /** Prose is not an answer here, and two answers are not either. */
  it("requires a tool, and only one", async () => {
    await generator.generate(request());

    expect(sentRequest().tool_choice).toEqual({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });

  it("keeps its own allowance rather than the execution provider's", async () => {
    await generator.generate(request());

    expect(sentRequest().max_tokens).toBe(2_000);
  });

  /**
   * The addresses are numbered because the answer is a number. A model that is
   * never asked for a URL cannot answer with one it made up.
   */
  it("hands the addresses over as a numbered list", async () => {
    await generator.generate({
      request: "watch these",
      urlCandidates: ["https://a.example.com/", "https://b.example.com/"],
    });

    const message = (sentRequest().messages as { content: string }[])[0];

    expect(message.content).toContain("0. https://a.example.com/");
    expect(message.content).toContain("1. https://b.example.com/");
  });

  it("says so when the request named no address", async () => {
    await generator.generate({ request: "summarise this", urlCandidates: [] });

    const message = (sentRequest().messages as { content: string }[])[0];

    expect(message.content).toContain("none");
  });

  it("tells the model it has not read any page", async () => {
    await generator.generate(request());

    expect(sentRequest().system).toContain("You have not read any web page");
  });

  it("tells the model never to write an address", async () => {
    await generator.generate(request());

    expect(sentRequest().system).toContain("Never write a web address");
  });
});

describe("an answer it can use", () => {
  it("reads a prompt worker", async () => {
    create.mockResolvedValue(
      reply([toolUse(workerDraftToolNames.prompt, draftInput)]),
    );

    await expect(generator.generate(request())).resolves.toMatchObject({
      status: "supported",
      draft: { kind: "prompt", name: "Council notices" },
    });
  });

  it("reads a website worker", async () => {
    create.mockResolvedValue(
      reply([
        toolUse(workerDraftToolNames.website, {
          ...draftInput,
          urlCandidateIndex: 0,
        }),
      ]),
    );

    await expect(generator.generate(request())).resolves.toMatchObject({
      status: "supported",
      draft: { kind: "website", websiteUrl: "https://example.com/news" },
    });
  });

  it("reads a request Koqentra cannot do", async () => {
    create.mockResolvedValue(
      reply([
        toolUse(workerDraftToolNames.unsupported, {
          reason: "Koqentra cannot read email.",
        }),
      ]),
    );

    await expect(
      generator.generate({ request: "read my email", urlCandidates: [] }),
    ).resolves.toEqual({
      status: "unsupported",
      reason: "Koqentra cannot read email.",
    });
  });

  it("asks for an address when a website worker has none to watch", async () => {
    create.mockResolvedValue(
      reply([toolUse(workerDraftToolNames.website, draftInput)]),
    );

    await expect(
      generator.generate({ request: "watch that page", urlCandidates: [] }),
    ).resolves.toMatchObject({ status: "needs_input", field: "websiteUrl" });
  });

  /** A tool call alongside commentary is still one answer. */
  it("reads the tool call even when the model also said something", async () => {
    create.mockResolvedValue(
      reply([
        text("Here is what I would set up:"),
        toolUse(workerDraftToolNames.prompt, draftInput),
      ]),
    );

    await expect(generator.generate(request())).resolves.toMatchObject({
      status: "supported",
    });
  });
});

describe("an answer it refuses", () => {
  const refused = async () => {
    try {
      await generator.generate(request());
    } catch (error) {
      return error;
    }
    throw new Error("expected the generator to refuse");
  };

  it("refuses prose with no tool call", async () => {
    create.mockResolvedValue(reply([text("I would set up a daily worker.")]));

    expect(isInvalidWorkerDraftResponse(await refused())).toBe(true);
  });

  it("refuses an empty answer", async () => {
    create.mockResolvedValue(reply([]));

    expect(isInvalidWorkerDraftResponse(await refused())).toBe(true);
  });

  /** Choosing between two proposals would be this deciding what was asked for. */
  it("refuses two proposals at once", async () => {
    create.mockResolvedValue(
      reply([
        toolUse(workerDraftToolNames.prompt, draftInput),
        toolUse(workerDraftToolNames.website, {
          ...draftInput,
          urlCandidateIndex: 0,
        }),
      ]),
    );

    expect(isInvalidWorkerDraftResponse(await refused())).toBe(true);
  });

  it("refuses a tool it does not offer", async () => {
    create.mockResolvedValue(
      reply([toolUse("create_email_worker_draft", draftInput)]),
    );

    expect(isInvalidWorkerDraftResponse(await refused())).toBe(true);
  });

  it("refuses input that does not survive validation", async () => {
    create.mockResolvedValue(
      reply([
        toolUse(workerDraftToolNames.prompt, {
          ...draftInput,
          frequency: "hourly",
        }),
      ]),
    );

    expect(isInvalidWorkerDraftResponse(await refused())).toBe(true);
  });

  /**
   * The dangerous one: a tool input cut off at the token limit parses as an
   * object and reads as a draft that is merely brief.
   */
  it("refuses an answer that ran out of room", async () => {
    create.mockResolvedValue(
      reply([toolUse(workerDraftToolNames.prompt, draftInput)], "max_tokens"),
    );

    expect(isInvalidWorkerDraftResponse(await refused())).toBe(true);
  });
});

describe("when the provider itself fails", () => {
  const failWith = async (thrown: unknown) => {
    create.mockRejectedValue(thrown);

    try {
      await generator.generate(request());
    } catch (error) {
      return error;
    }
    throw new Error("expected the generator to fail");
  };

  it("names a timeout as one", async () => {
    const error = await failWith(
      new Anthropic.APIConnectionTimeoutError({ message: "timed out" }),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("timeout");
  });

  it("names an unreachable provider as one", async () => {
    const error = await failWith(new Anthropic.APIConnectionError({}));

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("unreachable");
  });

  it("names anything else it cannot place", async () => {
    const error = await failWith(new Error("something else"));

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("unknown");
  });

  /** The SDK's own types stop here, as they do for execution. */
  it("does not let the SDK's error out", async () => {
    const error = await failWith(new Anthropic.APIConnectionError({}));

    expect(error).not.toBeInstanceOf(Anthropic.APIConnectionError);
    expect((error as Error).name).toBe("ProviderError");
  });

  it("keeps the original as the cause", async () => {
    const thrown = new Error("something else");
    const error = await failWith(thrown);

    expect((error as ProviderError).cause).toBe(thrown);
  });
});
