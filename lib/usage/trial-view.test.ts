import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a screen is told about a trial, and what it is not told.
 *
 * **Every number is an answer somewhere else, gathered here.** Which period
 * counts, what it is measured against and whether the fortnight is over are
 * decided by `resolveUsageSnapshotWindow`, `usageStatusFor` and
 * `computeEntitlement`; these fix that this view reports them rather than
 * recomputing them.
 *
 * **Nothing here refuses anything, and no test asserts that it does.** A view
 * reading "over the limit" belongs to an account whose workers run exactly as
 * they ran yesterday. Enforcement is a later phase and this is not it.
 */

const mocks = vi.hoisted(() => ({
  getEffectiveEntitlement: vi.fn(),
  getUsageSnapshot: vi.fn(),
  readPreTrialAiProcessing: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/entitlements/index", () => ({
  getEffectiveEntitlement: mocks.getEffectiveEntitlement,
}));
vi.mock("@/lib/usage/snapshot", () => ({
  getUsageSnapshot: mocks.getUsageSnapshot,
}));
vi.mock("@/lib/entitlements/start-trial", () => ({
  readPreTrialAiProcessing: mocks.readPreTrialAiProcessing,
}));

const { describeStatus, getTrialUsageView } = await import(
  "@/lib/usage/trial-view"
);

const USER = "google-sub-1";
const NOW = new Date("2026-09-22T10:00:00.000Z");
const ENDS = new Date("2026-10-06T10:00:00.000Z");

/** An entitlement in the shape `computeEntitlement` returns. */
function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    state: "trialing",
    entitled: true,
    plan: "trial",
    limits: null,
    trial: { startedAt: NOW, endsAt: ENDS, consumed: true },
    period: null,
    expiresAt: null,
    notificationWorkerId: null,
    ...overrides,
  };
}

/** A snapshot with the three counters at the numbers a test cares about. */
function snapshot(
  used: { ai?: number; manual?: number; discovery?: number } = {},
  activeWorkers = 1,
) {
  return {
    periodStart: NOW,
    periodEnd: ENDS,
    planBaseline: "trial",
    partialPeriod: false,
    counters: [
      { kind: "aiProcessing", used: used.ai ?? 0, limit: 50 },
      { kind: "manualRun", used: used.manual ?? 0, limit: 20 },
      { kind: "discovery", used: used.discovery ?? 0, limit: 14 },
    ],
    activeWorkers,
    activeWorkerLimit: 3,
  };
}

function lineFor(view: Awaited<ReturnType<typeof getTrialUsageView>>, kind: string) {
  if (view.kind !== "active") {
    throw new Error("expected an active trial view");
  }

  return view.lines.find((line) => line.kind === kind);
}

beforeEach(() => {
  mocks.getEffectiveEntitlement.mockReset().mockResolvedValue(entitlement());
  mocks.getUsageSnapshot.mockReset().mockResolvedValue(snapshot());
  mocks.readPreTrialAiProcessing.mockReset().mockResolvedValue(0);
});

describe("where a number falls beside its limit", () => {
  /**
   * **The thresholds are not chosen here.** Four fifths is what
   * `usageStatusFor` already uses; this only splits its last answer in two,
   * because arriving exactly at an allowance and arriving past it read
   * differently even though the arithmetic is the same.
   */
  it.each([
    ["nothing spent", 0, 50, "normal"],
    ["a little under four fifths", 39, 50, "normal"],
    ["exactly four fifths", 40, 50, "approaching"],
    ["one short", 49, 50, "approaching"],
    ["exactly the allowance", 50, 50, "reached"],
    ["one past it", 51, 50, "over"],
    ["far past it", 100, 50, "over"],
  ])("reads %s as %s", (_label, used, limit, expected) => {
    expect(describeStatus(used, limit)).toBe(expected);
  });

  it("uses the same rule for workers, which are a count rather than a spend", () => {
    expect(describeStatus(1, 3)).toBe("normal");
    expect(describeStatus(3, 3)).toBe("reached");
    expect(describeStatus(5, 3)).toBe("over");
  });
});

