import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Counting what accounts use, without letting the count stop them.
 *
 * **The property under test is that nothing is refused.** `consumeUsage` exists
 * to say no; this exists to say what happened. A counter that stopped at its
 * limit would make the one month Koqentra has never measured look exactly like
 * a month that fitted, and the whole point of this phase is to find out whether
 * it does.
 *
 * **The second property is that it cannot break anything.** Every failure ends
 * in a log line and an answer, so a run, a draft or an analysis carries on with
 * bookkeeping that simply did not happen.
 */

const { findUnique, create, updateMany, subscriptionFindUnique } = vi.hoisted(
  () => ({
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    subscriptionFindUnique: vi.fn(),
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    usagePeriod: { findUnique, create },
    usageCounter: { updateMany },
    subscription: { findUnique: subscriptionFindUnique },
  },
}));

const {
  OBSERVATION_PLAN,
  observationWindowFor,
  recordUsageObservation,
  resolveUsageWindow,
} = await import("@/lib/usage/observe");

const USER = "google-sub-1";
const SEPTEMBER = new Date("2026-09-21T08:58:41.000Z");
const SEPTEMBER_START = new Date("2026-09-01T00:00:00.000Z");
const OCTOBER_START = new Date("2026-10-01T00:00:00.000Z");

function storedPeriod(used = 0) {
  return {
    id: "usage-period-1",
    periodStart: SEPTEMBER_START,
    periodEnd: OCTOBER_START,
    planAtStart: "beta",
    counters: [
      { kind: "aiProcessing", used, limit: 300 },
      { kind: "manualRun", used: 0, limit: 300 },
      { kind: "discovery", used: 0, limit: 150 },
    ],
  };
}

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(storedPeriod());
  create.mockReset().mockResolvedValue(storedPeriod());
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  // No entitlement is the ordinary case, and the one every existing test
  // below describes: the calendar month is what an account with no cycle of
  // its own is counted against.
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * **A calendar month, and obviously not a billing cycle.** A paid period is a
 * subscription's own cycle and a trial's is its fourteen days; neither exists
 * yet, so the neutral choice is the same boundary for everybody.
 */
describe("the month observation is measured over", () => {
  it("runs from the first of the UTC month to the first of the next", () => {
    expect(observationWindowFor(SEPTEMBER)).toEqual({
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
    });
  });

  it.each([
    ["the first instant", "2026-09-01T00:00:00.000Z"],
    ["the last instant", "2026-09-30T23:59:59.999Z"],
  ])("puts %s of a month in that month", (_label, instant) => {
    expect(observationWindowFor(new Date(instant)).periodStart).toEqual(
      SEPTEMBER_START,
    );
  });

  it("rolls over to the next month at its first instant", () => {
    expect(observationWindowFor(OCTOBER_START).periodStart).toEqual(
      OCTOBER_START,
    );
  });

  it("crosses a year end", () => {
    expect(observationWindowFor(new Date("2026-12-31T23:00:00.000Z"))).toEqual({
      periodStart: new Date("2026-12-01T00:00:00.000Z"),
      periodEnd: new Date("2027-01-01T00:00:00.000Z"),
    });
  });

  /**
   * **No timezone is consulted.** A month that started at a different instant
   * per account would make two accounts' numbers incomparable, which is the one
   * thing a measurement has to be.
   */
  it("uses UTC rather than anybody's local month", () => {
    // 09:00 in Asia/Tokyo on the 1st is still the 31st in UTC.
    expect(
      observationWindowFor(new Date("2026-10-01T00:00:00+09:00")).periodStart,
    ).toEqual(SEPTEMBER_START);
  });
});

describe("opening a month", () => {
  it("compares against the beta plan's numbers", () => {
    expect(OBSERVATION_PLAN).toBe("beta");
  });

  it("opens the period lazily, on the first thing observed", async () => {
    findUnique.mockResolvedValue(null);

    await recordUsageObservation(USER, "aiProcessing", 1, SEPTEMBER);

    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: USER,
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
      planAtStart: "beta",
    });
  });

  it("opens all three counters with the beta allowances", async () => {
    findUnique.mockResolvedValue(null);

    await recordUsageObservation(USER, "manualRun", 1, SEPTEMBER);

    expect(create.mock.calls[0][0].data.counters.create).toEqual([
      { kind: "aiProcessing", used: 0, limit: 300 },
      { kind: "manualRun", used: 0, limit: 300 },
      { kind: "discovery", used: 0, limit: 150 },
    ]);
  });

  it("reuses the month it already opened", async () => {
    await recordUsageObservation(USER, "discovery", 1, SEPTEMBER);

    expect(create).not.toHaveBeenCalled();
  });

  it("opens a new one in the next month", async () => {
    findUnique.mockResolvedValue(null);

    await recordUsageObservation(USER, "aiProcessing", 1, OCTOBER_START);

    expect(create.mock.calls[0][0].data.periodStart).toEqual(OCTOBER_START);
  });
});

