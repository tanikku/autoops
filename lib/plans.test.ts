import { describe, expect, it } from "vitest";
import {
  getPlanDefinition,
  isPlan,
  planIds,
  UnknownPlanError,
  type PlanDefinition,
  type PlanId,
} from "@/lib/plans";

/**
 * The numbers somebody is sold, written down where they cannot drift.
 *
 * **These assertions are the product, not an implementation detail.** Every
 * value below was decided outside this repository, and a change to one of them
 * is a change to what people are paying for — so each is stated literally
 * rather than derived from the catalogue it is checking. A test that read the
 * limits out of `lib/plans.ts` and compared them to themselves would pass
 * through any edit at all.
 *
 * **Nothing here runs a worker.** A plan saying somebody may have eight active
 * workers does not mean anything enforces that: see `lib/entitlements/`, which
 * nothing calls.
 */

const expected: Record<PlanId, Omit<PlanDefinition, "id">> = {
  trial: {
    activeWorkerLimit: 3,
    aiProcessingLimit: 50,
    manualRunLimit: 20,
    discoveryLimit: 14,
    history: { kind: "trial-period" },
    email: "all-workers",
    trialDurationDays: 14,
  },
  lite: {
    activeWorkerLimit: 2,
    aiProcessingLimit: 30,
    manualRunLimit: 20,
    discoveryLimit: 10,
    history: { kind: "days", days: 7 },
    email: "one-worker",
    trialDurationDays: null,
  },
  standard: {
    activeWorkerLimit: 8,
    aiProcessingLimit: 150,
    manualRunLimit: 100,
    discoveryLimit: 60,
    history: { kind: "days", days: 90 },
    email: "all-workers",
    trialDurationDays: null,
  },
  pro: {
    activeWorkerLimit: 15,
    aiProcessingLimit: 300,
    manualRunLimit: 300,
    discoveryLimit: 150,
    history: { kind: "days", days: 365 },
    email: "all-workers",
    trialDurationDays: null,
  },
  beta: {
    activeWorkerLimit: 10,
    aiProcessingLimit: 300,
    manualRunLimit: 300,
    discoveryLimit: 150,
    history: { kind: "days", days: 365 },
    email: "all-workers",
    trialDurationDays: null,
  },
};

describe("which plans exist", () => {
  it("names exactly five", () => {
    expect([...planIds]).toEqual(["trial", "lite", "standard", "pro", "beta"]);
  });

  it.each([...planIds])("recognises %o", (plan) => {
    expect(isPlan(plan)).toBe(true);
  });

  it.each([
    ["an older name", "free"],
    ["a plausible one", "enterprise"],
    ["the wrong case", "Pro"],
    ["nothing", ""],
    ["a number", 1],
    ["absent", undefined],
    ["null", null],
  ])("refuses %s", (_label, value) => {
    expect(isPlan(value)).toBe(false);
  });
});

describe("what each plan allows", () => {
  it.each([...planIds])("%o matches what was decided", (plan) => {
    expect(getPlanDefinition(plan)).toEqual({ id: plan, ...expected[plan] });
  });

  /**
   * **Called out on its own because it moved.** An earlier design put the
   * trial's AI allowance at forty; fifty is the decision that shipped, and the
   * two are close enough that a stale number would read as plausible.
   */
  it("gives a trial fifty AI processing units", () => {
    expect(getPlanDefinition("trial").aiProcessingLimit).toBe(50);
  });

  /** One plan allows one worker to send mail; the rest allow all of them. */
  it("lets exactly one plan nominate a single worker for email", () => {
    const nominating = planIds.filter(
      (plan) => getPlanDefinition(plan).email === "one-worker",
    );

    expect(nominating).toEqual(["lite"]);
  });

  /**
   * **A trial's history is its own length**, which is not a number of days a
   * plan can state — it depends on when the trial began.
   */
  it("is the only plan whose history is not a number of days", () => {
    const byLength = planIds.filter(
      (plan) => getPlanDefinition(plan).history.kind === "trial-period",
    );

    expect(byLength).toEqual(["trial"]);
  });

  it("gives a length only to the trial", () => {
    const timed = planIds.filter(
      (plan) => getPlanDefinition(plan).trialDurationDays !== null,
    );

    expect(timed).toEqual(["trial"]);
  });
});

/**
 * **The catalogue says nothing about money or about who takes it.** A price id
 * here would mean every module asking what somebody may do also learns who
 * bills them.
 */
describe("what the catalogue deliberately does not hold", () => {
  it.each([...planIds])("says nothing about price or provider for %o", (plan) => {
    const keys = Object.keys(getPlanDefinition(plan));

    expect(keys).toEqual([
      "id",
      "activeWorkerLimit",
      "aiProcessingLimit",
      "manualRunLimit",
      "discoveryLimit",
      "history",
      "email",
      "trialDurationDays",
    ]);
  });
});

describe("a plan this version does not know", () => {
  /**
   * **Refused rather than defaulted.** A stored name nobody recognises was
   * written by a version that knew more, and falling back to whichever plan
   * seemed reasonable would hand out an allowance nobody granted.
   */
  it.each(["free", "enterprise", "Pro", ""])("throws for %o", (plan) => {
    expect(() => getPlanDefinition(plan)).toThrow(UnknownPlanError);
  });

  it("names the plan it could not read", () => {
    expect(() => getPlanDefinition("enterprise")).toThrow(/enterprise/);
  });
});

/**
 * **A definition is shared, so it is frozen.**
 *
 * `readonly` stops a mistake being compiled; it does nothing to code that has
 * a reference at runtime. What is fixed here is that an attempt to write
 * through one fails loudly rather than changing what every later reader sees.
 */
describe("the catalogue as a value", () => {
  it("refuses a write through a definition it handed out", () => {
    const definition = getPlanDefinition("lite") as { activeWorkerLimit: number };

    expect(() => {
      definition.activeWorkerLimit = 99;
    }).toThrow(TypeError);

    expect(getPlanDefinition("lite").activeWorkerLimit).toBe(2);
  });

  it("refuses a write through a history entitlement", () => {
    const history = getPlanDefinition("pro").history as { days: number };

    expect(() => {
      history.days = 1;
    }).toThrow(TypeError);

    expect(getPlanDefinition("pro").history).toEqual({ kind: "days", days: 365 });
  });
});