describe("an account that has not started a trial", () => {
  beforeEach(() => {
    mocks.getEffectiveEntitlement.mockResolvedValue(
      entitlement({ state: "none", entitled: false, plan: null, trial: null }),
    );
  });

  it("is told the trial has not begun, with nothing spent", async () => {
    mocks.readPreTrialAiProcessing.mockResolvedValue(0);

    expect(await getTrialUsageView(USER, NOW)).toEqual({
      kind: "pre-trial",
      aiUsed: 0,
      aiLimit: 50,
    });
  });

  /**
   * **The number comes from the same read the trial start uses.** The sentence
   * on the form and the counter the trial opens have one definition between
   * them — see `readPreTrialAiProcessing`.
   */
  it("reports what will be carried in, through the carry-in read itself", async () => {
    mocks.readPreTrialAiProcessing.mockResolvedValue(3);

    expect(await getTrialUsageView(USER, NOW)).toEqual({
      kind: "pre-trial",
      aiUsed: 3,
      aiLimit: 50,
    });
    expect(mocks.readPreTrialAiProcessing).toHaveBeenCalledTimes(1);
  });

  /** Looking at a form must not open a period or count anything. */
  it("reads no usage period to answer", async () => {
    await getTrialUsageView(USER, NOW);

    expect(mocks.getUsageSnapshot).not.toHaveBeenCalled();
  });
});

describe("an account in its trial", () => {
  it("says how many whole days are left", async () => {
    expect((await getTrialUsageView(USER, NOW)) as { daysRemaining: number }).toMatchObject(
      { kind: "active", daysRemaining: 14 },
    );
  });

  /**
   * **Rounded up, never down.** A trial with six hours to run has a day left;
   * rounding down would read as over for the whole of the final day.
   */
  it("calls the last few hours a day", async () => {
    const nearlyOver = new Date(ENDS.getTime() - 6 * 60 * 60 * 1000);

    expect(await getTrialUsageView(USER, nearlyOver)).toMatchObject({
      daysRemaining: 1,
    });
  });

  it("reports the three allowances in the order the kinds are declared", async () => {
    const view = await getTrialUsageView(USER, NOW);

    expect(view.kind).toBe("active");
    expect(
      view.kind === "active" ? view.lines.map((line) => line.kind) : [],
    ).toEqual(["aiProcessing", "manualRun", "discovery"]);
  });

  it("takes its numbers from the snapshot rather than counting again", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(
      snapshot({ ai: 12, manual: 4, discovery: 9 }, 2),
    );

    const view = await getTrialUsageView(USER, NOW);

    expect(mocks.getUsageSnapshot).toHaveBeenCalledWith(USER, NOW);
    expect(lineFor(view, "aiProcessing")).toEqual({
      kind: "aiProcessing",
      used: 12,
      limit: 50,
      status: "normal",
    });
    expect(lineFor(view, "manualRun")?.used).toBe(4);
    expect(lineFor(view, "discovery")?.used).toBe(9);
  });

  it.each([
    ["well under", 12, "normal"],
    ["at four fifths", 40, "approaching"],
    ["one short", 49, "approaching"],
    ["exactly fifty", 50, "reached"],
    ["past it", 63, "over"],
  ])("marks AI processing %s as %s", async (_label, used, status) => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({ ai: used }));

    expect(lineFor(await getTrialUsageView(USER, NOW), "aiProcessing")).toMatchObject(
      { used, limit: 50, status },
    );
  });

  it("marks a spent manual allowance as reached", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({ manual: 20 }));

    expect(lineFor(await getTrialUsageView(USER, NOW), "manualRun")).toMatchObject({
      used: 20,
      limit: 20,
      status: "reached",
    });
  });

  it("marks a spent discovery allowance as reached", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({ discovery: 14 }));

    expect(lineFor(await getTrialUsageView(USER, NOW), "discovery")).toMatchObject({
      used: 14,
      limit: 14,
      status: "reached",
    });
  });

  /**
   * **Active workers are current state, not consumption**, which is why they
   * are reported beside the counters rather than as one of them.
   */
  it.each([
    ["room to spare", 1, "normal"],
    ["exactly full", 3, "reached"],
    ["more than the trial allows", 5, "over"],
  ])("reports workers %s as %s", async (_label, active, status) => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({}, active));

    expect(await getTrialUsageView(USER, NOW)).toMatchObject({
      activeWorkers: active,
      activeWorkerLimit: 3,
      activeWorkerStatus: status,
    });
  });

  /** Over the worker limit is a description. Nothing is paused and nothing stops. */
  it("says nothing about pausing when there are more workers than the limit", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({}, 5));

    const view = await getTrialUsageView(USER, NOW);

    expect(view).toMatchObject({ kind: "active", activeWorkers: 5 });
  });

  /** The carry-in is the only way to begin past the AI limit. */
  it("flags a trial that began over its AI limit", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({ ai: 63 }));

    expect(await getTrialUsageView(USER, NOW)).toMatchObject({
      carriedInOverLimit: true,
    });
  });

  it("does not flag a carry-in when the AI line is within its limit", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(snapshot({ ai: 50 }));

    expect(await getTrialUsageView(USER, NOW)).toMatchObject({
      carriedInOverLimit: false,
    });
  });

  /** A period that cannot be read is zeroes at the trial's own numbers. */
  it("falls back to the trial's limits when no counters came back", async () => {
    mocks.getUsageSnapshot.mockResolvedValue({
      ...snapshot(),
      counters: null,
    });

    const view = await getTrialUsageView(USER, NOW);

    expect(lineFor(view, "aiProcessing")).toEqual({
      kind: "aiProcessing",
      used: 0,
      limit: 50,
      status: "normal",
    });
    expect(lineFor(view, "manualRun")?.limit).toBe(20);
    expect(lineFor(view, "discovery")?.limit).toBe(14);
  });
});

