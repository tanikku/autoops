import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the dashboard reads, and how much of it.
 *
 * **The page used to make one read of run history and use it for three
 * things**: the activity list, the overview card, and every worker's health.
 * That worked while the read was unbounded, and only while it was — the list
 * wants the newest few rows, and the other two want figures counted over every
 * run there has ever been. One query cannot be both.
 *
 * These fix the split: two reads, each bounded in its own way, and neither
 * multiplying by the number of workers on screen.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  listRoutines: vi.fn(),
  listRecentRuns: vi.fn(),
  summarizeRunsByWorker: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/routines", () => ({ listRoutines: mocks.listRoutines }));
vi.mock("@/lib/runs", () => ({
  listRecentRuns: mocks.listRecentRuns,
  summarizeRunsByWorker: mocks.summarizeRunsByWorker,
}));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));

const DashboardPage = (await import("@/app/dashboard/page")).default;

const NOW = new Date("2026-08-10T12:00:00.000Z");

function worker(id: string) {
  return {
    id,
    userId: "user-1",
    name: `Worker ${id}`,
    description: "",
    prompt: "hello",
    kind: "prompt" as const,
    status: "active" as const,
    frequency: "daily" as const,
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    nextRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.listRoutines.mockReset().mockResolvedValue([]);
  mocks.listRecentRuns.mockReset().mockResolvedValue([]);
  mocks.summarizeRunsByWorker.mockReset().mockResolvedValue(new Map());
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
});

describe("what the dashboard reads", () => {
  it("reads the activity list and the summaries separately", async () => {
    await DashboardPage();

    expect(mocks.listRecentRuns).toHaveBeenCalledWith("user-1");
    expect(mocks.summarizeRunsByWorker).toHaveBeenCalledWith("user-1");
  });

  /**
   * **The invariant this page exists to keep.** However many workers an account
   * has, history is read exactly twice — once bounded for the list, once
   * counted for the numbers.
   */
  it.each([1, 10, 100])(
    "reads history twice for an account with %i workers",
    async (count) => {
      mocks.listRoutines.mockResolvedValue(
        Array.from({ length: count }, (_, index) => worker(`worker-${index}`)),
      );

      await DashboardPage();

      expect(mocks.listRecentRuns).toHaveBeenCalledTimes(1);
      expect(mocks.summarizeRunsByWorker).toHaveBeenCalledTimes(1);
    },
  );

  it("asks for both as the signed-in account", async () => {
    await DashboardPage();

    expect(mocks.listRecentRuns.mock.calls[0][0]).toBe("user-1");
    expect(mocks.summarizeRunsByWorker.mock.calls[0][0]).toBe("user-1");
  });

  /**
   * The activity list is handed whatever the bounded read returned — the page
   * does not slice it, because slicing after the fact would mean the rows had
   * already been fetched.
   */
  it("does not trim the activity list itself", async () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({
      id: `run-${index}`,
      status: "completed" as const,
      startedAt: NOW,
      output: "",
      routineName: "Worker",
    }));
    mocks.listRecentRuns.mockResolvedValue(runs);

    const passed = passedProp(await DashboardPage(), "runs");

    expect(passed).toBe(runs);
  });

  /**
   * **The overview's "last execution" means ever, so it comes from the counted
   * summaries** rather than from the head of the bounded list — which would be
   * right by accident and wrong the moment the limit changed.
   */
  it("takes the last execution from the summaries", async () => {
    const older = new Date("2026-08-01T00:00:00.000Z");
    const newer = new Date("2026-08-09T00:00:00.000Z");
    mocks.summarizeRunsByWorker.mockResolvedValue(
      new Map([
        [
          "worker-1",
          {
            totalRuns: 1,
            totalFailures: 0,
            lastResult: "completed" as const,
            lastRunAt: older,
          },
        ],
        [
          "worker-2",
          {
            totalRuns: 1,
            totalFailures: 0,
            lastResult: "completed" as const,
            lastRunAt: newer,
          },
        ],
      ]),
    );
    // The activity list is deliberately empty: if the figure came from there,
    // it would be null.
    mocks.listRecentRuns.mockResolvedValue([]);

    const overview = passedProp(await DashboardPage(), "overview") as {
      lastExecution: Date | null;
    };

    expect(overview.lastExecution).toEqual(newer);
  });

  /**
   * A worker's card shows what its whole history adds up to, and the activity
   * list beside it shows twenty rows. The two numbers are allowed to disagree —
   * that is what makes the counts honest.
   */
  it("gives a worker's card the counted totals, not the visible rows", async () => {
    mocks.listRoutines.mockResolvedValue([worker("worker-1")]);
    mocks.summarizeRunsByWorker.mockResolvedValue(
      new Map([
        [
          "worker-1",
          {
            totalRuns: 100,
            totalFailures: 7,
            lastResult: "completed" as const,
            lastRunAt: NOW,
          },
        ],
      ]),
    );
    mocks.listRecentRuns.mockResolvedValue([]);

    const health = passedProp(await DashboardPage(), "health") as {
      totalRuns: number;
      totalFailures: number;
    };

    expect(health.totalRuns).toBe(100);
    expect(health.totalFailures).toBe(7);
  });
});

/** The first value handed to any component under a given prop name. */
function passedProp(node: unknown, name: string): unknown {
  let found: unknown;

  const walk = (current: unknown): void => {
    if (found !== undefined) {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    const props = (current as { props?: Record<string, unknown> }).props;
    if (!props) {
      return;
    }

    if (name in props) {
      found = props[name];
      return;
    }

    for (const value of Object.values(props)) {
      walk(value);
    }
  };

  walk(node);
  return found;
}
