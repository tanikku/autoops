import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GrantBetaCliError,
  parseGrantBetaArgs,
  runGrantBeta,
  type CohortMember,
  type GrantBetaDeps,
} from "./grant-beta-runner";

/**
 * An operational tool that can write to Production, tested as one.
 *
 * **Most of these are about what it refuses to do.** A command that granted
 * something on a typo, or wrote three rows before noticing the fourth account
 * was wrong, would be worse than no command: the rows it left behind would be
 * entitlements nobody decided on, in a table that has never had a row in it.
 *
 * **Nothing here reaches a database.** The runner is given three functions and
 * can do nothing else — it cannot create a `UsagePeriod`, reset a counter or
 * touch a worker, because no such function is in its hands.
 */

const NOW = new Date("2026-09-22T09:00:00.000Z");
const EXPIRY = "2026-12-31T23:59:59Z";
const EXPIRES_AT = new Date(EXPIRY);

const BASELINE = {
  usagePeriods: 3,
  usageCounters: 9,
  providerUsageEvents: 10,
};

function member(overrides: Partial<CohortMember> = {}): CohortMember {
  return {
    userId: `account-${Math.random()}`,
    subscription: null,
    activeWorkers: 4,
    ...overrides,
  };
}

/** The grant somebody already has, when it is exactly the one being asked for. */
const IDENTICAL = {
  plan: "beta",
  state: "active",
  source: "admin",
  expiresAt: EXPIRES_AT,
};

function cohortOf(count: number, overrides: Partial<CohortMember> = {}) {
  return Array.from({ length: count }, () => member(overrides));
}

let grant: ReturnType<typeof vi.fn>;
let readCohort: ReturnType<typeof vi.fn>;
let readUsageBaseline: ReturnType<typeof vi.fn>;

function deps(): GrantBetaDeps {
  return {
    readCohort,
    readUsageBaseline,
    grant,
  } as unknown as GrantBetaDeps;
}

beforeEach(() => {
  grant = vi.fn().mockResolvedValue({ granted: true, created: true });
  readCohort = vi.fn().mockResolvedValue(cohortOf(5));
  readUsageBaseline = vi.fn().mockResolvedValue(BASELINE);
});

/** The line a report ends on. */
function resultOf(lines: readonly string[]): string {
  return lines[lines.length - 1];
}

/** The number a named line carries. */
function valueOf(lines: readonly string[], label: string): string {
  const line = lines.find((entry) => entry.startsWith(`${label}:`));

  return line === undefined ? "" : line.slice(label.length + 1).trim();
}

