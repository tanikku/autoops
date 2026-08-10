import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "@/lib/ai/claude-provider";
import { ProviderError } from "@/lib/ai/provider";

/**
 * What each way of failing is called, fixed from outside the provider.
 *
 * These go through `execute` rather than at the classifier directly, for two
 * reasons. The kind is only ever observed from out here — nothing inside
 * `lib/ai` reads it — and **a refusal never reaches the classifier at all**: it
 * arrives as a perfectly ordinary response and is turned into a failure by a
 * separate check. Testing the classifier alone would leave the one kind that
 * is not a classification uncovered, and blur the line this is meant to hold.
 *
 * **No request is made.** The SDK's own error classes are plain constructors,
 * and the one method that would reach the network is replaced, so nothing here
 * needs a key or a connection. What is *not* asserted is how the SDK builds
 * those errors — only that a given one is named the way AutoOps names it.
 */

/**
 * **A wall, not a stub.** The replacement below is what these tests rely on;
 * this is what catches it not being in place. Without it a lapsed spy sends a
 * real request instead of failing — silently, and to somebody else's server.
 * Anything that gets past the stub now surfaces as a connection failure here.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = () => {
  throw new Error("no network in tests");
};

// Put back what was here. The client below has already taken its own reference
// to the guard — the SDK reads the global once, when it is constructed — so
// this changes nothing for these tests and leaves nothing behind for anyone
// else's.
afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stands in for the one call that would leave the process.
 *
 * **Never restored.** Restoring it puts the real method back on the prototype
 * while this handle keeps accepting `mockResolvedValue` — every call after
 * that goes to the network. Vitest gives each test file its own module
 * registry, so leaving it in place affects nothing else.
 */
const create = vi.spyOn(Anthropic.Messages.prototype, "create");

/** The key is never used: the call that would carry it is replaced. */
const provider = new ClaudeProvider("not-a-real-key");

/**
 * A response the SDK would return, with `overrides` applied.
 *
 * **Only the two fields this provider reads are set.** A complete `Message`
 * drags in a dozen types — usage counts, container, cache statistics — that
 * say nothing about how a failure gets named, and coupling these tests to them
 * would mean an unrelated change to the SDK's response shape breaking them.
 * The cast is confined here so the tests below stay about kinds.
 */
function response(
  overrides: Record<string, unknown> = {},
): Parameters<typeof create.mockResolvedValue>[0] {
  return {
    content: [{ type: "text", text: "an answer" }],
    stop_reason: "end_turn",
    ...overrides,
  } as unknown as Parameters<typeof create.mockResolvedValue>[0];
}

/** The kind `execute` reports for a provider that threw `error`. */
async function kindFor(error: unknown): Promise<unknown> {
  create.mockRejectedValue(error);
  return provider.execute("prompt").then(
    () => undefined,
    (thrown: unknown) => (thrown as ProviderError).kind,
  );
}

// Clears the call history only. `mockReset` would put the real method back.
beforeEach(() => {
  create.mockClear();
});

describe("a request that never arrived", () => {
  /**
   * `APIConnectionTimeoutError` extends `APIConnectionError`, so the order the
   * two are checked in is the whole difference between these two kinds.
   */
  it("calls a timeout a timeout, not an unreachable provider", async () => {
    expect(await kindFor(new Anthropic.APIConnectionTimeoutError({}))).toBe(
      "timeout",
    );
  });

  it("calls a connection failure unreachable", async () => {
    expect(
      await kindFor(new Anthropic.APIConnectionError({ message: "no route" })),
    ).toBe("unreachable");
  });
});