describe("adding to a counter", () => {
  it("adds one by default", async () => {
    await recordUsageObservation(USER, "aiProcessing", 1, SEPTEMBER);

    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { periodId: "usage-period-1", kind: "aiProcessing" },
      data: { used: { increment: 1 } },
    });
  });

  it.each(["aiProcessing", "manualRun", "discovery"] as const)(
    "addresses the counter for %o",
    async (kind) => {
      await recordUsageObservation(USER, kind, 1, SEPTEMBER);

      expect(updateMany.mock.calls[0][0].where.kind).toBe(kind);
    },
  );

  /**
   * **The database adds; nothing reads and writes back.** Two calls arriving
   * together would otherwise both read the same number and one increment would
   * disappear.
   */
  it("lets the database do the arithmetic", async () => {
    await recordUsageObservation(USER, "manualRun", 3, SEPTEMBER);

    expect(updateMany.mock.calls[0][0].data).toEqual({
      used: { increment: 3 },
    });
  });

  it("reports that it was recorded", async () => {
    expect(
      await recordUsageObservation(USER, "discovery", 1, SEPTEMBER),
    ).toEqual({ recorded: true });
  });
});

/**
 * **The whole difference from `consumeUsage`, stated as tests.** That function
 * puts the limit in the write's condition so a spend past it cannot land; this
 * one does not mention the limit at all.
 */
describe("a counter that is already past its limit", () => {
  it("does not put the limit in the condition", async () => {
    await recordUsageObservation(USER, "aiProcessing", 1, SEPTEMBER);

    const where = updateMany.mock.calls[0][0].where;

    expect(where).not.toHaveProperty("limit");
    expect(where).not.toHaveProperty("used");
  });

  it.each([
    ["exactly at the limit", 300],
    ["past the limit", 301],
    ["far past the limit", 9_999],
  ])("keeps counting when a counter is %s", async (_label, used) => {
    findUnique.mockResolvedValue(storedPeriod(used));

    expect(
      await recordUsageObservation(USER, "aiProcessing", 1, SEPTEMBER),
    ).toEqual({ recorded: true });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  /** There is no answer that means "refused", because refusing is not its job. */
  it("never reports a refusal", async () => {
    findUnique.mockResolvedValue(storedPeriod(10_000));

    const result = await recordUsageObservation(
      USER,
      "aiProcessing",
      1,
      SEPTEMBER,
    );

    expect(result.recorded).toBe(true);
  });
});

describe("when observation cannot be written", () => {
  /**
   * The property this phase depends on: a month's counters are not something a
   * run, a draft or an analysis may fail on.
   */
  it.each([
    ["the period cannot be read", () => findUnique.mockRejectedValue(new Error("down"))],
    ["the period cannot be opened", () => {
      findUnique.mockResolvedValue(null);
      create.mockRejectedValue(new Error("down"));
    }],
    ["the counter cannot be updated", () => updateMany.mockRejectedValue(new Error("down"))],
  ])("answers rather than throwing when %s", async (_label, arrange) => {
    arrange();

    expect(
      await recordUsageObservation(USER, "aiProcessing", 1, SEPTEMBER),
    ).toEqual({ recorded: false, reason: "unavailable" });
  });

  it("reports a counter that is not there rather than inventing one", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    expect(
      await recordUsageObservation(USER, "manualRun", 1, SEPTEMBER),
    ).toEqual({ recorded: false, reason: "unavailable" });
  });

  /**
   * **A log line outlives the request it came from.** The kind is enough to
   * tell whether observation is failing everywhere or on one path; the account
   * is not part of that question.
   */
  it("names the kind and not the account", async () => {
    updateMany.mockRejectedValue(new Error("down"));

    await recordUsageObservation(USER, "discovery", 1, SEPTEMBER);

    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0],
    );

    expect(logged).toContain("discovery");
    expect(logged).not.toContain(USER);
  });
});

