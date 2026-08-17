import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a website worker does when it runs, and — more of the subject — what it
 * still does not do.
 *
 * **Nothing here writes a snapshot and nothing here calls a model.** Both
 * belong to the same later step: a baseline may only move once the work a
 * change triggered has succeeded, and there is no such work yet. Until then
 * every outcome has to leave the stored state exactly as it found it, so that
 * a change detected today is still there to be found tomorrow.
 *
 * The pipeline modules are wrapped rather than replaced — the real decoding,
 * normalising and comparing run, and the wrappers record what each was handed.
 * That way the hand-offs are fixed without a second implementation of any of
 * them appearing in this file.
 */

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  execute: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  getWebsiteSource: vi.fn(),
  getWebsiteSnapshot: vi.fn(),
  saveWebsiteSnapshot: vi.fn(),
  markWebsiteSnapshotChecked: vi.fn(),
  createBaseline: vi.fn(),
  markCheckedIfCurrent: vi.fn(),
  advanceIfCurrent: vi.fn(),
  fetchWatchedPage: vi.fn(),
  transaction: vi.fn(),
  providerMode: vi.fn(),
}));

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

/**
 * The provider is created once, when the module loads, so its `mode` is read
 * from a getter — that is what lets a test say "no key is configured" without
 * reloading the module.
 */
vi.mock("@/lib/ai/factory", () => ({
  createAIProvider: () => ({
    get mode() {
      return mocks.providerMode();
    },
    execute: mocks.execute,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findUniqueOrThrow: mocks.findUniqueOrThrow },
    runHistory: { create: mocks.create, update: mocks.update },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
}));

/**
 * The two helpers execution uses, plus the two it must not.
 *
 * **The B1 pair is mocked so that reaching for it would be visible.** Neither
 * is safe for this path — one upserts, the other matches on the source alone —
 * and a call to either would show up below as a called spy rather than as
 * nothing at all.
 */
vi.mock("@/lib/website-snapshots", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/website-snapshots")>(
      "@/lib/website-snapshots",
    );

  return {
    ...actual,
    getWebsiteSnapshot: mocks.getWebsiteSnapshot,
    saveWebsiteSnapshot: mocks.saveWebsiteSnapshot,
    markWebsiteSnapshotChecked: mocks.markWebsiteSnapshotChecked,
    createWebsiteSnapshotBaseline: mocks.createBaseline,
    markWebsiteSnapshotCheckedIfCurrent: mocks.markCheckedIfCurrent,
    advanceWebsiteSnapshotIfCurrent: mocks.advanceIfCurrent,
  };
});

/** The one step that would leave the process. Everything else stays real. */
vi.mock("@/lib/watcher/fetch", () => ({
  fetchWatchedPage: mocks.fetchWatchedPage,
}));

const decodeSpy = vi.fn();
const normalizeSpy = vi.fn();
const compareSpy = vi.fn();

vi.mock("@/lib/watcher/decode", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/watcher/decode")>(
      "@/lib/watcher/decode",
    );
  return {
    ...actual,
    decodeWebsiteContent: (...args: Parameters<typeof actual.decodeWebsiteContent>) => {
      decodeSpy(...args);
      return actual.decodeWebsiteContent(...args);
    },
  };
});

vi.mock("@/lib/watcher/normalize", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/watcher/normalize")>(
      "@/lib/watcher/normalize",
    );
  return {
    ...actual,
    normalizeWebsiteContent: (
      ...args: Parameters<typeof actual.normalizeWebsiteContent>
    ) => {
      normalizeSpy(...args);
      return actual.normalizeWebsiteContent(...args);
    },
  };
});

vi.mock("@/lib/watcher/change", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/watcher/change")>(
      "@/lib/watcher/change",
    );
  return {
    ...actual,
    detectWebsiteChange: (
      ...args: Parameters<typeof actual.detectWebsiteChange>
    ) => {
      compareSpy(...args);
      return actual.detectWebsiteChange(...args);
    },
  };
});

const { runRoutine, RunPersistenceError } = await import("@/lib/runs");
const { WatcherError } = await import("@/lib/watcher/errors");
const { WebsiteStateConflictError } = await vi.importActual<
  typeof import("@/lib/website-snapshots")
