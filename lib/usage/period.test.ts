import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening the period an allowance is measured over.
 *
 * **Nothing opens one during ordinary use.** No sign-in, no worker, no run: the
 * table is empty on this version, which is the honest state of a deployment
 * that is not counting anything. What these fix is the shape of the write, so
 * the phase that does start counting inherits it.
 *
 * The property worth fixing is that a period and its counters arrive together.
 * A period without counters is an allowance nobody can spend against, and the
 * next caller would have to decide whether to finish somebody else's half-built
 * one.
 */

const { findUnique, create } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { usagePeriod: { findUnique, create } },
}));

const { openOrGetUsagePeriod } = await import("@/lib/usage/period");

const USER = "google-sub-1";
const START = new Date("2026-09-20T00:00:00.000Z");
const END = new Date("2026-10-20T00:00:00.000Z");

const WINDOW = {
  userId: USER,
  periodStart: START,
  periodEnd: END,
  plan: "standard",
} as const;

function stored(counters: { kind: string; used: number; limit: number }[]) {
  return {
    id: "usage-period-1",
    periodStart: START,
    periodEnd: END,
    planAtStart: "standard",
    counters,
  };
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  findUnique.mockReset();
  create.mockReset();
});

describe("a period that is already open", () => {
  it("is read rather than opened again", async () => {
    findUnique.mockResolvedValue(
      stored([{ kind: "aiProcessing", used: 12, limit: 150 }]),
    );

    const period = await openOrGetUsagePeriod(WINDOW);

    expect(period.id).toBe("usage-period-1");
    expect(period.counters).toEqual([
      { kind: "aiProcessing", used: 12, limit: 150 },
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("is looked up by the account and the instant it started", async () => {
    findUnique.mockResolvedValue(stored([]));

    await openOrGetUsagePeriod(WINDOW);

    expect(findUnique.mock.calls[0][0].where).toEqual({
      userId_periodStart: { userId: USER, periodStart: START },
    });
  });
});

describe("opening a period", () => {
  beforeEach(() => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue(
      stored([
        { kind: "aiProcessing", used: 0, limit: 150 },
        { kind: "manualRun", used: 0, limit: 100 },
        { kind: "discovery", used: 0, limit: 60 },
      ]),
    );
  });

  /**
   * **The period and its counters are one write.** Two writes would leave a
   * period with no allowances in between, and the caller that found it would
   * have to guess whether to complete it.
   */
  it("creates the counters with the period", async () => {
    await openOrGetUsagePeriod(WINDOW);

    expect(create.mock.calls[0][0].data.counters.create).toEqual([
      { kind: "aiProcessing", used: 0, limit: 150 },
      { kind: "manualRun", used: 0, limit: 100 },
      { kind: "discovery", used: 0, limit: 60 },
    ]);
  });

  it("opens all three allowances, not one", async () => {
    await openOrGetUsagePeriod(WINDOW);

    expect(
      create.mock.calls[0][0].data.counters.create.map(
        (counter: { kind: string }) => counter.kind,
      ),
    ).toEqual(["aiProcessing", "manualRun", "discovery"]);
  });

  it("starts every allowance at nothing spent", async () => {
    await openOrGetUsagePeriod(WINDOW);

    for (const counter of create.mock.calls[0][0].data.counters.create) {
      expect(counter.used).toBe(0);
    }
  });

  /**
   * **The plan is copied onto the row.** What a period was opened under cannot
   * be recovered afterwards, and it is exactly what a question about a charge
   * needs to know.
   */
  it("records the plan the period was opened under", async () => {
    await openOrGetUsagePeriod(WINDOW);

    expect(create.mock.calls[0][0].data.planAtStart).toBe("standard");
  });

  it.each([
    ["trial", 50, 20, 14],
    ["lite", 30, 20, 10],
    ["pro", 300, 300, 150],
    ["beta", 300, 300, 150],
  ])(
    "takes %o's own limits",
    async (plan, aiProcessing, manualRun, discovery) => {
      await openOrGetUsagePeriod({ ...WINDOW, plan });

      expect(create.mock.calls[0][0].data.counters.create).toEqual([
        { kind: "aiProcessing", used: 0, limit: aiProcessing },
        { kind: "manualRun", used: 0, limit: manualRun },
        { kind: "discovery", used: 0, limit: discovery },
      ]);
    },
  );
});

describe("two callers opening the same period at once", () => {
  /**
   * **The constraint decides, and the loser reads.** It wanted the period
   * rather than the creating of it, so what the other made is the answer — and
   * the allowance is opened once rather than twice.
   */
  it("reads back the period the other one made", async () => {
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        stored([{ kind: "aiProcessing", used: 1, limit: 150 }]),
      );
    create.mockRejectedValue(uniqueViolation());

    const period = await openOrGetUsagePeriod(WINDOW);

    expect(period.counters).toEqual([
      { kind: "aiProcessing", used: 1, limit: 150 },
    ]);
  });

  /**
   * The constraint said the row exists. If it cannot be read, the failure was
   * something else wearing the same code — and inventing a period here would
   * hand out an allowance nobody opened.
   */
  it("refuses to invent a period when the row it was told about is not there", async () => {
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    await expect(openOrGetUsagePeriod(WINDOW)).rejects.toThrow();
  });

  it("does not absorb a failure that is not a collision", async () => {
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(new Error("connection lost"));

    await expect(openOrGetUsagePeriod(WINDOW)).rejects.toThrow("connection lost");
  });
});

describe("a stored counter this version does not know", () => {
  /**
   * **Left out rather than reported.** A kind written by a later version is not
   * an allowance this one can reason about, and passing it along as one would
   * be inventing it.
   */
  it("is not reported as an allowance", async () => {
    findUnique.mockResolvedValue(
      stored([
        { kind: "aiProcessing", used: 1, limit: 150 },
        { kind: "websiteFetch", used: 9, limit: 99 },
      ]),
    );

    const period = await openOrGetUsagePeriod(WINDOW);

    expect(period.counters).toEqual([
      { kind: "aiProcessing", used: 1, limit: 150 },
    ]);
  });
});

describe("a plan the catalogue does not know", () => {
  it("opens nothing", async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      openOrGetUsagePeriod({ ...WINDOW, plan: "enterprise" }),
    ).rejects.toThrow();

    expect(create).not.toHaveBeenCalled();
  });
});