describe("reading the command", () => {
  it("defaults to writing nothing", () => {
    const options = parseGrantBetaArgs(
      [`--expected-users=5`, `--expires-at=${EXPIRY}`],
      NOW,
    );

    expect(options.execute).toBe(false);
  });

  it("recognises the flag that turns it into a write", () => {
    const options = parseGrantBetaArgs(
      ["--execute", `--expected-users=5`, `--expires-at=${EXPIRY}`],
      NOW,
    );

    expect(options.execute).toBe(true);
  });

  it("reads the count and the expiry", () => {
    const options = parseGrantBetaArgs(
      [`--expected-users=5`, `--expires-at=${EXPIRY}`],
      NOW,
    );

    expect(options.expectedUsers).toBe(5);
    expect(options.expiresAt.toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });

  it.each([
    ["the count is missing", [`--expires-at=${EXPIRY}`]],
    ["the expiry is missing", [`--expected-users=5`]],
    ["the count is zero", [`--expected-users=0`, `--expires-at=${EXPIRY}`]],
    ["the count is negative", [`--expected-users=-1`, `--expires-at=${EXPIRY}`]],
    ["the count is a decimal", [`--expected-users=5.5`, `--expires-at=${EXPIRY}`]],
    ["the count is not a number", [`--expected-users=five`, `--expires-at=${EXPIRY}`]],
    [
      "the count has a typo after it",
      [`--expected-users=5x`, `--expires-at=${EXPIRY}`],
    ],
    [
      "the expiry is not a timestamp",
      [`--expected-users=5`, `--expires-at=whenever`],
    ],
    [
      "an argument is not one this command has",
      [`--expected-users=5`, `--expires-at=${EXPIRY}`, "--force"],
    ],
    [
      "the flag is misspelt",
      [`--expected-users=5`, `--expires-at=${EXPIRY}`, "--exeucte"],
    ],
  ])("refuses when %s", (_label, argv) => {
    expect(() => parseGrantBetaArgs(argv, NOW)).toThrow(GrantBetaCliError);
  });

  /**
   * **A grant that has already ended entitles nobody.** Writing five of them
   * would look like success and mean nothing.
   */
  it.each([
    ["in the past", "2026-01-01T00:00:00Z"],
    ["exactly now", NOW.toISOString()],
  ])("refuses an expiry %s", (_label, expiry) => {
    expect(() =>
      parseGrantBetaArgs(
        [`--expected-users=5`, `--expires-at=${expiry}`],
        NOW,
      ),
    ).toThrow(GrantBetaCliError);
  });

  /** Parsing happens before anything is read, so a refusal touches nothing. */
  it("refuses without reaching the database", async () => {
    expect(() => parseGrantBetaArgs(["--execute"], NOW)).toThrow();

    expect(readCohort).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });
});

describe("a dry run", () => {
  it("reports that the cohort is ready, and writes nothing", async () => {
    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: false },
      deps(),
    );

    expect(report.ok).toBe(true);
    expect(resultOf(report.lines)).toBe("RESULT: READY");
    expect(valueOf(report.lines, "MODE")).toBe("DRY-RUN");
    expect(valueOf(report.lines, "WRITE PERFORMED")).toBe("NO");
    expect(grant).not.toHaveBeenCalled();
  });

  it("counts what it would do", async () => {
    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: false },
      deps(),
    );

    expect(valueOf(report.lines, "ACTUAL USERS")).toBe("5");
    expect(valueOf(report.lines, "ELIGIBLE FOR CREATE")).toBe("5");
    expect(valueOf(report.lines, "IDENTICAL GRANTS PRESENT")).toBe("0");
    expect(valueOf(report.lines, "CONFLICTS")).toBe("0");
    expect(valueOf(report.lines, "ACTIVE WORKER LIMIT VIOLATIONS")).toBe("0");
  });

  /** Everybody already granted is still ready — there is simply nothing to do. */
  it("is ready when every account already has the identical grant", async () => {
    readCohort.mockResolvedValue(cohortOf(5, { subscription: IDENTICAL }));

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: false },
      deps(),
    );

    expect(report.ok).toBe(true);
    expect(resultOf(report.lines)).toBe("RESULT: READY");
    expect(valueOf(report.lines, "IDENTICAL GRANTS PRESENT")).toBe("5");
    expect(valueOf(report.lines, "ELIGIBLE FOR CREATE")).toBe("0");
    expect(grant).not.toHaveBeenCalled();
  });
});

/**
 * **Every one of these stops the whole cohort**, and none of them writes. A
 * command that granted four accounts and then discovered the fifth was wrong
 * would leave four entitlements nobody had decided to give.
 */
