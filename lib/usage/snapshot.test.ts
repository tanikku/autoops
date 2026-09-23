import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an account has used this month, read and not acted on.
 *
 * **Every number here is a description.** `overLimit` is a sentence somebody
 * could read, not an event: nothing stops, nobody is emailed, and no screen is
 * required. Saying that in the tests is the point — the same shape will
 * eventually feed enforcement, and what fixes the difference now is that
 * nothing calls this to decide anything.
 */

const { findUnique, count, subscriptionFindUnique } = vi.hoisted(() => ({
  subscriptionFindUnique: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    usagePeriod: { findUnique },
    routine: { count },
    // A snapshot reads which window an account is in before it reads the
    // window — see `resolveUsageWindow`. Null is an account with no
    // entitlement, which is every account these tests describe unless one
    // says otherwise.
    subscription: { findUnique: subscriptionFindUnique },
  },
}));

const { getUsageSnapshot, usageStatusFor } = await import(
  "@/lib/usage/snapshot"
);

const USER = "google-sub-1";
const NOW = new Date("2026-09-21T08:58:41.000Z");
const SEPTEMBER_START = new Date("2026-09-01T00:00:00.000Z");
const OCTOBER_START = new Date("2026-10-01T00:00:00.000Z");

function storedPeriod(
  counters: { kind: string; used: number; limit: number }[],
  createdAt = SEPTEMBER_START,
) {
  return { createdAt, planAtStart: "beta", counters };
}

const FULL = [
  { kind: "aiProcessing", used: 0, limit: 300 },
  { kind: "manualRun", used: 0, limit: 300 },
  { kind: "discovery", used: 0, limit: 150 },
];

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(storedPeriod(FULL));
  count.mockReset().mockResolvedValue(4);
  subscriptionFindUnique.mockReset().mockResolvedValue(null);
});

describe("where a number falls", () => {
  it.each([
    ["nothing spent", 0, 100, "normal"],
    ["a little under", 79, 100, "normal"],
    ["exactly eighty per cent", 80, 100, "warning80"],
    ["nearly all of it", 99, 100, "warning80"],
    ["exactly the limit", 100, 100, "overLimit"],
    ["past the limit", 101, 100, "overLimit"],
    ["far past the limit", 900, 100, "overLimit"],
  ])("calls %s %o", (_label, used, limit, status) => {
    expect(usageStatusFor(used, limit)).toBe(status);
  });

  /** A limit of nothing cannot be a fraction of anything. */
  it.each([
    ["untouched", 0, "normal"],
    ["spent against", 1, "overLimit"],
  ])("handles a limit of zero, %s", (_label, used, status) => {
    expect(usageStatusFor(used, 0)).toBe(status);
  });
});

describe("a month somebody has used", () => {
  it("reports the month it is reading", async () => {
    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.periodStart).toEqual(SEPTEMBER_START);
    expect(snapshot.periodEnd).toEqual(OCTOBER_START);
  });

  it("names what it compared against", async () => {
    expect((await getUsageSnapshot(USER, NOW)).planBaseline).toBe("beta");
  });

  it("reports all three counters, in a fixed order", async () => {
    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.counters?.map((counter) => counter.kind)).toEqual([
      "aiProcessing",
      "manualRun",
      "discovery",
    ]);
  });

  it("reports what was used against what a plan would allow", async () => {
    findUnique.mockResolvedValue(
      storedPeriod([
        { kind: "aiProcessing", used: 240, limit: 300 },
        { kind: "manualRun", used: 3, limit: 300 },
        { kind: "discovery", used: 150, limit: 150 },
      ]),
    );

    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.counters).toEqual([
      {
        kind: "aiProcessing",
        used: 240,
        limit: 300,
        percent: 80,
        status: "warning80",
      },
      { kind: "manualRun", used: 3, limit: 300, percent: 1, status: "normal" },
      {
        kind: "discovery",
        used: 150,
        limit: 150,
        percent: 100,
        status: "overLimit",
      },
    ]);
  });

  it("reports a counter past its limit without hiding it", async () => {
    findUnique.mockResolvedValue(
      storedPeriod([{ kind: "aiProcessing", used: 450, limit: 300 }]),
    );

    const [aiProcessing] = (await getUsageSnapshot(USER, NOW)).counters ?? [];

    expect(aiProcessing).toMatchObject({
      used: 450,
      limit: 300,
      percent: 150,
      status: "overLimit",
    });
  });
});

