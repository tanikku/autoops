import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a discovery run does, and what it records.
 *
 * **Two modules are under test here rather than one, and deliberately.** The
 * pipeline is `lib/discovery/execute.ts`; the branch that reaches it, the
 * transaction that writes what it chose, and the decision about whether the
 * owner hears about it are `lib/runs.ts`. Splitting them across two files would
 * need a second set of the same mocks, and the property that matters most —
 * that a discovery worker reaches the discovery branch rather than falling
 * through to `executePrompt` — belongs to the pair.
 *
 * **Nothing here reaches a network, a model or a database.** Every collaborator
 * is replaced, and the assertions are mostly about which of them were called
 * and which were not.
 */

const mocks = vi.hoisted(() => ({
  // the pipeline's collaborators
  getSource: vi.fn(),
  findSeenKeys: vi.fn(),
  recordSeenItems: vi.fn(),
  createProvider: vi.fn(),
  search: vi.fn(),
  select: vi.fn(),
  // what `runRoutine` needs around it
  acquire: vi.fn(),
  release: vi.fn(),
  aiExecute: vi.fn(),
  routineFind: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  transaction: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/discovery/repository", () => ({
  getDiscoverySource: mocks.getSource,
  findSeenKeys: mocks.findSeenKeys,
  recordSeenItems: mocks.recordSeenItems,
}));

vi.mock("@/lib/discovery/factory", () => ({
  createDiscoveryProvider: mocks.createProvider,
}));

vi.mock("@/lib/discovery/select", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/discovery/select")>(
      "@/lib/discovery/select",
    );
  return { ...actual, selectDiscoveryItems: mocks.select };
});

vi.mock("@/lib/execution-lease", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/execution-lease")>(
      "@/lib/execution-lease",
    );
  return {
    ...actual,
    acquireExecutionLease: mocks.acquire,
    releaseExecutionLease: mocks.release,
  };
});

vi.mock("@/lib/ai/factory", () => ({
  createAIProvider: () => ({ mode: "real", execute: mocks.aiExecute }),
}));

vi.mock("@/lib/notify/run-notification", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/notify/run-notification")>(
      "@/lib/notify/run-notification",
    );
  return { ...actual, notifyRunOutcome: mocks.notify };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findUniqueOrThrow: mocks.routineFind },
    runHistory: { create: mocks.runCreate, update: mocks.runUpdate },
    $transaction: mocks.transaction,
  },
}));

const { executeDiscovery } = await import("@/lib/discovery/execute");
const { runRoutine } = await import("@/lib/runs");
const { DISCOVERY_NO_SELECTION_OUTPUT } = await import("@/lib/run-display");
const { DiscoveryProviderError } = await import("@/lib/discovery/provider");
const { InvalidDiscoverySelectionError } = await import(
  "@/lib/discovery/select"
);

const ROUTINE_ID = "worker-1";
const USER_ID = "user-1";
const RUN_ID = "run-1";

function candidate(n: string, author = `Channel ${n}`) {
  return {
    itemKey: `youtube:${n}`,
    title: `Video ${n}`,
    author,
    url: `https://www.youtube.com/watch?v=${n}`,
    publishedAt: new Date("2026-09-18T09:00:00.000Z"),
  };
}

const aiProvider = { mode: "real" as const, execute: mocks.aiExecute };

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    routineId: ROUTINE_ID,
    userId: USER_ID,
    status: "completed",
    startedAt: new Date("2026-09-19T00:00:00.000Z"),
    finishedAt: new Date("2026-09-19T00:00:05.000Z"),
    output: "",
    errorMessage: null,
    ...overrides,
  };
}

/** A provider that answers with these candidates and records that it was asked. */
function available(candidates: ReturnType<typeof candidate>[]) {
  mocks.search.mockResolvedValue(candidates);
  mocks.createProvider.mockReturnValue({
    available: true,
    provider: { source: "youtube", search: mocks.search },
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getSource.mockResolvedValue({
    id: "source-1",
    routineId: ROUTINE_ID,
    source: "youtube",
    query: "hedgehog care",
    maxResults: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  mocks.findSeenKeys.mockResolvedValue(new Set<string>());
  mocks.recordSeenItems.mockResolvedValue(0);
  mocks.select.mockResolvedValue([]);
  available([]);

  mocks.acquire.mockResolvedValue({ token: "lease-1" });
  mocks.release.mockResolvedValue(undefined);
  mocks.routineFind.mockResolvedValue({
    userId: USER_ID,
    name: "Recommendations",
    prompt: "",
    kind: "discovery",
    emailNotificationsEnabled: false,
  });
  mocks.runCreate.mockResolvedValue(run({ status: "running" }));
  mocks.runUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) =>
    run(args.data),
  );
  // A transaction that runs its callback against the same mocked client.
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ runHistory: { update: mocks.runUpdate } }),
  );
});