>("@/lib/website-snapshots");
const { normalizeWebsiteContent } = await vi.importActual<
  typeof import("@/lib/watcher/normalize")
>("@/lib/watcher/normalize");

const LEASE = { token: "token-a", expiresAt: new Date("2026-08-17T12:15:00Z") };

const RUN_ROW = {
  id: "run-1",
  routineId: "worker-1",
  userId: "user-1",
  status: "running",
  startedAt: new Date("2026-08-17T12:00:00.000Z"),
  finishedAt: null,
  output: "",
  errorMessage: null,
};

const SOURCE = {
  id: "source-1",
  routineId: "worker-1",
  url: "https://example.com/careers",
  createdAt: new Date("2026-08-17T00:00:00.000Z"),
  updatedAt: new Date("2026-08-17T00:00:00.000Z"),
};

const MARKUP = "<html><head><title>Careers</title></head><body><p>Hiring</p></body></html>";

/** What the page currently normalizes to, worked out with the real normalizer. */
const CURRENT = normalizeWebsiteContent(MARKUP, "text/html");

function fetched(markup = MARKUP, contentTypeHeader = "text/html; charset=utf-8") {
  const body = Uint8Array.from(Buffer.from(markup, "utf-8"));
  return {
    url: SOURCE.url,
    status: 200,
    contentType: "text/html" as const,
    contentTypeHeader,
    body,
    byteLength: body.byteLength,
  };
}

/** A stored baseline holding exactly what the page says now. */
function matchingSnapshot() {
  return {
    id: "snapshot-1",
    websiteSourceId: SOURCE.id,
    normalizedContent: CURRENT.normalizedContent,
    contentHash: CURRENT.contentHash,
    lastCheckedAt: new Date("2026-08-16T12:00:00.000Z"),
    lastChangedAt: null,
    createdAt: new Date("2026-08-16T12:00:00.000Z"),
  };
}

/** What the outcome write was asked to store. */
function written() {
  return mocks.update.mock.calls[mocks.update.mock.calls.length - 1][0].data;
}

/**
 * The stored state was not touched at all — not the baseline, not even the
 * time it was last looked at — and no model was called.
 */
function expectNothingWritten() {
  expect(mocks.createBaseline).not.toHaveBeenCalled();
  expect(mocks.markCheckedIfCurrent).not.toHaveBeenCalled();
  expect(mocks.advanceIfCurrent).not.toHaveBeenCalled();
  expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
  expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
}

/**
 * The change survived: the content and digest a comparison runs against are
 * still the old ones, so the next run reaches the same conclusion.
 */
function expectChangeNotConsumed() {
  expect(mocks.advanceIfCurrent).not.toHaveBeenCalled();
  expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
  expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
}

/**
 * The client the transaction hands its callback.
 *
 * It carries the same run-history spy as the module client, so a write made
 * through the transaction is visible to the same assertions — what
 * distinguishes them is which object the repository helper was handed.
 */
const TX = { runHistory: { update: mocks.update } };

beforeEach(() => {
  mocks.acquire.mockReset().mockResolvedValue(LEASE);
  mocks.release.mockReset().mockResolvedValue("released");
  mocks.execute.mockReset().mockResolvedValue("a summary");
  mocks.findUniqueOrThrow.mockReset().mockResolvedValue({
    userId: "user-1",
    // For a website worker the prompt is the instruction applied when the page
    // changes, not the thing that is sent on its own.
    prompt: "Summarise what changed in three points.",
    kind: "website",
  });
  mocks.create.mockReset().mockResolvedValue(RUN_ROW);
  mocks.update
    .mockReset()
    .mockImplementation(async ({ data }) => ({ ...RUN_ROW, ...data }));
  mocks.getWebsiteSource.mockReset().mockResolvedValue(SOURCE);
  mocks.getWebsiteSnapshot.mockReset().mockResolvedValue(null);
  mocks.saveWebsiteSnapshot.mockReset();
  mocks.markWebsiteSnapshotChecked.mockReset();
  mocks.createBaseline.mockReset().mockResolvedValue(undefined);
  mocks.markCheckedIfCurrent.mockReset().mockResolvedValue(true);
  mocks.advanceIfCurrent.mockReset().mockResolvedValue(true);
  mocks.providerMode.mockReset().mockReturnValue("real");
  mocks.fetchWatchedPage.mockReset().mockResolvedValue(fetched());
  // Stands in for the real thing by running the callback and handing it a
  // client. **Nothing here rolls anything back** — what these tests fix is the
  // orchestration: which writes are asked for, in one call, and what happens
  // when that call does not succeed.
  mocks.transaction
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(TX),
    );
  decodeSpy.mockReset();
  normalizeSpy.mockReset();
  compareSpy.mockReset();
});

