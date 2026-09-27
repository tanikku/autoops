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
  resolveUsageSnapshotWindow,
  resolveUsageWriteWindow,
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
      "resolveUsageSnapshotWindow",
      "resolveUsageWriteWindow",
    ]);
  });
});


/**
 * Where a product unit is written, and when it is written nowhere.
 *
 * **A trial account is not a beta account, and that is the whole of this
 * block.** Once a trial's fourteen days are over there are two tempting wrong
 * answers — add to the fortnight that finished, or open a calendar month
 * against beta's numbers — and both would leave a row that outlives any
 * explanation of why it is there. Nothing is written instead.
 *
 * **Skipping stops bookkeeping, never work.** The call that prompted it
 * happened and is written down in `ProviderUsageEvent` exactly as before; what
 * these fix is that no product counter moves and no period is opened.
 */
describe("where a product unit is written", () => {
  const TRIAL_START = new Date("2026-09-15T09:30:00.000Z");
  const TRIAL_END = new Date("2026-09-29T09:30:00.000Z");

  function trialRow(overrides: Record<string, unknown> = {}) {
    return {
      plan: "trial",
      state: "trialing",
      trialStartedAt: TRIAL_START,
      trialEndsAt: TRIAL_END,
      ...overrides,
    };
  }

  /** An account with no entitlement is counted exactly as it was in M1B. */
  it("uses the calendar month for an account with no entitlement", async () => {
    subscriptionFindUnique.mockResolvedValue(null);

    expect(await resolveUsageWriteWindow(USER, SEPTEMBER)).toEqual({
      kind: "period",
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
      plan: OBSERVATION_PLAN,
    });
  });

  /** The carried-over cohort's month is exactly the month it was. */
  it("leaves a granted beta account on the monthly beta window", async () => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "beta",
      state: "active",
      trialStartedAt: null,
      trialEndsAt: null,
    });

    expect(await resolveUsageWriteWindow(USER, SEPTEMBER)).toEqual({
      kind: "period",
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
      plan: OBSERVATION_PLAN,
    });
  });

  /** Inside the fortnight, the trial's own period and its own numbers. */
  it("uses the trial's own fortnight while the trial is running", async () => {
    subscriptionFindUnique.mockResolvedValue(trialRow());

    expect(await resolveUsageWriteWindow(USER, SEPTEMBER)).toEqual({
      kind: "period",
      periodStart: TRIAL_START,
      periodEnd: TRIAL_END,
      plan: "trial",
    });
  });

  it("includes the instant the trial began", async () => {
    subscriptionFindUnique.mockResolvedValue(trialRow());

    expect(await resolveUsageWriteWindow(USER, TRIAL_START)).toMatchObject({
      kind: "period",
      plan: "trial",
    });
  });

  /** Expiry begins at exactly `trialEndsAt`, not a millisecond later. */
  it.each([
    ["at the exact instant it ends", TRIAL_END],
    ["a moment after it ends", new Date(TRIAL_END.getTime() + 1)],
    ["long after it ends", new Date("2026-11-20T00:00:00.000Z")],
  ])("writes nowhere once the trial is over: %s", async (_label, at) => {
    subscriptionFindUnique.mockResolvedValue(trialRow());

    expect(await resolveUsageWriteWindow(USER, at)).toEqual({
      kind: "skip",
      reason: "outside-trial",
    });
  });

  /**
   * A row that says trial and does not say when is not a beta account either.
   * Skipping keeps the misfiling from being written down.
   */
  it.each([
    ["no start", { trialStartedAt: null }],
    ["no end", { trialEndsAt: null }],
    ["neither", { trialStartedAt: null, trialEndsAt: null }],
  ])("writes nowhere when a trial row has %s", async (_label, broken) => {
    subscriptionFindUnique.mockResolvedValue(trialRow(broken));

    expect(await resolveUsageWriteWindow(USER, SEPTEMBER)).toEqual({
      kind: "skip",
      reason: "unreadable-trial",
    });
  });

  /** A trial still identified by one column after the other has moved on. */
  it.each([
    ["the plan alone", { plan: "trial", state: "inactive" }],
    ["the state alone", { plan: "beta", state: "trialing" }],
  ])("recognises a trial by %s", async (_label, columns) => {
    subscriptionFindUnique.mockResolvedValue(trialRow(columns));

    expect(await resolveUsageWriteWindow(USER, TRIAL_END)).toEqual({
      kind: "skip",
      reason: "outside-trial",
    });
  });
});