describe("an account whose trial has ended", () => {
  it("is described as ended, with nothing else to read", async () => {
    mocks.getEffectiveEntitlement.mockResolvedValue(
      entitlement({ state: "trial_expired", entitled: false }),
    );

    expect(await getTrialUsageView(USER, NOW)).toEqual({ kind: "expired" });
  });

  /** Nothing is read to say so: the state is the clock's opinion about a row. */
  it("reads no counters to say so", async () => {
    mocks.getEffectiveEntitlement.mockResolvedValue(
      entitlement({ state: "trial_expired", entitled: false }),
    );

    await getTrialUsageView(USER, NOW);

    expect(mocks.getUsageSnapshot).not.toHaveBeenCalled();
  });
});

/**
 * **Every entitlement that is not a trial is silence.** The carried-over
 * cohort was never offered a trial and must not be shown one; a plan somebody
 * bought is not a trial either.
 */
describe("accounts that are not on a trial", () => {
  it.each([
    ["a granted beta allowance", "active"],
    ["a grant that has run out", "expired"],
    ["a plan in grace", "grace"],
    ["a cancellation still running", "canceled_active"],
    ["an entitlement that has lapsed", "inactive"],
  ])("tells %s nothing about a trial", async (_label, state) => {
    mocks.getEffectiveEntitlement.mockResolvedValue(
      entitlement({ state, trial: null }),
    );

    expect(await getTrialUsageView(USER, NOW)).toEqual({ kind: "hidden" });
  });

  it("reads no counters and no carry-in for them", async () => {
    mocks.getEffectiveEntitlement.mockResolvedValue(
      entitlement({ state: "active", trial: null }),
    );

    await getTrialUsageView(USER, NOW);

    expect(mocks.getUsageSnapshot).not.toHaveBeenCalled();
    expect(mocks.readPreTrialAiProcessing).not.toHaveBeenCalled();
  });

  /** A trialing row that cannot say when it ends has no countdown to show. */
  it("hides a trial with no end date rather than guessing one", async () => {
    mocks.getEffectiveEntitlement.mockResolvedValue(
      entitlement({ trial: { startedAt: NOW, endsAt: null, consumed: true } }),
    );

    expect(await getTrialUsageView(USER, NOW)).toEqual({ kind: "hidden" });
  });
});

/**
 * **What this module is not.** It reads, and the things it reads from are the
 * ones that already exist. A second source of usage arithmetic, or any route
 * to refusing something, would both show up here.
 */
describe("what the view deliberately cannot do", () => {
  it("offers nothing but the read and the status rule", async () => {
    const exported = await import("@/lib/usage/trial-view");

    expect(Object.keys(exported).sort()).toEqual([
      "describeStatus",
      "getTrialUsageView",
    ]);
  });
});