describe("routing to a website worker", () => {
  it("does not run the worker's prompt", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.fetchWatchedPage).toHaveBeenCalledTimes(1);
  });

  it("records exactly one run, as every execution does", async () => {
    await runRoutine("worker-1");

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data).toEqual({
      routineId: "worker-1",
      userId: "user-1",
      status: "running",
    });
  });

  it("shares the execution lease with every other kind of run", async () => {
    await runRoutine("worker-1");

    expect(mocks.acquire).toHaveBeenCalledWith("worker-1");
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  /** A worker already running is still a run that never starts. */
  it("records nothing and fetches nothing when the lease is held", async () => {
    mocks.acquire.mockResolvedValue(null);

    await expect(runRoutine("worker-1")).rejects.toThrow();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.fetchWatchedPage).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("looks the source up as the owner's", async () => {
    await runRoutine("worker-1");

    expect(mocks.getWebsiteSource).toHaveBeenCalledWith("worker-1", "user-1");
  });
});

/**
 * **A website worker with no address does not fall back to its prompt.** There
 * is nothing for it to do, and doing something else instead would answer a
 * question nobody asked — with a model, and with a run recorded as a success.
 */
describe("a website worker with nothing to watch", () => {
  beforeEach(() => {
    mocks.getWebsiteSource.mockResolvedValue(null);
  });

  it("fails the run", async () => {
    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "This worker has no website address to watch.",
    );
  });

  it("fetches nothing, writes no snapshot and calls no model", async () => {
    await runRoutine("worker-1");

    expect(mocks.fetchWatchedPage).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

/**
 * The order is the contract, and so is what each step is handed. Getting the
 * bytes to the decoder and the decoded text to the normalizer is the whole of
 * what this layer contributes.
 */
describe("what each step of the pipeline is given", () => {
  it("hands the fetched bytes and the header to the decoder", async () => {
    const page = fetched(MARKUP, "text/html; charset=utf-8");
    mocks.fetchWatchedPage.mockResolvedValue(page);

    await runRoutine("worker-1");

    expect(mocks.fetchWatchedPage).toHaveBeenCalledWith(SOURCE.url);
    expect(decodeSpy).toHaveBeenCalledWith(page.body, page.contentTypeHeader);
  });

  it("hands the decoded text and its media type to the normalizer", async () => {
    await runRoutine("worker-1");

    expect(normalizeSpy).toHaveBeenCalledWith(MARKUP, "text/html");
  });

  it("hands the baseline and the normalized page to the comparison", async () => {
    const snapshot = matchingSnapshot();
    mocks.getWebsiteSnapshot.mockResolvedValue(snapshot);

    await runRoutine("worker-1");

    expect(mocks.getWebsiteSnapshot).toHaveBeenCalledWith(SOURCE.id);
    expect(compareSpy).toHaveBeenCalledWith(snapshot, CURRENT);
  });

  it("runs the steps in order", async () => {
    await runRoutine("worker-1");

    const order = [
      mocks.fetchWatchedPage.mock.invocationCallOrder[0],
      decodeSpy.mock.invocationCallOrder[0],
      normalizeSpy.mock.invocationCallOrder[0],
      compareSpy.mock.invocationCallOrder[0],
    ];

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /**
   * A page in another encoding proves the decoding is real rather than a
   * pass-through: these bytes are not valid UTF-8, and the header is the only
   * thing that says what they are.
   */
  it("decodes a page that is not UTF-8", async () => {
    // <p>日本語</p> in Shift_JIS.
    const body = Uint8Array.from([
      0x3c, 0x70, 0x3e, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x3c, 0x2f, 0x70,
      0x3e,
    ]);

    mocks.fetchWatchedPage.mockResolvedValue({
      ...fetched(),
      contentTypeHeader: "text/html; charset=Shift_JIS",
      body,
      byteLength: body.byteLength,
    });

    await runRoutine("worker-1");

    expect(normalizeSpy).toHaveBeenCalledWith("<p>日本語</p>", "text/html");
  });
});

/**
 * **The baseline and the run are written together or not at all.**
 *
 * A baseline that moved without a run saying so leaves a change nobody was
 * told about; a run recorded as finished against a baseline that did not move
 * says work happened that did not. One transaction is what stops either.
 */
describe("a page with no baseline yet", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(null);
  });

  it("creates the baseline and completes the run in one transaction", async () => {
    const run = await runRoutine("worker-1");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.createBaseline).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("completed");
    expect(written().output).toBe("Website baseline is not established yet.");
    expect(written().errorMessage).toBeNull();
  });

  it("stores what the page says now, with no change ever recorded", async () => {
    await runRoutine("worker-1");

    const [sourceId, baseline] = mocks.createBaseline.mock.calls[0];
    expect(sourceId).toBe(SOURCE.id);
    expect(baseline).toEqual({
      normalizedContent: CURRENT.normalizedContent,
      contentHash: CURRENT.contentHash,
      at: expect.any(Date),
    });
    expect(baseline).not.toHaveProperty("lastChangedAt");
  });

  it("does both writes through the transaction's client", async () => {
    await runRoutine("worker-1");

    expect(mocks.createBaseline.mock.calls[0][2]).toBe(TX);
    expect(mocks.update.mock.calls[0][0]).toBeDefined();
  });

  /** An upsert would let a second run write over a first one's baseline. */
  it("never reaches for the upsert helper", async () => {
    await runRoutine("worker-1");

    expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
  });

  it("calls no model", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
  });

  /**
   * Two runs can both find no baseline. The one that loses the unique
   * constraint has done its work against a state that no longer exists, so
   * none of it is kept.
   */
  it("fails the run when another execution created the baseline first", async () => {
    mocks.createBaseline.mockRejectedValue(
      new WebsiteStateConflictError(SOURCE.id),
    );

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Website state changed during execution.",
    );
  });

  it("does not complete a run that lost the race", async () => {
    mocks.createBaseline.mockRejectedValue(
      new WebsiteStateConflictError(SOURCE.id),
    );

    await runRoutine("worker-1");

    const outputs = mocks.update.mock.calls.map((call) => call[0].data.status);
    expect(outputs).not.toContain("completed");
  });
});