/**
 * What an observation does when there is nowhere to put it.
 *
 * **Nothing, plainly enough to be answered and quietly enough to change
 * nothing.** No period is opened, no counter moves, no exception leaves the
 * function, and the caller is told it was not counted.
 */
describe("observing usage after a trial has ended", () => {
  const TRIAL_START = new Date("2026-09-01T00:00:00.000Z");
  const TRIAL_END = new Date("2026-09-15T00:00:00.000Z");
  const AFTER = new Date("2026-09-21T08:58:41.000Z");

  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      trialStartedAt: TRIAL_START,
      trialEndsAt: TRIAL_END,
    });
  });

  it("says it was not counted, rather than failing", async () => {
    expect(await recordUsageObservation(USER, "aiProcessing", 1, AFTER)).toEqual({
      recorded: false,
      reason: "not-counted",
    });
  });

  /** No calendar month is opened against beta's numbers. */
  it("creates no beta monthly period", async () => {
    await recordUsageObservation(USER, "aiProcessing", 1, AFTER);

    expect(create).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  /** The finished fortnight's counters are left exactly as they ended. */
  it("adds nothing to the counters of the trial that ended", async () => {
    await recordUsageObservation(USER, "manualRun", 1, AFTER);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each(["aiProcessing", "manualRun", "discovery"] as const)(
    "counts nothing for %s",
    async (kind) => {
      await recordUsageObservation(USER, kind, 1, AFTER);

      expect(updateMany).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  /** Malformed dates skip without throwing on a best-effort hot path. */
  it("does not throw when the trial dates are unreadable", async () => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      trialStartedAt: null,
      trialEndsAt: null,
    });

    await expect(
      recordUsageObservation(USER, "aiProcessing", 1, AFTER),
    ).resolves.toEqual({ recorded: false, reason: "not-counted" });
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  /**
   * **A skip is not a failure, and is not logged as one.** An ended trial is an
   * ordinary state of an ordinary account; a log line per call would say
   * something is wrong when nothing is.
   */
  it("logs no error and no warning", async () => {
    await recordUsageObservation(USER, "aiProcessing", 1, AFTER);

    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  /** Still counted while the fortnight is running. */
  it("counts normally inside the trial", async () => {
    const inside = new Date("2026-09-10T00:00:00.000Z");
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "trial-period",
      periodStart: TRIAL_START,
      periodEnd: TRIAL_END,
      planAtStart: "trial",
      counters: [{ kind: "manualRun", used: 0, limit: 20 }],
    });

    expect(await recordUsageObservation(USER, "manualRun", 1, inside)).toEqual({
      recorded: true,
    });
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

/**
 * Which period a screen reads, which is not always where counting goes.
 *
 * **A finished trial is read and not written.** Somebody asking what a trial
 * used is asking about exactly the period that closed, so the three numbers
 * stay answerable out of the row that is already there — and nothing is created
 * to answer it.
 */
describe("which period a snapshot reads", () => {
  const TRIAL_START = new Date("2026-09-01T00:00:00.000Z");
  const TRIAL_END = new Date("2026-09-15T00:00:00.000Z");

  function trialRow(overrides: Record<string, unknown> = {}) {
    return {
      plan: "trial",
      state: "trialing",
      trialStartedAt: TRIAL_START,
      trialEndsAt: TRIAL_END,
      ...overrides,
    };
  }

  it("reads the trial's period while the trial runs", async () => {
    subscriptionFindUnique.mockResolvedValue(trialRow());

    expect(
      await resolveUsageSnapshotWindow(
        USER,
        new Date("2026-09-10T00:00:00.000Z"),
      ),
    ).toEqual({
      kind: "period",
      periodStart: TRIAL_START,
      periodEnd: TRIAL_END,
      plan: "trial",
    });
  });

  /** The completed fortnight, never a synthetic beta month. */
  it.each([
    ["at the instant it ends", TRIAL_END],
    ["well afterwards", new Date("2026-10-30T00:00:00.000Z")],
  ])("still reads the completed trial period %s", async (_label, at) => {
    subscriptionFindUnique.mockResolvedValue(trialRow());

    expect(await resolveUsageSnapshotWindow(USER, at)).toEqual({
      kind: "period",
      periodStart: TRIAL_START,
      periodEnd: TRIAL_END,
      plan: "trial",
    });
  });

  /** An unreadable trial has nothing to show, and reads no month. */
  it("has nothing to read when the trial dates are unreadable", async () => {
    subscriptionFindUnique.mockResolvedValue(
      trialRow({ trialStartedAt: null, trialEndsAt: null }),
    );

    expect(await resolveUsageSnapshotWindow(USER, SEPTEMBER)).toEqual({
      kind: "none",
      plan: "trial",
    });
  });

  it("reads the calendar month for an account with no entitlement", async () => {
    subscriptionFindUnique.mockResolvedValue(null);

    expect(await resolveUsageSnapshotWindow(USER, SEPTEMBER)).toEqual({
      kind: "period",
      periodStart: SEPTEMBER_START,
      periodEnd: OCTOBER_START,
      plan: OBSERVATION_PLAN,
    });
  });

  /** Unchanged for the granted beta cohort. */
  it("reads the monthly beta window for a granted beta account", async () => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "beta",
      state: "active",
      trialStartedAt: null,
      trialEndsAt: null,
    });

    expect(await resolveUsageSnapshotWindow(USER, SEPTEMBER)).toMatchObject({
      kind: "period",
      plan: OBSERVATION_PLAN,
    });
  });

  /**
   * **The two questions genuinely differ, and this is the instant they do.** At
   * an ended trial, writing goes nowhere and reading goes to the fortnight —
   * which is why they are two functions rather than one with a flag.
   */
  it("differs from the write window once the trial has ended", async () => {
    subscriptionFindUnique.mockResolvedValue(trialRow());

    expect(await resolveUsageWriteWindow(USER, TRIAL_END)).toEqual({
      kind: "skip",
      reason: "outside-trial",
    });
    expect(await resolveUsageSnapshotWindow(USER, TRIAL_END)).toMatchObject({
      kind: "period",
      periodStart: TRIAL_START,
    });
  });
});

/**
 * A bought plan, counted over the period it is being paid for.
 *
 * **The defect these exist for.** A subscription's period starts when it was
 * bought — `2026-09-27T06:34:36Z`, not the first of the month — and
 * `activatePaidSubscription` opens the `UsagePeriod` at exactly that instant.
 * Both resolvers read the calendar month instead, found no row there, and fell
 * through to the observation yardstick: an account paying for Lite was measured
 * against beta's ten workers and three hundred AI runs, while the quota refused
 * it a third worker. The counting went into a month-shaped row the purchase had
 * never opened, so the paid row stayed empty for good.
 *
 * **Every test here is about which window comes back**, not about what is in it.
 * What a window's counters say is `snapshot.test.ts`.
 */
describe("a paid subscription's own billing period", () => {
  const PERIOD_START = new Date("2026-09-27T06:34:36.000Z");
  const PERIOD_END = new Date("2026-10-27T06:34:36.000Z");
  /** Inside the period, and in a different calendar month from its start. */
  const DURING = new Date("2026-10-05T09:00:00.000Z");

  /** The Production row, as reconciliation left it. */
  function paidRow(overrides: Record<string, unknown> = {}) {
    return {
      plan: "lite",
      state: "active",
      source: "stripe",
      trialStartedAt: null,
      trialEndsAt: null,
      trialConsumedAt: null,
      trialForfeitedAt: new Date("2026-09-25T15:51:15.150Z"),
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      notificationWorkerId: null,
      expiresAt: null,
      ...overrides,
    };
  }

  const both = [
    ["write", resolveUsageWriteWindow] as const,
    ["snapshot", resolveUsageSnapshotWindow] as const,
  ];

  it.each(both)("the %s window is the billing period", async (_label, resolve) => {
    subscriptionFindUnique.mockResolvedValue(paidRow());

    expect(await resolve(USER, DURING)).toEqual({
      kind: "period",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      plan: "lite",
    });
  });

  it.each([
    ["lite", 0],
    ["standard", 0],
    ["pro", 0],
  ])("%s is measured over its own period", async (plan) => {
    subscriptionFindUnique.mockResolvedValue(paidRow({ plan }));

    for (const [, resolve] of both) {
      expect(await resolve(USER, DURING)).toEqual({
        kind: "period",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        plan,
      });
    }
  });

  /** The whole point: the window is not the month, and is not beta's. */
  it.each(both)(
    "the %s window is neither the calendar month nor the yardstick",
    async (_label, resolve) => {
      subscriptionFindUnique.mockResolvedValue(paidRow());

      const window = await resolve(USER, DURING);
      const month = observationWindowFor(DURING);

      expect(window).toMatchObject({ kind: "period" });
      expect((window as { plan: string }).plan).not.toBe(OBSERVATION_PLAN);
      expect((window as { periodStart: Date }).periodStart).not.toEqual(
        month.periodStart,
      );
    },
  );

  /** Both sides have to agree, or the counting and the reading part company. */
  it("writes and reads the same window", async () => {
    subscriptionFindUnique.mockResolvedValue(paidRow());

    expect(await resolveUsageWriteWindow(USER, DURING)).toEqual(
      await resolveUsageSnapshotWindow(USER, DURING),
    );
  });

  /** A period that begins on the first of a month is still its own period. */
  it.each(both)(
    "the %s window uses a month-aligned period as a period",
    async (_label, resolve) => {
      const start = new Date("2026-10-01T00:00:00.000Z");
      const end = new Date("2026-11-01T00:00:00.000Z");
      subscriptionFindUnique.mockResolvedValue(
        paidRow({ currentPeriodStart: start, currentPeriodEnd: end }),
      );

      expect(await resolve(USER, DURING)).toEqual({
        kind: "period",
        periodStart: start,
        periodEnd: end,
        plan: "lite",
      });
    },
  );

  /** A renewal moved the window; the resolvers follow the row. */
  it.each(both)("the %s window follows a renewal", async (_label, resolve) => {
    const start = new Date("2026-10-27T06:34:36.000Z");
    const end = new Date("2026-11-27T06:34:36.000Z");
    subscriptionFindUnique.mockResolvedValue(
      paidRow({ currentPeriodStart: start, currentPeriodEnd: end }),
    );

    expect(await resolve(USER, new Date("2026-11-01T00:00:00.000Z"))).toEqual({
      kind: "period",
      periodStart: start,
      periodEnd: end,
      plan: "lite",
    });
  });

  /**
   * **Behind on payment and cancelling inside the period both still entitle.**
   * Somebody in either state is using the plan they paid for, and the window they
   * are using it in is the one they paid for.
   */
  it.each(["grace", "canceled_active"])(
    "a paid plan in %s keeps its period",
    async (state) => {
      subscriptionFindUnique.mockResolvedValue(paidRow({ state }));

      for (const [, resolve] of both) {
        expect(await resolve(USER, DURING)).toMatchObject({
          periodStart: PERIOD_START,
          plan: "lite",
        });
      }
    },
  );

  /**
   * **A subscription that has ended does not lend its allowance to today.** Its
   * period is history; what happens now falls back to the yardstick, which is
   * what an account with nothing has always been measured against.
   */
  it.each(both)(
    "the %s window falls back once the entitlement has lapsed",
    async (_label, resolve) => {
      subscriptionFindUnique.mockResolvedValue(paidRow({ state: "inactive" }));

      expect(await resolve(USER, DURING)).toEqual({
        kind: "period",
        ...observationWindowFor(DURING),
        plan: OBSERVATION_PLAN,
      });
    },
  );

  /** A paid row reconciliation has not finished with has no period to use. */
  it.each(both)(
    "the %s window falls back when no period is stored",
    async (_label, resolve) => {
      subscriptionFindUnique.mockResolvedValue(
        paidRow({ currentPeriodStart: null, currentPeriodEnd: null }),
      );

      expect(await resolve(USER, DURING)).toEqual({
        kind: "period",
        ...observationWindowFor(DURING),
        plan: OBSERVATION_PLAN,
      });
    },
  );

  it.each(both)(
    "the %s window falls back when only one end is stored",
    async (_label, resolve) => {
      subscriptionFindUnique.mockResolvedValue(
        paidRow({ currentPeriodEnd: null }),
      );

      expect(await resolve(USER, DURING)).toMatchObject({
        plan: OBSERVATION_PLAN,
      });
    },
  );

  /**
   * **A state this version cannot read falls through rather than throwing.**
   * `computeEntitlement` refuses it, and it is right to — but a screen asking
   * what somebody used is not where that refusal belongs, and a page that threw
   * would show nothing at all.
   */
  it.each(both)(
    "the %s window falls back for a state it cannot read",
    async (_label, resolve) => {
      subscriptionFindUnique.mockResolvedValue(
        paidRow({ state: "renegotiating" }),
      );

      await expect(resolve(USER, DURING)).resolves.toMatchObject({
        plan: OBSERVATION_PLAN,
      });
    },
  );

  it.each(both)(
    "the %s window falls back for a plan it cannot read",
    async (_label, resolve) => {
      subscriptionFindUnique.mockResolvedValue(paidRow({ plan: "enterprise" }));

      await expect(resolve(USER, DURING)).resolves.toMatchObject({
        plan: OBSERVATION_PLAN,
      });
    },
  );
});

/**
 * The accounts that were carried over, and the trial.
 *
 * **Nothing about either moved.** The paid branch sits between them and is
 * reached only by a bought plan in force, so a granted allowance is measured
 * exactly as it was — against the month, against the yardstick — and a trial
 * keeps its fortnight whatever else its row says.
 */
describe("what the paid branch must not touch", () => {
  function grantRow(overrides: Record<string, unknown> = {}) {
    return {
      plan: "beta",
      state: "active",
      source: "admin",
      trialStartedAt: null,
      trialEndsAt: null,
      trialConsumedAt: null,
      trialForfeitedAt: new Date("2026-09-22T10:05:58.508Z"),
      // A grant has no billing cycle, which is why the yardstick exists.
      currentPeriodStart: null,
      currentPeriodEnd: null,
      notificationWorkerId: null,
      expiresAt: new Date("2026-12-31T23:59:59.000Z"),
      ...overrides,
    };
  }

  it.each([
    ["write", resolveUsageWriteWindow] as const,
    ["snapshot", resolveUsageSnapshotWindow] as const,
  ])("the granted beta cohort keeps the month in the %s window", async (
    _label,
    resolve,
  ) => {
    subscriptionFindUnique.mockResolvedValue(grantRow());

    expect(await resolve(USER, SEPTEMBER)).toEqual({
      kind: "period",
      ...observationWindowFor(SEPTEMBER),
      plan: OBSERVATION_PLAN,
    });
  });

  /** Even if somebody put a period on a grant, it is not a bought plan. */
  it("does not give a grant a billing period it should not have", async () => {
    subscriptionFindUnique.mockResolvedValue(
      grantRow({
        currentPeriodStart: new Date("2026-09-27T06:34:36.000Z"),
        currentPeriodEnd: new Date("2026-10-27T06:34:36.000Z"),
      }),
    );

    expect(await resolveUsageSnapshotWindow(USER, SEPTEMBER)).toMatchObject({
      plan: OBSERVATION_PLAN,
    });
  });

  /**
   * **A row that still says `trialing` is a trial, whatever its plan says.** The
   * trial is asked first for exactly this case, so nothing the paid branch does
   * can take a fortnight away from somebody who was given one.
   */
  it("keeps a trialing row on its trial even with a paid plan and a period", async () => {
    const trialStart = new Date("2026-09-01T00:00:00.000Z");
    const trialEnd = new Date("2026-09-15T00:00:00.000Z");

    subscriptionFindUnique.mockResolvedValue({
      plan: "lite",
      state: "trialing",
      source: "stripe",
      trialStartedAt: trialStart,
      trialEndsAt: trialEnd,
      trialConsumedAt: null,
      trialForfeitedAt: null,
      currentPeriodStart: new Date("2026-09-27T06:34:36.000Z"),
      currentPeriodEnd: new Date("2026-10-27T06:34:36.000Z"),
      notificationWorkerId: null,
      expiresAt: null,
    });

    expect(
      await resolveUsageSnapshotWindow(USER, new Date("2026-09-10T00:00:00.000Z")),
    ).toEqual({
      kind: "period",
      periodStart: trialStart,
      periodEnd: trialEnd,
      plan: "trial",
    });
  });

  it("still skips a write outside a trial rather than using a paid period", async () => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      source: "trial",
      trialStartedAt: new Date("2026-09-01T00:00:00.000Z"),
      trialEndsAt: new Date("2026-09-15T00:00:00.000Z"),
      trialConsumedAt: null,
      trialForfeitedAt: null,
      currentPeriodStart: new Date("2026-09-27T06:34:36.000Z"),
      currentPeriodEnd: new Date("2026-10-27T06:34:36.000Z"),
      notificationWorkerId: null,
      expiresAt: null,
    });

    expect(
      await resolveUsageWriteWindow(USER, new Date("2026-10-05T00:00:00.000Z")),
    ).toEqual({ kind: "skip", reason: "outside-trial" });
  });

  /** An account with no row at all is unchanged. */
  it.each([
    ["write", resolveUsageWriteWindow] as const,
    ["snapshot", resolveUsageSnapshotWindow] as const,
  ])("an account with no row keeps the month in the %s window", async (
    _label,
    resolve,
  ) => {
    subscriptionFindUnique.mockResolvedValue(null);

    expect(await resolve(USER, SEPTEMBER)).toEqual({
      kind: "period",
      ...observationWindowFor(SEPTEMBER),
      plan: OBSERVATION_PLAN,
    });
  });
});
