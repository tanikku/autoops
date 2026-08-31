import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which finished runs are worth an email, and what an email cannot do to one.
 *
 * **Only two things are stood in below the notification: the provider that
 * would send, and the row that says who to.** Everything between a run
 * finishing and a message being composed is the real code — which is what makes
 * "a website worker that found nothing sends nothing" a fact about execution
 * rather than about a spy.
 *
 * **Nothing here can send anything or call a model.** `sendPlainTextEmail` is a
 * spy and the provider is the stand-in shape, so there is no path out of the
 * process at all.
 *
 * The second half of the file is the invariant the whole feature is held to: a
 * send that fails changes nothing about the run it was about.
 */

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  execute: vi.fn(),
  providerMode: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  routineUpdate: vi.fn(),
  routineUpdateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  getWebsiteSource: vi.fn(),
  getWebsiteSnapshot: vi.fn(),
  createBaseline: vi.fn(),
  markCheckedIfCurrent: vi.fn(),
  advanceIfCurrent: vi.fn(),
  fetchWatchedPage: vi.fn(),
  getRecipient: vi.fn(),
  send: vi.fn(),
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
  createAIProvider: () => ({
    get mode() {
      return mocks.providerMode();
    },
    execute: mocks.execute,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: {
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      // **Spies on writes nothing here may make.** A notification must not
      // touch the schedule or the lease columns, and a call to either of these
      // would show up as a called spy rather than as nothing at all.
      update: mocks.routineUpdate,
      updateMany: mocks.routineUpdateMany,
    },
    runHistory: { create: mocks.create, update: mocks.update },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
}));

vi.mock("@/lib/website-snapshots", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/website-snapshots")>(
      "@/lib/website-snapshots",
    );

  return {
    ...actual,
    getWebsiteSnapshot: mocks.getWebsiteSnapshot,
    createWebsiteSnapshotBaseline: mocks.createBaseline,
    markWebsiteSnapshotCheckedIfCurrent: mocks.markCheckedIfCurrent,
    advanceWebsiteSnapshotIfCurrent: mocks.advanceIfCurrent,
  };
});

vi.mock("@/lib/watcher/fetch", () => ({
  fetchWatchedPage: mocks.fetchWatchedPage,
}));

vi.mock("@/lib/users", () => ({
  getNotificationRecipient: mocks.getRecipient,
}));

vi.mock("@/lib/notify/email", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/notify/email")>(
      "@/lib/notify/email",
    );

  return { ...actual, sendPlainTextEmail: mocks.send };
});

const { runRoutine, RunPersistenceError } = await import("@/lib/runs");
const { EmailDeliveryError } = await vi.importActual<
  typeof import("@/lib/notify/email")
>("@/lib/notify/email");
const { WatcherError } = await vi.importActual<
  typeof import("@/lib/watcher/errors")
>("@/lib/watcher/errors");
const { normalizeWebsiteContent } = await vi.importActual<
  typeof import("@/lib/watcher/normalize")
>("@/lib/watcher/normalize");

const LEASE = { token: "token-a", expiresAt: new Date("2026-08-31T01:00:00Z") };

const RUN_ROW = {
  id: "run-1",
  routineId: "worker-1",
  userId: "user-a",
  status: "running",
  startedAt: new Date("2026-08-31T00:45:00.000Z"),
  finishedAt: null,
  output: "",
  errorMessage: null,
};

const SOURCE = {
  id: "source-1",
  routineId: "worker-1",
  url: "https://example.test/careers",
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
  updatedAt: new Date("2026-08-30T00:00:00.000Z"),
};

const MARKUP =
  "<html><head><title>Careers</title></head><body><p>Hiring</p></body></html>";
const CURRENT = normalizeWebsiteContent(MARKUP, "text/html");

function fetched() {
  const body = Uint8Array.from(Buffer.from(MARKUP, "utf-8"));
  return {
    url: SOURCE.url,
    status: 200,
    contentType: "text/html" as const,
    contentTypeHeader: "text/html; charset=utf-8",
    body,
    byteLength: body.byteLength,
  };
}