describe("a page that has not changed", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(matchingSnapshot());
  });

  it("records the check and completes the run in one transaction", async () => {
    const run = await runRoutine("worker-1");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.markCheckedIfCurrent).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("completed");
    expect(written().output).toBe("Website content has not changed.");
  });

  /**
   * **The condition is the baseline that was compared against.** Another run
   * may have advanced it in the seconds this one spent fetching, and a write
   * that did not say so would land on a state this run never saw.
   */
  it("writes only while the baseline is still the one it compared", async () => {
    const snapshot = matchingSnapshot();
    mocks.getWebsiteSnapshot.mockResolvedValue(snapshot);

    await runRoutine("worker-1");

    const [sourceId, expected, at, client] =
      mocks.markCheckedIfCurrent.mock.calls[0];
    expect(sourceId).toBe(SOURCE.id);
    expect(expected).toBe(snapshot);
    expect(at).toBeInstanceOf(Date);
    expect(client).toBe(TX);
  });

  it("never reaches for the helper that matches on the source alone", async () => {
    await runRoutine("worker-1");

    expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
    expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
  });

  it("calls no model", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails the run when the baseline moved underneath it", async () => {
    mocks.markCheckedIfCurrent.mockResolvedValue(false);

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Website state changed during execution.",
    );
  });
});

