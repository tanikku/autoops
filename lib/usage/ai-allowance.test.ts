import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI processing allowance as its callers ask for it.
 *
 * **The spending itself is `spendAllowances`', and is stood in for here.** What
 * it does against a database — the conditional write, the pre-trial pool, two
 * spenders racing for the last unit — is `lib/usage/consume.test.ts` and the
 * PostgreSQL suite. What these fix is the translation every caller relies on:
 * one unit of AI processing asked for, and every answer that is not a grant
 * turned into a reason not to send the request.
 */

const { spendAllowances } = vi.hoisted(() => ({ spendAllowances: vi.fn() }));

vi.mock("@/lib/usage/consume", () => ({ spendAllowances }));

const {
  AI_ALLOWANCE_EXHAUSTED_MESSAGE,
  AI_ALLOWANCE_UNAVAILABLE_MESSAGE,
  AiAllowanceRefusedError,
  aiAllowanceRefusalOf,
  aiAllowanceRefusalOfRun,
  aiAllowanceRunMessage,
  reserveAiProcessing,
} = await import("@/lib/usage/ai-allowance");

beforeEach(() => {
  spendAllowances.mockReset().mockResolvedValue({ granted: true });
});

describe("reserveAiProcessing", () => {
  it("asks for exactly one unit of AI processing for the account", async () => {
    await reserveAiProcessing("user-1");

    expect(spendAllowances).toHaveBeenCalledTimes(1);
    expect(spendAllowances).toHaveBeenCalledWith({
      userId: "user-1",
      items: [{ kind: "aiProcessing", units: 1 }],
    });
  });

  it("answers null when the unit was taken", async () => {
    expect(await reserveAiProcessing("user-1")).toBeNull();
  });

  it.each([
    [{ granted: false, reason: "exhausted", kind: "aiProcessing", scope: "period" }],
    [{ granted: false, reason: "exhausted", kind: "aiProcessing", scope: "pre-trial" }],
  ])("answers exhausted when the allowance is spent (%o)", async (result) => {
    spendAllowances.mockResolvedValue(result);

    expect(await reserveAiProcessing("user-1")).toBe("exhausted");
  });

  /** Every other refusal still means the request is not sent. */
  it.each([
    [{ granted: false, reason: "not-entitled" }],
    [{ granted: false, reason: "not-counted" }],
    [{ granted: false, reason: "unknown-counter", kind: "aiProcessing" }],
  ])("answers unavailable for %o", async (result) => {
    spendAllowances.mockResolvedValue(result);

    expect(await reserveAiProcessing("user-1")).toBe("unavailable");
  });

  it("lets a database failure through rather than guessing", async () => {
    spendAllowances.mockRejectedValue(new Error("connection lost"));

    await expect(reserveAiProcessing("user-1")).rejects.toThrow("connection lost");
  });
});

describe("a refusal carried as an error", () => {
  it.each(["exhausted", "unavailable"] as const)("carries %s", (refusal) => {
    expect(aiAllowanceRefusalOf(new AiAllowanceRefusedError(refusal))).toBe(refusal);
  });

  it("is null for anything else", () => {
    expect(aiAllowanceRefusalOf(new Error("AI processing allowance refused"))).toBeNull();
    expect(aiAllowanceRefusalOf("exhausted")).toBeNull();
  });
});

describe("a refusal recorded on a run", () => {
  it.each(["exhausted", "unavailable"] as const)(
    "reads back the %s refusal it wrote",
    (refusal) => {
      expect(
        aiAllowanceRefusalOfRun({
          status: "failed",
          errorMessage: aiAllowanceRunMessage(refusal),
        }),
      ).toBe(refusal);
    },
  );

  it("keeps the two sentences apart", () => {
    expect(AI_ALLOWANCE_EXHAUSTED_MESSAGE).not.toBe(AI_ALLOWANCE_UNAVAILABLE_MESSAGE);
  });

  it.each([
    [{ status: "failed", errorMessage: "the model took too long" }],
    [{ status: "failed", errorMessage: null }],
    [{ status: "completed", errorMessage: AI_ALLOWANCE_EXHAUSTED_MESSAGE }],
    [{ status: "running", errorMessage: null }],
  ])("is null for any other outcome (%o)", (run) => {
    expect(aiAllowanceRefusalOfRun(run)).toBeNull();
  });
});