/** A baseline holding exactly what the page says now: nothing changed. */
function unchangedSnapshot() {
  return {
    id: "snapshot-1",
    websiteSourceId: SOURCE.id,
    normalizedContent: CURRENT.normalizedContent,
    contentHash: CURRENT.contentHash,
    lastCheckedAt: new Date("2026-08-30T12:00:00.000Z"),
    lastChangedAt: null,
    createdAt: new Date("2026-08-30T12:00:00.000Z"),
  };
}

/** A baseline holding something else: the page moved. */
function changedSnapshot() {
  return {
    ...unchangedSnapshot(),
    normalizedContent: "Careers\nNot hiring",
    contentHash: "a-different-digest",
  };
}

/** A worker of the given kind, with notifications on unless said otherwise. */
function worker(
  overrides: {
    kind?: "prompt" | "website";
    emailNotificationsEnabled?: boolean;
    userId?: string;
    name?: string;
  } = {},
) {
  return {
    userId: overrides.userId ?? "user-a",
    name: overrides.name ?? "Careers page",
    prompt: "Say what changed.",
    kind: overrides.kind ?? "website",
    emailNotificationsEnabled: overrides.emailNotificationsEnabled ?? true,
  };
}

/** The subject of the one message that was sent. */
function subject(): string {
  return mocks.send.mock.calls[0][0].subject as string;
}

/** What the last outcome write was asked to store. */
function written() {
  return mocks.update.mock.calls[mocks.update.mock.calls.length - 1][0].data;
}

const TX = { runHistory: { update: mocks.update } };