/**
 * **The case the whole feature turns on.**
 *
 * A change is found, described by a model, and only then is the baseline moved
 * past it. The ordering is the design: every way this can fail leaves the old
 * content stored, so the change is still there to be dealt with next time. The
 * opposite arrangement — move first, describe second — would spend the change
 * on a run that could not use it.
 */
describe("a page that has changed, and was described", () => {
  const STALE = {
    ...matchingSnapshot(),
    normalizedContent: "Careers Not hiring",
    contentHash: "0".repeat(64),
  };

  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(STALE);
    mocks.execute.mockResolvedValue("Three positions became five.");
  });

  it("asks a model exactly once", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  /**
   * The worker's own instruction is what to do; the page's text is what to do
   * it to. They travel in different halves of the request because one of them
   * came from somebody else's server.
   */
  it("sends the instruction and the page's text separately", async () => {
    await runRoutine("worker-1");

    const request = mocks.execute.mock.calls[0][0];
    expect(request.system).toContain("Summarise what changed in three points.");
    expect(request.user).toContain("Careers Not hiring");
    expect(request.user).toContain("Careers Hiring");
    expect(request.system).not.toContain("Careers Not hiring");
  });

  it("does not send the address, or anything about who is watching", async () => {
    await runRoutine("worker-1");

    const request = mocks.execute.mock.calls[0][0];
    const whole = `${request.system}\n${request.user}`;
    expect(whole).not.toContain(SOURCE.url);
    expect(whole).not.toContain("example.com");
    expect(whole).not.toContain(SOURCE.id);
    expect(whole).not.toContain("user-1");
  });

  it("moves the baseline and completes the run in one transaction", async () => {
    const run = await runRoutine("worker-1");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.advanceIfCurrent).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("completed");
    expect(written().output).toBe("Three positions became five.");
    expect(written().errorMessage).toBeNull();
  });

  /** The write is conditional on the baseline that was described, and on nothing else. */
  it("advances from the baseline it described to the page it read", async () => {
    await runRoutine("worker-1");

    const [sourceId, expected, next, at, client] =
      mocks.advanceIfCurrent.mock.calls[0];
    expect(sourceId).toBe(SOURCE.id);
    expect(expected).toBe(STALE);
    expect(next).toEqual(CURRENT);
    expect(at).toBeInstanceOf(Date);
    expect(client).toBe(TX);
  });

  it("does not also record a check, which would be the same write twice", async () => {
    await runRoutine("worker-1");

    expect(mocks.markCheckedIfCurrent).not.toHaveBeenCalled();
    expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
  });

  /**
   * **The change is consumed exactly once.** Having moved the baseline to what
   * the page now says, a second run over the same page finds nothing to report
   * and asks no model.
   */
  it("leaves the page unchanged for the next run", async () => {
    await runRoutine("worker-1");
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    // The baseline is now what the page says.
    mocks.getWebsiteSnapshot.mockResolvedValue(matchingSnapshot());
    mocks.update.mockClear();

    const second = await runRoutine("worker-1");

    expect(second.status).toBe("completed");
    expect(written().output).toBe("Website content has not changed.");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * **Every one of these leaves the old content stored.** The run is spent; the
 * change is not. The next run finds it again and can try once more — which is
 * what makes it safe for none of these to retry.
 */
describe("a change that could not be described", () => {
  const STALE = {
    ...matchingSnapshot(),
    normalizedContent: "Careers Not hiring",
    contentHash: "0".repeat(64),
  };

  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(STALE);
    mocks.execute.mockResolvedValue("a summary");
  });

  /**
   * **The stand-in answers everything with a fixed sentence.** Storing that as
   * the summary and moving the baseline would consume a real change and leave a
   * description of nothing behind. A prompt worker getting that sentence is
   * confusing; here it loses the change.
   */
  it("refuses to run at all without a real provider", async () => {
    mocks.providerMode.mockReturnValue("dummy");

    const run = await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "AI service is not configured for website change processing.",
    );
    expectChangeNotConsumed();
  });

  it.each([
    ["no instruction", ""],
    ["only whitespace", "   \n\t "],
    ["an instruction past the limit", "x".repeat(10_001)],
  ])("refuses before calling a model when the worker has %s", async (
    _name,
    prompt,
  ) => {
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: "user-1",
      prompt,
      kind: "website",
    });

    const run = await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Website change instructions are invalid.",
    );
    expectChangeNotConsumed();
  });

  it("accepts an instruction of exactly the limit", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: "user-1",
      prompt: "x".repeat(10_000),
      kind: "website",
    });

    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the model failed", () => mocks.execute.mockRejectedValue(new Error("model down"))],
    ["the model returned nothing", () => mocks.execute.mockResolvedValue("")],
    ["the model returned only whitespace", () => mocks.execute.mockResolvedValue("  \n ")],
  ])("records a failed run when %s", async (_name, arrange) => {
    arrange();

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe("Website change processing failed.");
    expectChangeNotConsumed();
  });

  it("does not put the model's own words in the row", async () => {
    mocks.execute.mockRejectedValue(new Error("api key sk-xyz rejected"));

    await runRoutine("worker-1");

    expect(written().errorMessage).not.toContain("sk-xyz");
  });

  /** The failure still records that the page was looked at, and nothing more. */
  it("records the check and nothing else", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));

    await runRoutine("worker-1");

    expect(mocks.markCheckedIfCurrent).toHaveBeenCalledTimes(1);
    expect(mocks.markCheckedIfCurrent.mock.calls[0][1]).toBe(STALE);
    expect(mocks.advanceIfCurrent).not.toHaveBeenCalled();
  });

  it("leaves the change to be found again", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));

    await runRoutine("worker-1");
    mocks.update.mockClear();

    // The page still says the same new thing, and the baseline is still old.
    const second = await runRoutine("worker-1");

    expect(second.status).toBe("failed");
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("does not try the model twice in one run", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));

    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("fails with a conflict when the baseline moved underneath the check", async () => {
    mocks.execute.mockRejectedValue(new Error("model down"));
    mocks.markCheckedIfCurrent.mockResolvedValue(false);

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Website state changed during execution.",
    );
  });
});