describe("an amount that is not an amount", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("refuses %s before opening anything", async (_label, units) => {
    await expect(
      recordUsageObservation(USER, "aiProcessing", units, SEPTEMBER),
    ).rejects.toThrow();

    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

/**
 * **Spent on the way in, and never given back** — the same rule the hourly
 * allowances follow. A measurement that could move backwards would stop being
 * a measurement.
 */
describe("what the module deliberately does not offer", () => {
  it("has no way to return units", async () => {
    const exported = await import("@/lib/usage/observe");

    expect(Object.keys(exported).sort()).toEqual([
      "OBSERVATION_PLAN",
      "observationWindowFor",
      "recordUsageObservation",
      "resolveUsageWindow",
    ]);
  });
});

/**
 * Which window a number is written into, and why a trial has its own.
 *
 * **This chooses a place to write, never a right.** The columns are read
 * directly rather than through `computeEntitlement`, so an unreadable
 * entitlement cannot stop the counting and no observation can be mistaken for
 * a permission. See `resolveUsageWindow`.
 */
describe("which period an account is counted against", () => {
  const TRIAL_START = new Date("2026-09-15T09:30:00.000Z");
  const TRIAL_END = new Date("2026-09-29T09:30:00.000Z");

  function runningTrial(overrides: Record<string, unknown> = {}) {
    return {
      state: "trialing",
      trialStartedAt: TRIAL_START,
      trialEndsAt: TRIAL_END,
      ...overrides,
    };
  }

  it("uses the calendar month for an account with no entitlement", async () => {
    subscriptionFindUnique.mockResolvedValue(null);

    expect(await resolveUsageWindow(USER, SEPTEMBER)).toEqual({
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
      plan: OBSERVATION_PLAN,
    });
  });

  /**
   * **The whole point of the function.** A trial begun on the fifteenth would
   * otherwise have its fortnight split at midnight on the first, and its
   * allowance reset halfway through.
   */
  it("uses the trial's own fortnight while a trial is running", async () => {
    subscriptionFindUnique.mockResolvedValue(runningTrial());

    expect(await resolveUsageWindow(USER, SEPTEMBER)).toEqual({
      periodStart: TRIAL_START,
      periodEnd: TRIAL_END,
      plan: "trial",
    });
  });

  it("counts against the trial's numbers, not the observation yardstick", async () => {
    subscriptionFindUnique.mockResolvedValue(runningTrial());

    const { plan } = await resolveUsageWindow(USER, SEPTEMBER);

    expect(plan).toBe("trial");
    expect(plan).not.toBe(OBSERVATION_PLAN);
  });

  it("includes the instant the trial began", async () => {
    subscriptionFindUnique.mockResolvedValue(runningTrial());

    expect((await resolveUsageWindow(USER, TRIAL_START)).plan).toBe("trial");
  });

  /**
   * **A closed period is not written into.** Continuing to add to a fortnight
   * that has ended would keep changing a record of something that is over; what
   * happens to an account after its trial is an enforcement question this phase
   * does not answer.
   */
  it.each([
    ["the instant it ends", TRIAL_END],
    ["long afterwards", new Date("2026-10-20T00:00:00.000Z")],
  ])("falls back to the month once the trial is over: %s", async (_label, at) => {
    subscriptionFindUnique.mockResolvedValue(runningTrial());

    expect((await resolveUsageWindow(USER, at)).plan).toBe(OBSERVATION_PLAN);
  });

  /**
   * **A trial with no dates is not a trial that can be counted.** Guessing a
   * window here would invent a fortnight nobody started.
   */
  it.each([
    ["no start", { trialStartedAt: null }],
    ["no end", { trialEndsAt: null }],
  ])("falls back to the month when a trial row has %s", async (_label, broken) => {
    subscriptionFindUnique.mockResolvedValue(runningTrial(broken));

    expect((await resolveUsageWindow(USER, SEPTEMBER)).plan).toBe(
      OBSERVATION_PLAN,
    );
  });

  /**
   * The carried-over accounts are not trialing and never will be — see
   * `isAdminGrantedBeta`. Their month is exactly the month it was.
   */
  it("leaves a granted beta account on the calendar month", async () => {
    subscriptionFindUnique.mockResolvedValue({
      state: "active",
      trialStartedAt: null,
      trialEndsAt: null,
    });

    expect(await resolveUsageWindow(USER, SEPTEMBER)).toEqual({
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
      plan: OBSERVATION_PLAN,
    });
  });

  it("sends an observed unit into the trial's period", async () => {
    subscriptionFindUnique.mockResolvedValue(runningTrial());
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "trial-period",
      periodStart: TRIAL_START,
      periodEnd: TRIAL_END,
      planAtStart: "trial",
      counters: [{ kind: "manualRun", used: 0, limit: 20 }],
    });

    await recordUsageObservation(USER, "manualRun", 1, SEPTEMBER);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          periodStart: TRIAL_START,
          periodEnd: TRIAL_END,
          planAtStart: "trial",
        }),
      }),
    );
  });
});