/**
 * **Current state rather than consumption**, which is why active workers have
 * no counter: a month does not accumulate them.
 */
describe("how many workers are active", () => {
  it("counts the account's active workers", async () => {
    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(count.mock.calls[0][0]).toEqual({
      where: { userId: USER, status: "active" },
    });
    expect(snapshot.activeWorkers).toBe(4);
  });

  it("reports the beta baseline it is compared against", async () => {
    expect((await getUsageSnapshot(USER, NOW)).activeWorkerLimit).toBe(10);
  });

  /** Ten active workers against a limit of ten still runs. Nothing stops. */
  it("says nothing about whether that is allowed", async () => {
    count.mockResolvedValue(99);

    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.activeWorkers).toBe(99);
    expect(snapshot).not.toHaveProperty("activeWorkersAllowed");
  });
});

/**
 * **Counting began part-way through a month.** A number that looked like a
 * month's total but was not would be worse than no number at all.
 */
describe("whether the month is complete", () => {
  it("is partial when the period was opened after the month began", async () => {
    findUnique.mockResolvedValue(storedPeriod(FULL, NOW));

    expect((await getUsageSnapshot(USER, NOW)).partialPeriod).toBe(true);
  });

  it("is whole when the period was opened at the month's start", async () => {
    findUnique.mockResolvedValue(storedPeriod(FULL, SEPTEMBER_START));

    expect((await getUsageSnapshot(USER, NOW)).partialPeriod).toBe(false);
  });

  it("is partial when nothing has been observed at all", async () => {
    findUnique.mockResolvedValue(null);

    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.partialPeriod).toBe(true);
    // Null rather than zeroes: an account nobody measured is not an account
    // that used nothing.
    expect(snapshot.counters).toBeNull();
  });
});

describe("an account with no month opened", () => {
  it("still says what it would be compared against", async () => {
    findUnique.mockResolvedValue(null);

    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.planBaseline).toBe("beta");
    expect(snapshot.activeWorkerLimit).toBe(10);
    expect(snapshot.activeWorkers).toBe(4);
  });

  /**
   * **Looking must not become using.** Opening a period to answer a question
   * would put a row in the table for an account that did nothing.
   */
  it("writes nothing", async () => {
    findUnique.mockResolvedValue(null);

    await getUsageSnapshot(USER, NOW);

    const prisma = (await import("@/lib/prisma")).prisma as unknown as Record<
      string,
      Record<string, unknown>
    >;

    expect(prisma.usagePeriod).not.toHaveProperty("create");
    expect(prisma).not.toHaveProperty("usageCounter");
  });
});

/**
 * **A period is not an entitlement.** `planAtStart` records what the counters
 * were compared against; nothing here says the account is owed it.
 */
describe("what a snapshot is not", () => {
  it("needs no subscription to answer", async () => {
    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.planBaseline).toBe("beta");
  });

  it("says nothing about entitlement", async () => {
    const snapshot = await getUsageSnapshot(USER, NOW);

    for (const field of ["entitled", "plan", "state", "subscription"]) {
      expect(snapshot).not.toHaveProperty(field);
    }
  });
});

/**
 * What a screen shows for an account on a trial, during it and after it.
 *
 * **A finished trial is still shown.** Its counters are the record of the
 * fortnight, so what it used stays answerable once the fourteen days are over —
 * out of the row that is already there, with nothing created to answer it and
 * no calendar month invented to stand in for it.
 */