/**
 * **A summary that describes a transition from a baseline that no longer exists
 * is not kept.** Another run dealt with the same change while this one was
 * waiting for a model; writing this answer now would overwrite a newer state
 * with an older story.
 */
describe("a description that arrived too late", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue({
      ...matchingSnapshot(),
      normalizedContent: "Careers Not hiring",
      contentHash: "0".repeat(64),
    });
    mocks.execute.mockResolvedValue("Three positions became five.");
  });

  it("discards the summary when the baseline moved during the call", async () => {
    mocks.advanceIfCurrent.mockResolvedValue(false);

    const run = await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Website state changed during execution.",
    );
    expect(written().output).toBe("");
  });

  it("does not store the summary anywhere", async () => {
    mocks.advanceIfCurrent.mockResolvedValue(false);

    await runRoutine("worker-1");

    const stored = JSON.stringify(mocks.update.mock.calls);
    expect(stored).not.toContain("Three positions became five.");
  });

  it("does not ask the model again", async () => {
    mocks.advanceIfCurrent.mockResolvedValue(false);

    await runRoutine("worker-1");

    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("treats a transaction that threw the same way", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe("Execution failed.");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * **The finalization is one call, and the failure record is a second.**
 *
 * They are not atomic with each other, and that is deliberate: whatever the
 * transaction attempted has been abandoned, and the attempt still has to appear
 * in the history. It is a best-effort write, not a second half of the first.
 */
describe("a finalization that did not commit", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(matchingSnapshot());
  });

  it("records a failed run when the transaction threw", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe("Execution failed.");
  });

  it("does not put the database's own words in the row", async () => {
    mocks.transaction.mockRejectedValue(
      new Error('duplicate key value violates constraint "x" at 10.0.0.5'),
    );

    await runRoutine("worker-1");

    expect(written().errorMessage).not.toContain("10.0.0.5");
  });

  it("writes the failure outside the transaction", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));

    await runRoutine("worker-1");

    // The only update that ran is the one after the transaction rejected.
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("does not try again", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));

    await runRoutine("worker-1");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  /**
   * When even the failure cannot be written down, the existing persistence
   * error leaves as it always has. **Nothing retries.**
   */
  it("leaves as a persistence error when the failure could not be recorded", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));
    mocks.update.mockRejectedValue(new Error("write failed"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("still gives the lease back", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock detected"));

    await runRoutine("worker-1");

    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });
});

