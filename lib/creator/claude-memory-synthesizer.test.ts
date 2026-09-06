import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/ai/provider";
import type { CreatorFeedbackContext } from "@/lib/creator/analyzer";
import { ClaudeCreatorMemorySynthesizer } from "@/lib/creator/claude-memory-synthesizer";
import { creatorMemoryLimits, isInvalidCreatorMemory } from "@/lib/creator/memory";

/**
 * What the summariser sends, what it accepts back, and what it refuses.
 *
 * **No request leaves the process.** The same arrangement the analyzer's tests
 * use: the one SDK method that would reach the network is replaced, and a guard
 * turns anything slipping past it into a loud failure rather than a real
 * request to somebody else's server.
 *
 * The block worth reading closely is the last one. A summary is stored and then
 * fed back into every later analysis, so an answer that is empty, truncated or
 * oversized has to be refused here — nothing downstream can tell afterwards
 * that it was ever wrong.
 */

/** A wall, not a stub: this is what catches the replacement not being in place. */
const realFetch = globalThis.fetch;

globalThis.fetch = () => {
  throw new Error("no network in tests");
};

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** **Never restored** — see the note in the analyzer's own tests. */
const create = vi.spyOn(Anthropic.Messages.prototype, "create");

/** The key is never used: the call that would carry it is replaced. */
const synthesizer = new ClaudeCreatorMemorySynthesizer("not-a-real-key");

beforeEach(() => {
  create.mockClear();
});

function sentRequest() {
  return create.mock.calls[create.mock.calls.length - 1][0];
}

function replyWith(
  text: string,
  stopReason: Anthropic.Messages.StopReason = "end_turn",
) {
  create.mockResolvedValue({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Messages.Message);
}

const replyWithSummary = (summary: unknown) =>
  replyWith(JSON.stringify({ summary }));

function pastAnswer(
  overrides: Partial<CreatorFeedbackContext> = {},
): CreatorFeedbackContext {
  return {
    targetChannel: "x",
    verdict: "recommend",
    decisionReason: "It stands on its own.",
    draftBody: "A short post.",
    action: "approve",
    editedBody: null,
    feedbackReason: null,
    contentTitle: "An earlier piece",
    contentExcerpt: "The opening lines.",
    ...overrides,
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  previousSummary: null,
  feedback: [pastAnswer()],
  ...overrides,
});

describe("what it sends", () => {
  it("summarises one answer", async () => {
    replyWithSummary("Has published short posts as proposed.");

    await expect(synthesizer.synthesize(request())).resolves.toBe(
      "Has published short posts as proposed.",
    );
  });

  it("carries the whole batch, in the order it was given", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(
      request({
        feedback: [
          pastAnswer({ contentTitle: "FIRST" }),
          pastAnswer({ contentTitle: "SECOND" }),
          pastAnswer({ contentTitle: "THIRD" }),
        ],
      }),
    );

    const payload = JSON.parse(sentRequest().messages[0].content as string);

    expect(payload.feedback.map((f: CreatorFeedbackContext) => f.contentTitle)).toEqual([
      "FIRST",
      "SECOND",
      "THIRD",
    ]);
  });

  it("carries the previous summary when there is one", async () => {
    replyWithSummary("An updated conclusion.");

    await synthesizer.synthesize(request({ previousSummary: "What was concluded before." }));

    expect(JSON.parse(sentRequest().messages[0].content as string)).toMatchObject({
      previousSummary: "What was concluded before.",
    });
  });

  it("says so when there was none", async () => {
    replyWithSummary("A first conclusion.");

    await synthesizer.synthesize(request());

    expect(JSON.parse(sentRequest().messages[0].content as string)).toMatchObject({
      previousSummary: null,
    });
  });

  /**
   * **The most informative thing an answer holds.** What was proposed and what
   * the person wrote instead only mean something together; sending one without
   * the other would hand over the conclusion and drop the evidence.
   */
  it("keeps both halves of an edit", async () => {
    replyWithSummary("Rewrites for brevity.");

    await synthesizer.synthesize(
      request({
        feedback: [
          pastAnswer({
            action: "edit",
            draftBody: "WHAT WAS PROPOSED",
            editedBody: "WHAT THEY WROTE",
          }),
        ],
      }),
    );

    const raw = sentRequest().messages[0].content as string;

    expect(raw).toContain("WHAT WAS PROPOSED");
    expect(raw).toContain("WHAT THEY WROTE");
  });

  /** Disagreeing with a skip says what they wanted to post, and about what. */
  it("keeps a rejected skip whole", async () => {
    replyWithSummary("Wanted to post about releases.");

    await synthesizer.synthesize(
      request({
        feedback: [
          pastAnswer({
            verdict: "skip",
            action: "reject",
            draftBody: null,
            contentExcerpt: "THE MATERIAL THEY WANTED POSTED",
          }),
        ],
      }),
    );

    const payload = JSON.parse(sentRequest().messages[0].content as string);

    expect(payload.feedback[0]).toMatchObject({
      verdict: "skip",
      action: "reject",
      draftBody: null,
      contentExcerpt: "THE MATERIAL THEY WANTED POSTED",
    });
  });

  /**
   * **Everything the model reads is inside the document.** A previous summary
   * concatenated into the system string would be text Koqentra generated,
   * indistinguishable from the task itself.
   */
  it("never lets evidence reach the system instruction", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(
      request({
        previousSummary: "PREVIOUS-SUMMARY-TEXT",
        feedback: [pastAnswer({ draftBody: "DRAFT-TEXT" })],
      }),
    );

    const system = sentRequest().system as string;

    expect(system).not.toContain("PREVIOUS-SUMMARY-TEXT");
    expect(system).not.toContain("DRAFT-TEXT");
  });

  it("asks for one attempt and no more", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(request());

    expect(create).toHaveBeenCalledTimes(1);
  });

  /**
   * **Nothing to summarise is a caller mistake, not a request to send.** A
   * synthesis over no evidence would either invent something or hand the
   * previous summary back, and either would advance a watermark past answers
   * nobody learned from.
   */
  it("refuses to ask about nothing", async () => {
    await expect(
      synthesizer.synthesize(request({ feedback: [] })),
    ).rejects.toSatisfy(isInvalidCreatorMemory);

    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * What the instruction may not let the summary become.
 *
 * Koqentra has no analytics, no follower counts, no engagement history and no
 * knowledge of any community's rules. A summary inventing one would be handed
 * back into every later analysis as though somebody had said it.
 */
describe("what it asks for", () => {
  it("says the evidence is older and in order", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(request());

    const system = sentRequest().system as string;

    expect(system).toContain("OLDER answers");
    expect(system).toContain("oldest first, newest last");
  });

  /**
   * **The batch is not a later chapter.** What gets summarised is whatever has
   * no membership yet, and an answer can become visible after ones already
   * incorporated while still belonging before them. A model told to read the
   * batch as more recent than the previous summary would report a change over
   * time that nothing in the evidence supports.
   */
  it("says the batch is not necessarily newer than what was summarised", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(request());

    const system = sentRequest().system as string;

    expect(system).toContain("NOT necessarily more recent");
    expect(system).toContain("not as a later chapter");
  });

  it("says the previous summary may itself be wrong", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(request());

    expect(sentRequest().system as string).toContain(
      "itself an inference and may be imperfect",
    );
  });

  it.each([
    "analytics",
    "engagement",
    "follower",
    "performance",
    "Keep contradictions",
    "Keep uncertainty",
    "isolated event",
  ])("tells it about %o", async (phrase) => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(request());

    expect(sentRequest().system as string).toContain(phrase);
  });

  it("asks for an inference rather than a statement", async () => {
    replyWithSummary("A conclusion.");

    await synthesizer.synthesize(request());

    expect(sentRequest().system as string).toContain(
      "not as a statement the person made",
    );
  });
});