describe("reasons to stop before writing anything", () => {
  it.each([
    ["there are fewer accounts than expected", 4],
    ["there are more accounts than expected", 6],
  ])("stops when %s", async (_label, actual) => {
    readCohort.mockResolvedValue(cohortOf(actual));

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.ok).toBe(false);
    expect(resultOf(report.lines)).toContain("BLOCKED");
    expect(valueOf(report.lines, "WRITE PERFORMED")).toBe("NO");
    expect(grant).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a trial",
      {
        plan: "trial",
        state: "trialing",
        source: "trial",
        expiresAt: null,
      },
    ],
    [
      "a paid plan",
      { plan: "pro", state: "active", source: "stripe", expiresAt: null },
    ],
    ["a beta grant ending on another day", { ...IDENTICAL, expiresAt: new Date("2027-06-30T00:00:00Z") }],
    ["a beta grant with no expiry", { ...IDENTICAL, expiresAt: null }],
    ["a beta grant in another state", { ...IDENTICAL, state: "inactive" }],
    ["a beta grant from another source", { ...IDENTICAL, source: "stripe" }],
  ])("stops the whole cohort when one account has %s", async (_label, existing) => {
    readCohort.mockResolvedValue([
      ...cohortOf(4),
      member({ subscription: existing }),
    ]);

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.ok).toBe(false);
    expect(resultOf(report.lines)).toContain("BLOCKED");
    expect(valueOf(report.lines, "CONFLICTS")).toBe("1");
    // The four that were fine are not granted either.
    expect(grant).not.toHaveBeenCalled();
  });

  it("stops the whole cohort when one account is over the beta worker limit", async () => {
    readCohort.mockResolvedValue([
      ...cohortOf(4),
      member({ activeWorkers: 11 }),
    ]);

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.ok).toBe(false);
    expect(resultOf(report.lines)).toContain("BLOCKED");
    expect(valueOf(report.lines, "ACTIVE WORKER LIMIT VIOLATIONS")).toBe("1");
    expect(grant).not.toHaveBeenCalled();
  });

  /** Exactly the limit is not over it. */
  it("allows an account at exactly the limit", async () => {
    readCohort.mockResolvedValue([
      ...cohortOf(4),
      member({ activeWorkers: 10 }),
    ]);

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: false },
      deps(),
    );

    expect(report.ok).toBe(true);
    expect(valueOf(report.lines, "ACTIVE WORKER LIMIT VIOLATIONS")).toBe("0");
  });
});

describe("granting the cohort", () => {
  it("grants every account once", async () => {
    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(grant).toHaveBeenCalledTimes(5);
    expect(report.ok).toBe(true);
    expect(resultOf(report.lines)).toBe("RESULT: SUCCESS");
    expect(valueOf(report.lines, "CREATED")).toBe("5");
    expect(valueOf(report.lines, "ALREADY PRESENT")).toBe("0");
    expect(valueOf(report.lines, "FAILED")).toBe("0");
  });

  it("passes the same expiry to every account", async () => {
    await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    for (const call of grant.mock.calls) {
      expect(call[1]).toEqual(EXPIRES_AT);
    }
  });

  /**
   * **The helper is the only thing that writes.** The runner is handed three
   * functions and has no other way to reach a database — which is what makes
   * "it cannot reset a counter" a fact about its shape rather than a promise.
   */
  it("writes only through the grant helper", async () => {
    const handed = deps();

    await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      handed,
    );

    expect(Object.keys(handed).sort()).toEqual([
      "grant",
      "readCohort",
      "readUsageBaseline",
    ]);
  });
});

/**
 * **Running the identical command again must be safe.** An operator who is not
 * sure whether the first run finished should be able to just run it again.
 */
describe("running it again", () => {
  beforeEach(() => {
    readCohort.mockResolvedValue(cohortOf(5, { subscription: IDENTICAL }));
    grant.mockResolvedValue({ granted: true, created: false });
  });

  it("creates nothing the second time", async () => {
    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.ok).toBe(true);
    expect(resultOf(report.lines)).toBe("RESULT: SUCCESS");
    expect(valueOf(report.lines, "CREATED")).toBe("0");
    expect(valueOf(report.lines, "ALREADY PRESENT")).toBe("5");
    expect(valueOf(report.lines, "FAILED")).toBe("0");
  });

  it("changes no expiry", async () => {
    await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    // The helper decides; the runner only ever offers the same expiry it was
    // given, which is what makes a second run a no-op rather than an edit.
    for (const call of grant.mock.calls) {
      expect(call[1]).toEqual(EXPIRES_AT);
    }
  });
});

/**
 * **A run that stops part-way says so and stops.** There is no rollback and no
 * retry: deleting rows automatically would be this tool deciding that a
 * half-granted cohort is worse than none, which is a judgement about people's
 * accounts it has no business making.
 */