beforeEach(() => {
  mocks.acquire.mockReset().mockResolvedValue(LEASE);
  mocks.release.mockReset().mockResolvedValue("released");
  mocks.execute.mockReset().mockResolvedValue("Two roles were added.");
  mocks.providerMode.mockReset().mockReturnValue("real");
  mocks.findUniqueOrThrow.mockReset().mockResolvedValue(worker());
  mocks.routineUpdate.mockReset();
  mocks.routineUpdateMany.mockReset();
  mocks.create.mockReset().mockResolvedValue(RUN_ROW);
  mocks.update
    .mockReset()
    .mockImplementation(async ({ data }) => ({ ...RUN_ROW, ...data }));
  mocks.transaction
    .mockReset()
    .mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run(TX),
    );
  mocks.getWebsiteSource.mockReset().mockResolvedValue(SOURCE);
  mocks.getWebsiteSnapshot.mockReset().mockResolvedValue(unchangedSnapshot());
  mocks.createBaseline.mockReset().mockResolvedValue(undefined);
  mocks.markCheckedIfCurrent.mockReset().mockResolvedValue(true);
  mocks.advanceIfCurrent.mockReset().mockResolvedValue(true);
  mocks.fetchWatchedPage.mockReset().mockResolvedValue(fetched());
  mocks.getRecipient.mockReset().mockResolvedValue({
    email: "owner@example.test",
    language: "en",
    timezone: "UTC",
  });
  mocks.send.mockReset().mockResolvedValue(undefined);
  process.env.AUTH_URL = "https://autoops.example.test";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a website worker", () => {
  it("emails when the page changed", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[AutoOps] "Careers page" detected a change');
  });

  it("sends nothing when the page changed but notifications are off", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    mocks.findUniqueOrThrow.mockResolvedValue(
      worker({ emailNotificationsEnabled: false }),
    );

    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
    // A worker with notifications off never even asks who its owner is.
    expect(mocks.getRecipient).not.toHaveBeenCalled();
  });

  /**
   * **The two quiet outcomes.** Both are successful runs, and an email about
   * either would arrive on every cadence for as long as the page sat still.
   */
  it("sends nothing when the page had not changed", async () => {
    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends nothing on the first check, which establishes a baseline", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(null);

    await runRoutine("worker-1");

    expect(mocks.createBaseline).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("emails when the run failed", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("http-error", "The site answered with 503."),
    );

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[AutoOps] "Careers page" failed');
  });

  /**
   * **The one failure that is ours rather than the site's.** Only the email is
   * excluded — the run is still `failed` and still carries its reason.
   */
  it("sends nothing when AutoOps declined to fetch the page", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("throttled", "AutoOps fetched this site a moment ago."),
    );

    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
    expect(written().status).toBe("failed");
    expect(written().errorMessage).toBe(
      "AutoOps fetched this site a moment ago.",
    );
  });

  it("sends nothing when the outcome could not be written down", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    mocks.update.mockRejectedValue(new Error("the database refused"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("a prompt worker", () => {
  beforeEach(() => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
  });

  it("emails when the run completed", async () => {
    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[AutoOps] "Careers page" completed');
  });

  it("sends nothing when notifications are off", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(
      worker({ kind: "prompt", emailNotificationsEnabled: false }),
    );

    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
  });

  /** An answer of nothing is still an answer, and the run still completed. */
  it("emails a completed run that produced nothing", async () => {
    mocks.execute.mockResolvedValue("");

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[AutoOps] "Careers page" completed');
  });

  it("emails when the run failed", async () => {
    mocks.execute.mockRejectedValue(new Error("the model refused"));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[AutoOps] "Careers page" failed');
  });

  it("sends nothing when the outcome could not be written down", async () => {
    mocks.update.mockRejectedValue(new Error("the database refused"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("whose inbox it is", () => {
  it("asks for the owner named on the worker, not for anybody else", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(
      worker({ kind: "prompt", userId: "user-b" }),
    );
    mocks.getRecipient.mockResolvedValue({
      email: "b@example.test",
      language: "en",
      timezone: "UTC",
    });

    await runRoutine("worker-1");

    expect(mocks.getRecipient).toHaveBeenCalledTimes(1);
    expect(mocks.getRecipient).toHaveBeenCalledWith("user-b");
    expect(mocks.send.mock.calls[0][0].to).toBe("b@example.test");
  });

  it("sends nothing when the owner's address cannot be read", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.getRecipient.mockResolvedValue(null);

    const run = await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
    expect(run.status).toBe("completed");
  });
});

/**
 * **The invariant the whole feature is held to.** Everything below arranges a
 * send that does not happen and then asks what the run looks like.
 */
describe("what a failed send does not change", () => {
  it("leaves a completed run completed", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.send.mockRejectedValue(new EmailDeliveryError("rejected"));

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("completed");
    expect(run.output).toBe("Two roles were added.");
    expect(written().status).toBe("completed");
  });

  it("leaves a failed run's reason exactly as it was recorded", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.execute.mockRejectedValue(new Error("the model refused"));
    mocks.send.mockRejectedValue(new EmailDeliveryError("timeout"));

    const run = await runRoutine("worker-1");

    expect(run.status).toBe("failed");
    expect(run.errorMessage).toBe("the model refused");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("leaves the baseline where the run put it", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    mocks.send.mockRejectedValue(new EmailDeliveryError("network"));

    await runRoutine("worker-1");

    expect(mocks.advanceIfCurrent).toHaveBeenCalledTimes(1);
    expect(mocks.createBaseline).not.toHaveBeenCalled();
  });

  it("writes nothing to the worker itself — no schedule, no lease", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    mocks.send.mockRejectedValue(new EmailDeliveryError("not-configured"));

    await runRoutine("worker-1");

    expect(mocks.routineUpdate).not.toHaveBeenCalled();
    expect(mocks.routineUpdateMany).not.toHaveBeenCalled();
  });

  it("still gives the lease back", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.send.mockRejectedValue(new EmailDeliveryError("unreadable"));

    await runRoutine("worker-1");

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith("worker-1", LEASE.token);
  });

  /**
   * **The lease is already back by the time anything is sent.** A message that
   * takes a moment must not make the worker look busy for that moment.
   */
  it("sends after the lease has been released", async () => {
    const order: string[] = [];
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.release.mockImplementation(async () => {
      order.push("release");
      return "released";
    });
    mocks.send.mockImplementation(async () => {
      order.push("send");
    });

    await runRoutine("worker-1");

    expect(order).toEqual(["release", "send"]);
  });

  it("sends at most one message for one run", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