describe("a pipeline that could not finish", () => {
  it.each([
    ["the address was refused", "blocked-address", "somewhere AutoOps will not go"],
    ["the page was too large", "response-too-large", "larger than allowed"],
    ["the encoding was unreadable", "invalid-encoding", "not valid utf-8"],
    ["the charset was unsupported", "unsupported-charset", "not decoded here"],
    ["the two disagreed", "encoding-conflict", "the marks disagree"],
    ["it was not a document", "unsupported-content-type", "not a document"],
  ])("fails the run when %s", async (_name, kind, message) => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError(
        kind as ConstructorParameters<typeof WatcherError>[0],
        message,
      ),
    );

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    // A watcher failure's own wording is written for a reader and carries no
    // address, no body and no page text, so it travels as it is.
    expect(written().errorMessage).toBe(message);
    expectNothingWritten();
  });

  /**
   * **An unexpected error's message is not written for anybody**, so it does
   * not reach the row. It goes to the log, and the run records a fixed
   * sentence instead.
   */
  it("does not store the message of an error it did not expect", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432"),
    );

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe("Execution failed.");
    expect(written().errorMessage).not.toContain("10.0.0.5");
  });

  it("gives the lease back however the pipeline ended", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(new Error("anything"));

    await runRoutine("worker-1");

    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  it("writes no snapshot when the page could not be read", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(new Error("anything"));

    await runRoutine("worker-1");

    expectNothingWritten();
  });
});

/**
 * **What each outcome is allowed to move**, stated once so the whole contract
 * can be read in one place.
 *
 * `lastCheckedAt` says the page was fetched, decoded, normalized and compared
 * successfully — a fact about the looking. Anything that failed before the
 * comparison has not looked successfully, so it moves nothing at all.
 */
describe("what each outcome moves", () => {
  const changed = () =>
    mocks.getWebsiteSnapshot.mockResolvedValue({
      ...matchingSnapshot(),
      contentHash: "0".repeat(64),
      normalizedContent: "something else",
    });

  it.each([
    ["no baseline", () => mocks.getWebsiteSnapshot.mockResolvedValue(null), "create", 0],
    [
      "unchanged",
      () => mocks.getWebsiteSnapshot.mockResolvedValue(matchingSnapshot()),
      "checked",
      0,
    ],
    [
      "changed, described",
      () => {
        changed();
        mocks.execute.mockResolvedValue("a summary");
      },
      "advance",
      1,
    ],
    [
      "changed, not described",
      () => {
        changed();
        mocks.execute.mockRejectedValue(new Error("model down"));
      },
      "checked",
      1,
    ],
    [
      "changed, no real provider",
      () => {
        changed();
        mocks.providerMode.mockReturnValue("dummy");
      },
      "checked",
      0,
    ],
    ["no source", () => mocks.getWebsiteSource.mockResolvedValue(null), "none", 0],
    [
      "a failed fetch",
      () => mocks.fetchWatchedPage.mockRejectedValue(new Error("down")),
      "none",
      0,
    ],
  ])("%s moves %s, with %i model calls", async (
    _name,
    arrange,
    expected,
    modelCalls,
  ) => {
    arrange();

    await runRoutine("worker-1");

    expect(mocks.createBaseline.mock.calls.length).toBe(
      expected === "create" ? 1 : 0,
    );
    expect(mocks.markCheckedIfCurrent.mock.calls.length).toBe(
      expected === "checked" ? 1 : 0,
    );
    expect(mocks.advanceIfCurrent.mock.calls.length).toBe(
      expected === "advance" ? 1 : 0,
    );
    // Neither of the B1 helpers is ever right for this path.
    expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
    expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(modelCalls);
  });

  it.each([
    ["no source", () => mocks.getWebsiteSource.mockResolvedValue(null)],
    [
      "a failed fetch",
      () => mocks.fetchWatchedPage.mockRejectedValue(new Error("down")),
    ],
  ])("does not open a transaction for %s", async (_name, arrange) => {
    arrange();

    await runRoutine("worker-1");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
