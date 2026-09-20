import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNKNOWN_PROVIDER_USAGE,
  type ProviderUsageEventInput,
} from "@/lib/usage/types";

/**
 * Writing down what one call to a model used.
 *
 * **Nothing calls this.** The four provider adapters still discard what they
 * are told about a call's cost, and wiring them up is the next phase. What is
 * fixed here is the write itself — the columns it fills, the ones it has no way
 * to fill, and that a failure to write goes no further than a log line.
 *
 * **Best-effort is a contract, not a shortcut.** If this threw, a run that
 * succeeded would be recorded as failed, a draft somebody was waiting for would
 * disappear, and an analysis that cost real money would be reported as not
 * having happened — all because a bookkeeping row could not be written.
 * Observation that changes what it observes is worth less than none.
 */

const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { providerUsageEvent: { create } },
}));

const { recordProviderUsage } = await import("@/lib/usage/record");

const OCCURRED_AT = new Date("2026-09-20T12:00:00.000Z");
const USER = "google-sub-1";

function event(
  overrides: Partial<ProviderUsageEventInput> = {},
): ProviderUsageEventInput {
  return {
    userId: USER,
    occurredAt: OCCURRED_AT,
    feature: "prompt",
    provider: "anthropic",
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
    outcome: "ok",
    runId: "run-1",
    ...overrides,
  };
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The data of the only `create`. */
function written() {
  return create.mock.calls[0][0].data;
}

describe("what is written down", () => {
  it("records the call as it was described", async () => {
    await recordProviderUsage(event());

    expect(written()).toEqual({
      userId: USER,
      occurredAt: OCCURRED_AT,
      feature: "prompt",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      outcome: "ok",
      runId: "run-1",
    });
  });

  /**
   * **Null and zero are both kept, and they mean different things.** A provider
   * that reported no cached reads said something; one that reported nothing at
   * all did not. Collapsing the second into `0` would make a call of unknown
   * cost indistinguishable from a free one, for good.
   */
  it("keeps a reported zero apart from an unknown", async () => {
    await recordProviderUsage(event());

    expect(written().cacheReadTokens).toBe(0);
    expect(written().cacheWriteTokens).toBeNull();
  });

  it("writes nulls rather than zeroes when a call reported no usage", async () => {
    await recordProviderUsage(
      event({ outcome: "error", usage: UNKNOWN_PROVIDER_USAGE }),
    );

    expect(written().inputTokens).toBeNull();
    expect(written().outputTokens).toBeNull();
    expect(written().cacheReadTokens).toBeNull();
    expect(written().cacheWriteTokens).toBeNull();
  });

  /**
   * **A run id when there is a run, and null when there is not.** Drafts and
   * Creator analyses write no run history at all, and inventing an id for them
   * would be a claim about something that does not exist.
   */
  it.each(["draft", "creator-analysis", "creator-memory"] as const)(
    "leaves the run empty for %o",
    async (feature) => {
      await recordProviderUsage(event({ feature, runId: null }));

      expect(written().runId).toBeNull();
    },
  );

  it.each(["prompt", "website", "discovery"] as const)(
    "keeps the run it belonged to for %o",
    async (feature) => {
      await recordProviderUsage(event({ feature, runId: "run-7" }));

      expect(written().runId).toBe("run-7");
    },
  );
});

/**
 * **Knowing what a call cost has never required keeping what it said.** The
 * input has nowhere to put a prompt, an answer, an address, a key, a header or
 * a provider's raw response, which is the only reliable way to keep them out.
 */
describe("what is never written down", () => {
  it("writes exactly the columns it is meant to and no others", async () => {
    await recordProviderUsage(event());

    expect(Object.keys(written())).toEqual([
      "userId",
      "occurredAt",
      "feature",
      "provider",
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outcome",
      "runId",
    ]);
  });

  it.each([
    "prompt",
    "output",
    "body",
    "url",
    "apiKey",
    "headers",
    "response",
    "error",
    "stack",
  ])("has no column called %o", async (column) => {
    await recordProviderUsage(event());

    expect(Object.keys(written())).not.toContain(column);
  });
});

describe("when the row cannot be written", () => {
  /**
   * The property this phase exists to establish: the caller carries on. Nothing
   * about a run, a draft or an analysis changes because bookkeeping failed.
   */
  it("does not throw", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await expect(recordProviderUsage(event())).resolves.toBeUndefined();
  });

  it("says so once, naming the path rather than the call", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await recordProviderUsage(event({ feature: "website", outcome: "error" }));

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];

    expect(logged).toContain("website");
    expect(logged).toContain("error");
  });

  /**
   * **A log line is a place material ends up just as much as a column is.** The
   * event is not logged, so a failing write cannot become the leak the table
   * was shaped to avoid.
   */
  it("does not log the event itself", async () => {
    create.mockRejectedValue(new Error("connection lost"));

    await recordProviderUsage(event());

    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0],
    );

    expect(logged).not.toContain(USER);
    expect(logged).not.toContain("run-1");
  });
});