describe("a response the provider refused to give", () => {
  const byStatus: Array<[number, string]> = [
    [400, "invalid-request"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "invalid-request"],
    [413, "invalid-request"],
    [422, "invalid-request"],
    [429, "rate-limited"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
  ];

  it.each(byStatus)("calls %i %s", async (status, kind) => {
    expect(
      await kindFor(new Anthropic.APIError(status, undefined, "no", undefined)),
    ).toBe(kind);
  });

  /**
   * A status nobody listed is only known to be a client error, which says
   * nothing about whether asking again would help.
   */
  it("calls an unlisted 4xx unknown", async () => {
    expect(
      await kindFor(new Anthropic.APIError(418, undefined, "no", undefined)),
    ).toBe("unknown");
  });
});

describe("something else entirely", () => {
  it("calls an ordinary error unknown", async () => {
    expect(await kindFor(new Error("something went wrong"))).toBe("unknown");
  });

  /**
   * The two connection classes carry no status, and so does an `APIError`
   * built without one — there is nothing to sort it by.
   */
  it("calls an API error with no status unknown", async () => {
    expect(
      await kindFor(
        new Anthropic.APIError(undefined, undefined, "no", undefined),
      ),
    ).toBe("unknown");
  });

  /**
   * Something thrown that is not an `Error` has no message to carry forward
   * and nothing to classify, so it passes straight through — which is what
   * leaves `runRoutine`'s own fallback the thing that handles it.
   */
  it("lets a thrown non-Error through untouched", async () => {
    create.mockRejectedValue("just a string");

    await expect(provider.execute("prompt")).rejects.toBe("just a string");
  });
});

describe("what crosses the boundary", () => {
  it("is a ProviderError, never the SDK's own type", async () => {
    const sdkError = new Anthropic.APIError(429, undefined, "slow down", undefined);
    create.mockRejectedValue(sdkError);

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).not.toBeInstanceOf(Anthropic.APIError);
  });

  /**
   * The message is the provider's own, unchanged — it is what a failed run
   * records, and an observation that rewrote what it observed would be worth
   * nothing.
   */
  it("carries the provider's wording exactly", async () => {
    const sdkError = new Anthropic.APIError(429, undefined, "slow down", undefined);
    create.mockRejectedValue(sdkError);

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown.message).toBe(sdkError.message);
  });

  it("keeps the original as its cause", async () => {
    const sdkError = new Anthropic.APIError(500, undefined, "boom", undefined);
    create.mockRejectedValue(sdkError);

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown.cause).toBe(sdkError);
  });
});

/**
 * **A refusal is not a classification.** It arrives as a successful response
 * and is turned into a failure here rather than by sorting an exception, so it
 * is the one kind that never passes through the status checks above.
 */
describe("a refusal", () => {
  it("is a failure even though the request succeeded", async () => {
    create.mockResolvedValue(response({ stop_reason: "refusal" }));

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown.kind).toBe("refused");
  });

  it("says so in the wording the run will record", async () => {
    create.mockResolvedValue(response({ stop_reason: "refusal" }));

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown.message).toBe("Claude declined to answer this prompt.");
  });

  it("has no cause, because nothing was thrown", async () => {
    create.mockResolvedValue(response({ stop_reason: "refusal" }));

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown.cause).toBeUndefined();
  });
});

/**
 * The failure that started this file.
 *
 * A spy that has been restored keeps accepting `mockResolvedValue` while the
 * real method sits back on the prototype, so a test that looks stubbed sends a
 * request instead. **`unreachable` is what proves it did not.** A request that
 * actually left would come back `401` with the fake key above, and be named
 * `unauthorized` — so the two outcomes are told apart by the kind itself.
 */
describe("with no stub in place", () => {
  it("is stopped before the network rather than by it", async () => {
    create.mockReset(); // puts the real method back, exactly as the accident did

    const thrown = await provider.execute("prompt").catch((error) => error);

    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown.kind).toBe("unreachable");
    expect(thrown.kind).not.toBe("unauthorized");
  });
});

describe("a response that worked", () => {
  it("returns the text", async () => {
    create.mockResolvedValue(response());

    expect(await provider.execute("prompt")).toBe("an answer");
  });

  it("joins several text blocks with newlines", async () => {
    create.mockResolvedValue(
      response({
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    );

    expect(await provider.execute("prompt")).toBe("first\nsecond");
  });

  it("ignores blocks that are not text", async () => {
    create.mockResolvedValue(
      response({
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "the answer" },
        ],
      }),
    );

    expect(await provider.execute("prompt")).toBe("the answer");
  });

  it("trims what it returns", async () => {
    create.mockResolvedValue(
      response({ content: [{ type: "text", text: "  padded  " }] }),
    );

    expect(await provider.execute("prompt")).toBe("padded");
  });
});