describe("a snapshot of an account on a trial", () => {
  const TRIAL_START = new Date("2026-09-01T00:00:00.000Z");
  const TRIAL_END = new Date("2026-09-15T00:00:00.000Z");
  const DURING = new Date("2026-09-10T00:00:00.000Z");
  const AFTER = new Date("2026-09-21T08:58:41.000Z");

  /** The trial's period, as it stands when the fortnight is done. */
  function trialPeriod() {
    return {
      createdAt: TRIAL_START,
      planAtStart: "trial",
      counters: [
        { kind: "aiProcessing", used: 31, limit: 50 },
        { kind: "manualRun", used: 4, limit: 20 },
        { kind: "discovery", used: 9, limit: 14 },
      ],
    };
  }

  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      trialStartedAt: TRIAL_START,
      trialEndsAt: TRIAL_END,
    });
    findUnique.mockResolvedValue(trialPeriod());
  });

  it("reads the trial's own period while the trial runs", async () => {
    const snapshot = await getUsageSnapshot(USER, DURING);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_periodStart: { userId: USER, periodStart: TRIAL_START } },
      }),
    );
    expect(snapshot.periodStart).toEqual(TRIAL_START);
    expect(snapshot.periodEnd).toEqual(TRIAL_END);
    expect(snapshot.planBaseline).toBe("trial");
  });

  /** The point of the correction: the numbers survive the trial ending. */
  it("still reads the completed trial period afterwards", async () => {
    const snapshot = await getUsageSnapshot(USER, AFTER);

    expect(snapshot.periodStart).toEqual(TRIAL_START);
    expect(snapshot.periodEnd).toEqual(TRIAL_END);
    expect(snapshot.counters).toEqual([
      { kind: "aiProcessing", used: 31, limit: 50, percent: 62, status: "normal" },
      { kind: "manualRun", used: 4, limit: 20, percent: 20, status: "normal" },
      { kind: "discovery", used: 9, limit: 14, percent: 64, status: "normal" },
    ]);
  });

  it("shows the trial's own numbers rather than a beta month's", async () => {
    const snapshot = await getUsageSnapshot(USER, AFTER);

    expect(snapshot.planBaseline).toBe("trial");
    expect(snapshot.planBaseline).not.toBe("beta");
    expect(snapshot.activeWorkerLimit).toBe(3);
  });

  /** A period opened at its own first instant covers all of it. */
  it("does not call a completed trial period partial", async () => {
    expect((await getUsageSnapshot(USER, AFTER)).partialPeriod).toBe(false);
  });

  /**
   * **Nothing is read on behalf of an unreadable trial.** The month that a
   * lookup would find could be this account's own pre-trial drafting, counted
   * against beta's numbers, and returning it would present it as what the trial
   * used.
   */
  it("reads no period at all when the trial dates are unreadable", async () => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      trialStartedAt: null,
      trialEndsAt: null,
    });

    const snapshot = await getUsageSnapshot(USER, AFTER);

    expect(findUnique).not.toHaveBeenCalled();
    expect(snapshot.counters).toBeNull();
    expect(snapshot.planBaseline).toBe("trial");
  });

  it("still says how many workers are active when there is no period", async () => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "trial",
      state: "trialing",
      trialStartedAt: null,
      trialEndsAt: null,
    });
    count.mockResolvedValue(2);

    expect((await getUsageSnapshot(USER, AFTER)).activeWorkers).toBe(2);
  });

  /** Reading is reading: a lookup, and never an opening. */
  it("only ever reads the period", async () => {
    await getUsageSnapshot(USER, AFTER);

    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

/**
 * The carried-over accounts, whose screen must not have moved.
 */
describe("a snapshot of a granted beta account", () => {
  beforeEach(() => {
    subscriptionFindUnique.mockResolvedValue({
      plan: "beta",
      state: "active",
      trialStartedAt: null,
      trialEndsAt: null,
    });
  });

  it("reads the calendar month, exactly as before", async () => {
    const snapshot = await getUsageSnapshot(USER, NOW);

    expect(snapshot.periodStart).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(snapshot.periodEnd).toEqual(new Date("2026-10-01T00:00:00.000Z"));
  });
});