/**
 * **A stored summary is read back forever.** Anything unusable has to be caught
 * here, because nothing downstream can tell afterwards that it was wrong.
 */
describe("what it refuses to accept back", () => {
  it.each([
    ["nothing at all", ""],
    ["only whitespace", "   "],
  ])("refuses a summary of %s", async (_name, summary) => {
    replyWithSummary(summary);

    await expect(synthesizer.synthesize(request())).rejects.toSatisfy(
      isInvalidCreatorMemory,
    );
  });

  it("refuses one past the ceiling rather than shortening it", async () => {
    replyWithSummary("x".repeat(creatorMemoryLimits.summary + 1));

    await expect(synthesizer.synthesize(request())).rejects.toSatisfy(
      isInvalidCreatorMemory,
    );
  });

  it("accepts one exactly at the ceiling", async () => {
    const summary = "x".repeat(creatorMemoryLimits.summary);
    replyWithSummary(summary);

    await expect(synthesizer.synthesize(request())).resolves.toBe(summary);
  });

  it.each([
    ["a missing summary", JSON.stringify({})],
    ["a summary that is not text", JSON.stringify({ summary: 42 })],
    ["something that is not an object", JSON.stringify(["a summary"])],
    ["text that is not JSON", "just some prose"],
    ["nothing", ""],
  ])("refuses %s", async (_name, text) => {
    replyWith(text);

    await expect(synthesizer.synthesize(request())).rejects.toSatisfy(
      isInvalidCreatorMemory,
    );
  });

  /** A truncated document would otherwise arrive as a confusing syntax error. */
  it("refuses an answer that ran out of room", async () => {
    replyWith(JSON.stringify({ summary: "half a con" }), "max_tokens");

    await expect(synthesizer.synthesize(request())).rejects.toSatisfy(
      isInvalidCreatorMemory,
    );
  });

  it("refuses a reason this version has never seen", async () => {
    replyWith(
      JSON.stringify({ summary: "A conclusion." }),
      "tool_use" as Anthropic.Messages.StopReason,
    );

    await expect(synthesizer.synthesize(request())).rejects.toSatisfy(
      isInvalidCreatorMemory,
    );
  });

  /** Declining is the provider's outcome, not an unusable answer. */
  it("reads a refusal as a provider failure", async () => {
    replyWith("", "refusal");

    await expect(synthesizer.synthesize(request())).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("carries none of the model's words out with it", async () => {
    replyWithSummary("SECRET-MODEL-TEXT-".repeat(500));

    const error = await synthesizer.synthesize(request()).catch((thrown) => thrown);

    expect(isInvalidCreatorMemory(error)).toBe(true);
    expect((error as Error).message).not.toContain("SECRET-MODEL-TEXT");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("when the request itself fails", () => {
  it.each([
    ["a timeout", new Anthropic.APIConnectionTimeoutError({ message: "slow" }), "timeout"],
    ["an unreachable host", new Anthropic.APIConnectionError({ message: "down" }), "unreachable"],
  ])("reads %s as %s", async (_name, thrown, kind) => {
    create.mockRejectedValue(thrown);

    const error = await synthesizer.synthesize(request()).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(kind);
  });

  it("does not try again", async () => {
    create.mockRejectedValue(new Anthropic.APIConnectionError({ message: "down" }));

    await synthesizer.synthesize(request()).catch(() => {});

    expect(create).toHaveBeenCalledTimes(1);
  });
});