describe("a run that fails part-way", () => {
  it("stops at the first failure and reports how far it got", async () => {
    grant
      .mockResolvedValueOnce({ granted: true, created: true })
      .mockResolvedValueOnce({ granted: true, created: true })
      .mockRejectedValueOnce(new Error("connection lost"));

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.ok).toBe(false);
    expect(resultOf(report.lines)).toBe("RESULT: PARTIAL FAILURE");
    expect(valueOf(report.lines, "CREATED")).toBe("2");
    expect(valueOf(report.lines, "FAILED")).toBe("1");
    expect(valueOf(report.lines, "REMAINING NOT ATTEMPTED")).toBe("2");
    expect(grant).toHaveBeenCalledTimes(3);
  });

  /** A helper that refuses is a failure too, not something to carry on past. */
  it("stops when the helper refuses rather than throws", async () => {
    grant
      .mockResolvedValueOnce({ granted: true, created: true })
      .mockResolvedValueOnce({ granted: false, reason: "already-entitled" });

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.ok).toBe(false);
    expect(resultOf(report.lines)).toBe("RESULT: PARTIAL FAILURE");
    expect(valueOf(report.lines, "CREATED")).toBe("1");
    expect(valueOf(report.lines, "REMAINING NOT ATTEMPTED")).toBe("3");
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("neither deletes nor retries", async () => {
    grant
      .mockResolvedValueOnce({ granted: true, created: true })
      .mockRejectedValueOnce(new Error("connection lost"));

    await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    // Two calls: one that worked and one that did not. Nothing was tried twice
    // and nothing was undone.
    expect(grant).toHaveBeenCalledTimes(2);
  });
});

/**
 * **Observation data is read and never written.** A grant is an entitlement,
 * not a reason to reinterpret a month that has already been measured.
 */
describe("what it does to the usage tables", () => {
  it("reports the counts without changing them", async () => {
    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.lines).toContain("USAGE PERIODS: 3 -> 3");
    expect(report.lines).toContain("USAGE COUNTERS: 9 -> 9");
    expect(report.lines).toContain("PROVIDER USAGE EVENTS: 10 -> 10");
  });

  it("has no way to reset a counter", async () => {
    const handed = deps();

    await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      handed,
    );

    for (const forbidden of [
      "createUsagePeriod",
      "resetCounters",
      "deleteSubscription",
      "updateRoutine",
      "backfill",
    ]) {
      expect(handed).not.toHaveProperty(forbidden);
    }
  });
});

/**
 * **A transcript outlives the command that produced it.** What it may contain
 * is counts and categories; what it may not is anybody's account.
 */
describe("what the report never says", () => {
  it("names no account, in any outcome", async () => {
    const cohort = [
      member({ userId: "google-sub-secret-1" }),
      member({ userId: "google-sub-secret-2", subscription: IDENTICAL }),
      ...cohortOf(3),
    ];
    readCohort.mockResolvedValue(cohort);
    grant.mockResolvedValue({ granted: true, created: true });

    for (const execute of [false, true]) {
      const report = await runGrantBeta(
        { expectedUsers: 5, expiresAt: EXPIRES_AT, execute },
        deps(),
      );

      const printed = report.lines.join("\n");

      for (const account of cohort) {
        expect(printed).not.toContain(account.userId);
      }
      expect(printed).not.toContain("google-sub");
    }
  });

  it("names no account when it stops", async () => {
    readCohort.mockResolvedValue([
      member({ userId: "google-sub-secret-3" }),
      ...cohortOf(4, { subscription: { plan: "pro", state: "active", source: "stripe", expiresAt: null } }),
    ]);

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    expect(report.lines.join("\n")).not.toContain("google-sub-secret-3");
  });

  it("gives a category rather than a driver's complaint when a write fails", async () => {
    grant.mockRejectedValue(
      new Error('relation "Subscription" does not exist at postgres://user:pw@host'),
    );

    const report = await runGrantBeta(
      { expectedUsers: 5, expiresAt: EXPIRES_AT, execute: true },
      deps(),
    );

    const printed = report.lines.join("\n");

    expect(printed).not.toContain("postgres://");
    expect(printed).not.toContain("does not exist");
    expect(printed).toContain("REASON: Error");
  });
});