describe("a run that finds nothing to recommend", () => {
  /** No candidates at all: a finished run, and no model is asked. */
  it("completes without asking a model when the source returned nothing", async () => {
    available([]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(result).toEqual({
      status: "completed",
      selected: [],
      selections: [],
      output: DISCOVERY_NO_SELECTION_OUTPUT,
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  /**
   * **The case the whole history lookup exists for.** Everything the search
   * found has been recommended before, so there is nothing to choose from — and
   * paying a model to be told so would be the cost the exclusion set avoids.
   */
  it("completes without asking a model when everything found is already seen", async () => {
    available([candidate("a"), candidate("b")]);
    mocks.findSeenKeys.mockResolvedValue(
      new Set(["youtube:a", "youtube:b"]),
    );

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(result.status).toBe("completed");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.recordSeenItems).not.toHaveBeenCalled();
  });

  it("completes when the model chose none of what was offered", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(result).toMatchObject({
      status: "completed",
      selected: [],
      output: DISCOVERY_NO_SELECTION_OUTPUT,
    });
  });

  /**
   * Diversity is applied inside `readDiscoverySelections`, so an answer that
   * named two videos from one channel arrives here as one selection — and one
   * that named only same-author duplicates arrives as none. Both are finished
   * runs.
   */
  it("completes when everything the model chose was filtered out", async () => {
    available([candidate("a", "One Channel"), candidate("b", "One Channel")]);
    mocks.select.mockResolvedValue([]);

    expect(
      (await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider })).status,
    ).toBe("completed");
  });

  /** Zero is not padded out to the number the owner asked for. */
  it("keeps fewer than were asked for rather than filling the list", async () => {
    available([candidate("a"), candidate("b"), candidate("c")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:b", reason: "the one" }]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(result.status).toBe("completed");
    expect(result.status === "completed" && result.selected).toHaveLength(1);
  });
});

describe("a run that finds something", () => {
  it("keeps only what the model chose, in the order it chose", async () => {
    available([candidate("a"), candidate("b"), candidate("c")]);
    mocks.select.mockResolvedValue([
      { itemKey: "youtube:c", reason: "closest" },
      { itemKey: "youtube:a", reason: "also good" },
    ]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(result.status === "completed" && result.selected.map((c) => c.itemKey)).toEqual([
      "youtube:c",
      "youtube:a",
    ]);
  });

  /** The exclusion set is asked about the candidates, never about a window. */
  it("asks the history about exactly the candidates it found", async () => {
    available([candidate("a"), candidate("b")]);

    await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(mocks.findSeenKeys).toHaveBeenCalledWith(ROUTINE_ID, USER_ID, [
      "youtube:a",
      "youtube:b",
    ]);
  });

  /** Something recommended before is never offered to the model again. */
  it("does not offer the model anything it has already recommended", async () => {
    available([candidate("a"), candidate("b")]);
    mocks.findSeenKeys.mockResolvedValue(new Set(["youtube:a"]));
    mocks.select.mockResolvedValue([{ itemKey: "youtube:b", reason: "new" }]);

    await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    const offered = mocks.select.mock.calls[0][1] as {
      candidates: { itemKey: string }[];
    };

    expect(offered.candidates.map((c) => c.itemKey)).toEqual(["youtube:b"]);
  });

  it("asks for as many as the worker was configured for", async () => {
    mocks.getSource.mockResolvedValue({
      id: "source-1",
      routineId: ROUTINE_ID,
      source: "youtube",
      query: "hedgehog care",
      maxResults: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    available([candidate("a")]);

    await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(mocks.select.mock.calls[0][1]).toMatchObject({
      maxResults: 3,
      query: "hedgehog care",
    });
  });
});

describe("a run that fails", () => {
  async function failureOf(): Promise<string> {
    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    if (result.status !== "failed") {
      throw new Error("expected the run to fail");
    }

    return result.errorMessage;
  }

  /** **Nothing is recreated and nothing is guessed.** */
  it("fails when the worker has no search configured", async () => {
    mocks.getSource.mockResolvedValue(null);

    expect(await failureOf()).toMatch(/no search configured/);
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it.each(["not-configured", "unknown-source"] as const)(
    "fails when the source is unavailable (%s), without a stand-in",
    async (reason) => {
      mocks.createProvider.mockReturnValue({ available: false, reason });

      expect(await failureOf()).toMatch(/not available/);
      expect(mocks.search).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it("fails when the search itself could not be made", async () => {
    mocks.createProvider.mockReturnValue({
      available: true,
      provider: { source: "youtube", search: mocks.search },
    });
    mocks.search.mockRejectedValue(new DiscoveryProviderError("timeout"));

    expect(await failureOf()).toMatch(/search could not be completed/);
  });

  it("fails when the history could not be read", async () => {
    available([candidate("a")]);
    mocks.findSeenKeys.mockRejectedValue(new Error("connection lost"));

    expect(await failureOf()).toMatch(/search could not be completed/);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("fails when the model could not be reached", async () => {
    available([candidate("a")]);
    mocks.select.mockRejectedValue(new Error("provider down"));

    expect(await failureOf()).toMatch(/Choosing what to recommend failed/);
  });

  /**
   * **A selection naming something that was not a candidate is a failure, not
   * a shorter list.** The validation that decides it lives in
   * `lib/discovery/select.ts`; what this fixes is that the pipeline does not
   * swallow it.
   */
  it.each([
    ["a malformed answer", "the answer was not an object"],
    ["a selection outside the candidate set", "a selection names an item that was not a candidate"],
    ["a duplicate selection", "a selection names the same item twice"],
  ])("fails on %s", async (_label, detail) => {
    available([candidate("a")]);
    mocks.select.mockRejectedValue(new InvalidDiscoverySelectionError(detail));

    expect(await failureOf()).toMatch(/Choosing what to recommend failed/);
  });

  /** What is stored carries nothing from outside — not the search, not a key. */
  it("stores a fixed sentence rather than anything it was told", async () => {
    available([candidate("a")]);
    mocks.select.mockRejectedValue(
      new Error("provider said: key=yt_secret_value is invalid for hedgehog care"),
    );

    const message = await failureOf();

    expect(message).not.toContain("yt_secret_value");
    expect(message).not.toContain("hedgehog care");
  });
});

/**
 * Two accounts, and nothing of one reaching the other.
 *
 * Every read goes through the owner as well as the worker; these fix the pair,
 * because a filter can be right in isolation and applied to the wrong argument.
 */
describe("two accounts", () => {
  it("reads each account's search and history as that account", async () => {
    available([candidate("a")]);

    await executeDiscovery("worker-1", "user-1", { aiProvider });
    await executeDiscovery("worker-2", "user-2", { aiProvider });

    expect(mocks.getSource.mock.calls[0]).toEqual(["worker-1", "user-1"]);
    expect(mocks.getSource.mock.calls[1]).toEqual(["worker-2", "user-2"]);
    expect(mocks.findSeenKeys.mock.calls[0].slice(0, 2)).toEqual([
      "worker-1",
      "user-1",
    ]);
    expect(mocks.findSeenKeys.mock.calls[1].slice(0, 2)).toEqual([
      "worker-2",
      "user-2",
    ]);
  });
});

/**
 * What the run's own page shows.
 *
 * **Four facts per item and no labels**, which is what keeps the output out of
 * the translation boundary: a title, an author, an address and a reason are the
 * run's own material and read the same in any language.
 */
describe("what a finished run records", () => {
  it("writes the title, the author, the address and the reason", async () => {
    available([candidate("a"), candidate("b")]);
    mocks.select.mockResolvedValue([
      { itemKey: "youtube:a", reason: "worth a look" },
    ]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });
    const output = result.status === "completed" ? result.output : "";

    expect(output).toContain("Video a");
    expect(output).toContain("Channel a");
    expect(output).toContain("https://www.youtube.com/watch?v=a");
    expect(output).toContain("worth a look");
  });

  it("writes a readable sentence when nothing was chosen", async () => {
    available([]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });

    expect(result.status === "completed" && result.output).toBe(
      DISCOVERY_NO_SELECTION_OUTPUT,
    );
  });

  /** Nothing of the provider's own answer, and no markup of any kind. */
  it("writes no markup and nothing of the provider's answer", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([
      { itemKey: "youtube:a", reason: "plain" },
    ]);

    const result = await executeDiscovery(ROUTINE_ID, USER_ID, { aiProvider });
    const output = result.status === "completed" ? result.output : "";

    expect(output).not.toMatch(/[<>]/);
    expect(output).not.toContain("youtube:a");
  });
});

/**
 * The branch, and the thing it must never do.
 *
 * **A discovery worker reaching `executePrompt` would send its instruction to a
 * model as though it were the whole of the run**, record the answer as a
 * success, and look exactly like a worker that worked. That is the failure mode
 * this describe block exists for.
 */
describe("the runtime branch", () => {
  it("runs a discovery worker through the discovery pipeline", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:a", reason: "ok" }]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.getSource).toHaveBeenCalledWith(ROUTINE_ID, USER_ID);
    // The prompt provider is never asked; only the selection step calls a model.
    expect(mocks.aiExecute).not.toHaveBeenCalled();
  });

  it("creates one run row before anything leaves the process", async () => {
    available([]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.runCreate).toHaveBeenCalledWith({
      data: { routineId: ROUTINE_ID, userId: USER_ID, status: "running" },
    });
  });

  it("gives the lease back however the run ends", async () => {
    mocks.createProvider.mockReturnValue({
      available: false,
      reason: "not-configured",
    });

    await runRoutine(ROUTINE_ID);

    expect(mocks.release).toHaveBeenCalledWith(ROUTINE_ID, "lease-1");
  });

  it("records a failure as a failed run", async () => {
    mocks.getSource.mockResolvedValue(null);

    const finished = await runRoutine(ROUTINE_ID);

    expect(finished.status).toBe("failed");
    expect(mocks.recordSeenItems).not.toHaveBeenCalled();
  });
});

/**
 * What gets written down, and that it is written down together.
 *
 * **One transaction, two writes.** A run recorded as completed whose choices
 * were not written would offer the same things again tomorrow; choices written
 * against a run nobody can see would exclude items on behalf of nothing.
 */
describe("persistence", () => {
  it("writes the choices and the finished run in one transaction", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:a", reason: "ok" }]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.recordSeenItems).toHaveBeenCalledTimes(1);

    const [routineId, selected] = mocks.recordSeenItems.mock.calls[0] as [
      string,
      { itemKey: string }[],
    ];

    expect(routineId).toBe(ROUTINE_ID);
    expect(selected.map((c) => c.itemKey)).toEqual(["youtube:a"]);
  });

  /** **Only what was chosen.** A candidate that was merely looked at is not history. */
  it("writes down only what was chosen, never what was considered", async () => {
    available([candidate("a"), candidate("b"), candidate("c")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:b", reason: "ok" }]);

    await runRoutine(ROUTINE_ID);

    const selected = mocks.recordSeenItems.mock.calls[0][1] as {
      itemKey: string;
    }[];

    expect(selected.map((c) => c.itemKey)).toEqual(["youtube:b"]);
  });

  it("writes nothing when the run chose nothing", async () => {
    available([]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.recordSeenItems).toHaveBeenCalledWith(ROUTINE_ID, [], expect.anything());
  });

  /**
   * **A duplicate is absorbed by the constraint, not chased.** Two overlapping
   * runs can choose the same thing; `recordSeenItems` passes `skipDuplicates`,
   * and nothing here retries.
   */
  it("does not retry when a write records fewer rows than it was given", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:a", reason: "ok" }]);
    mocks.recordSeenItems.mockResolvedValue(0);

    const finished = await runRoutine(ROUTINE_ID);

    expect(finished.status).toBe("completed");
    expect(mocks.recordSeenItems).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("records a failed run when the finalization could not commit", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:a", reason: "ok" }]);
    mocks.transaction.mockRejectedValue(new Error("deadlock"));

    const finished = await runRoutine(ROUTINE_ID);

    expect(finished.status).toBe("failed");
  });
});

/**
 * Who hears about it.
 *
 * **A run that chose nothing tells nobody.** It is a successful run with
 * nothing to report, exactly as a website worker's unchanged page is, and an
 * email about it would arrive on every cadence for as long as the search stayed
 * quiet.
 */
describe("notifications", () => {
  function notifying() {
    mocks.routineFind.mockResolvedValue({
      userId: USER_ID,
      name: "Recommendations",
      prompt: "",
      kind: "discovery",
      emailNotificationsEnabled: true,
    });
  }

  it("sends once when something was chosen", async () => {
    notifying();
    available([candidate("a")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:a", reason: "ok" }]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({
      kind: "prompt-completed",
      routineId: ROUTINE_ID,
      userId: USER_ID,
    });
  });

  it("sends nothing when the run chose nothing", async () => {
    notifying();
    available([]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("sends a failure through the existing failure path", async () => {
    notifying();
    mocks.getSource.mockResolvedValue(null);

    await runRoutine(ROUTINE_ID);

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({ kind: "failed" });
  });

  it("sends nothing when the worker has notifications off", async () => {
    available([candidate("a")]);
    mocks.select.mockResolvedValue([{ itemKey: "youtube:a", reason: "ok" }]);

    await runRoutine(ROUTINE_ID);

    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
