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
  fetchWatchedPage: vi.fn(),
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

vi.mock("@/lib/ai/factory", () => ({
  createAIProvider: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findUniqueOrThrow: mocks.findUniqueOrThrow },
    runHistory: { create: mocks.create, update: mocks.update },
  },
}));

vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
}));

/**
 * **The write side is mocked so that calling it would be visible.** These are
 * not used by anything below; they are here so that a snapshot write appearing
 * in the execution path shows up as a called spy rather than as nothing.
 */
vi.mock("@/lib/website-snapshots", () => ({
  getWebsiteSnapshot: mocks.getWebsiteSnapshot,
  saveWebsiteSnapshot: mocks.saveWebsiteSnapshot,
  markWebsiteSnapshotChecked: mocks.markWebsiteSnapshotChecked,
}));

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

const { runRoutine } = await import("@/lib/runs");
const { WatcherError } = await import("@/lib/watcher/errors");
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

/** Every way the stored state could have been moved, and none of them were. */
function expectNothingWritten() {
  expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
  expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
}

beforeEach(() => {
  mocks.acquire.mockReset().mockResolvedValue(LEASE);
  mocks.release.mockReset().mockResolvedValue("released");
  mocks.execute.mockReset().mockResolvedValue("a summary");
  mocks.findUniqueOrThrow
    .mockReset()
    .mockResolvedValue({ userId: "user-1", prompt: "", kind: "website" });
  mocks.create.mockReset().mockResolvedValue(RUN_ROW);
  mocks.update
    .mockReset()
    .mockImplementation(async ({ data }) => ({ ...RUN_ROW, ...data }));
  mocks.getWebsiteSource.mockReset().mockResolvedValue(SOURCE);
  mocks.getWebsiteSnapshot.mockReset().mockResolvedValue(null);
  mocks.saveWebsiteSnapshot.mockReset();
  mocks.markWebsiteSnapshotChecked.mockReset();
  mocks.fetchWatchedPage.mockReset().mockResolvedValue(fetched());
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

describe("a page with no baseline yet", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(null);
  });

  it("completes the run", async () => {
    const run = await runRoutine("worker-1");

    expect(run.status).toBe("completed");
    expect(written().output).toBe("Website baseline is not established yet.");
    expect(written().errorMessage).toBeNull();
  });

  /**
   * **The baseline is not created here.** Creating one and recording the run
   * are two writes that have to succeed together, and making them do so is the
   * next step's job. Until then the worker starts from nothing every time,
   * which is wasteful and safe — the opposite trade would lose a change.
   */
  it("does not create the baseline it just found missing", async () => {
    await runRoutine("worker-1");

    expectNothingWritten();
  });
});

describe("a page that has not changed", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue(matchingSnapshot());
  });

  it("completes the run", async () => {
    const run = await runRoutine("worker-1");

    expect(run.status).toBe("completed");
    expect(written().output).toBe("Website content has not changed.");
  });

  /** Even the time it was last looked at stays where it was. */
  it("does not touch the snapshot at all", async () => {
    await runRoutine("worker-1");

    expectNothingWritten();
  });
});

/**
 * **The case the whole design turns on.**
 *
 * A change is found and then not acted on, because the part that acts on it is
 * not connected. Recording that as a completed run would say the work was done;
 * recording it as a failure says what actually happened. And because the
 * baseline does not move, the same change is found again next time — nothing is
 * consumed by a run that could not use it.
 */
describe("a page that has changed", () => {
  beforeEach(() => {
    mocks.getWebsiteSnapshot.mockResolvedValue({
      ...matchingSnapshot(),
      normalizedContent: "Careers Not hiring",
      contentHash: "0".repeat(64),
    });
  });

  it("fails the run rather than reporting work that did not happen", async () => {
    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Website change processing is not available yet.",
    );
    expect(written().output).toBe("");
  });

  it("calls no model", async () => {
    await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
  });

  /** The change survives, which is what makes shipping this half safe. */
  it("leaves the baseline where it was, so the change is found again", async () => {
    await runRoutine("worker-1");

    expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
    expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
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
 * Stated once, in one place, because it is the property that makes this
 * shippable ahead of the rest: **no outcome moves the stored state.**
 */
describe("across every outcome", () => {
  it.each([
    ["no baseline", () => mocks.getWebsiteSnapshot.mockResolvedValue(null)],
    [
      "unchanged",
      () => mocks.getWebsiteSnapshot.mockResolvedValue(matchingSnapshot()),
    ],
    [
      "changed",
      () =>
        mocks.getWebsiteSnapshot.mockResolvedValue({
          ...matchingSnapshot(),
          contentHash: "0".repeat(64),
          normalizedContent: "something else",
        }),
    ],
    [
      "no source",
      () => mocks.getWebsiteSource.mockResolvedValue(null),
    ],
    [
      "a failed fetch",
      () => mocks.fetchWatchedPage.mockRejectedValue(new Error("down")),
    ],
  ])("writes nothing to the snapshot and calls no model — %s", async (
    _name,
    arrange,
  ) => {
    arrange();

    await runRoutine("worker-1");

    expect(mocks.saveWebsiteSnapshot).not.toHaveBeenCalled();
    expect(mocks.markWebsiteSnapshotChecked).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
