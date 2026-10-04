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
  usageCreate: vi.fn(),
  providerMode: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  routineUpdate: vi.fn(),
  routineUpdateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
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

// The AI processing allowance is granted unless a case says otherwise; what it
// does against a database is `lib/usage/consume.ts`'s own suite.
const allowance = vi.hoisted(() => ({
  reserveAiProcessing: vi.fn<
    (
      userId: string,
    ) => Promise<
      | { granted: true; usagePeriodId: string }
      | { granted: false; refusal: "exhausted" | "unavailable" }
    >
  >(async () => ({ granted: true, usagePeriodId: "period-1" })),
}));

vi.mock("@/lib/usage/ai-allowance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/usage/ai-allowance")>()),
  reserveAiProcessing: allowance.reserveAiProcessing,
}));

beforeEach(() => {
  allowance.reserveAiProcessing.mockReset();
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
  createAIProvider: () => ({
    get mode() {
      return mocks.providerMode();
    },
    execute: mocks.execute,
  }),
}));

// **Run as an entitled account.** Who may run a worker is decided in
// `lib/entitlements/worker-execution.test.ts`; these tests are about what a run
// does once it is allowed to start.
vi.mock("@/lib/entitlements/worker-execution", () => ({
  requireWorkerExecutionEntitlement: vi.fn(async () => undefined),
}));
// **And as a plan that lets every worker email**, unless a case says otherwise.
// What one-worker plans allow is fixed in `lib/notify/email-entitlement.test.ts`
// and in the Lite cases below; the rest of these tests are about the run.
const emailPlan = vi.hoisted(() => ({
  getEffectiveEntitlement: vi.fn(),
}));
vi.mock("@/lib/entitlements/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements/index")>()),
  getEffectiveEntitlement: emailPlan.getEffectiveEntitlement,
}));
beforeEach(() => {
  emailPlan.getEffectiveEntitlement.mockReset().mockResolvedValue({
    state: "active",
    entitled: true,
    plan: "beta",
    limits: { email: "all-workers" },
    trial: null,
    period: null,
    expiresAt: null,
    notificationWorkerId: null,
  });
});
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
    providerUsageEvent: { create: mocks.usageCreate },
    runHistory: { create: mocks.create, update: mocks.update, findMany: mocks.findMany },
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
const { TruncatedAIResponseError } = await import("@/lib/ai/provider");
const { EmailDeliveryError } = await vi.importActual<
  typeof import("@/lib/notify/email")
>("@/lib/notify/email");
const { WatcherError } = await vi.importActual<
  typeof import("@/lib/watcher/errors")
>("@/lib/watcher/errors");
const { normalizeWebsiteContent } = await vi.importActual<
  typeof import("@/lib/watcher/normalize")
>("@/lib/watcher/normalize");

/**
 * What a real provider hands back.
 *
 * **The text is still the product**, and every assertion about a stored
 * summary reads it; the rest is what the provider always knew and used to
 * throw away before anything counted calls.
 */
function aiResult(
  text = "a summary",
  overrides: Record<string, unknown> = {},
) {
  return {
    text,
    provider: "anthropic" as const,
    model: "claude-opus-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
    ...overrides,
  };
}

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
  mocks.execute.mockReset().mockResolvedValue(aiResult("Two roles were added."));
  mocks.usageCreate.mockReset().mockResolvedValue({});
  mocks.providerMode.mockReset().mockReturnValue("real");
  mocks.findUniqueOrThrow.mockReset().mockResolvedValue(worker());
  mocks.routineUpdate.mockReset();
  mocks.routineUpdateMany.mockReset();
  mocks.create.mockReset().mockResolvedValue(RUN_ROW);
  // No earlier runs unless a case says otherwise: every failure is the first.
  mocks.findMany.mockReset().mockResolvedValue([]);
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
    expect(subject()).toBe('[Koqentra] "Careers page" detected a change');
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
    expect(subject()).toBe('[Koqentra] "Careers page" failed');
  });

  /**
   * **The one failure that is ours rather than the site's.** Only the email is
   * excluded — the run is still `failed` and still carries its reason.
   */
  it("sends nothing when Koqentra declined to fetch the page", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("throttled", "Koqentra fetched this site a moment ago."),
    );

    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
    expect(written().status).toBe("failed");
    expect(written().errorMessage).toBe(
      "Koqentra fetched this site a moment ago.",
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
    expect(subject()).toBe('[Koqentra] "Careers page" completed');
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
    mocks.execute.mockResolvedValue(aiResult(""));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" completed');
  });

  it("emails when the run failed", async () => {
    mocks.execute.mockRejectedValue(new Error("the model refused"));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" failed');
  });

  it("sends nothing when the outcome could not be written down", async () => {
    mocks.update.mockRejectedValue(new Error("the database refused"));

    await expect(runRoutine("worker-1")).rejects.toBeInstanceOf(
      RunPersistenceError,
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

/**
 * **A run the AI processing allowance refused tells nobody.** It is recorded as
 * `failed` because a run has no other way to finish, but nothing went wrong:
 * the account is out of allowance, and an email on every cadence until the
 * period turns over would be noise about something the owner already knows how
 * to see.
 */
describe("a run the AI processing allowance refused", () => {
  it.each(["exhausted", "unavailable"] as const)(
    "sends nothing for a prompt worker refused as %s",
    async (refusal) => {
      mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
      allowance.reserveAiProcessing.mockResolvedValueOnce({ granted: false, refusal });

      await runRoutine("worker-1");

      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("sends nothing for a website worker whose change was refused", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    allowance.reserveAiProcessing.mockResolvedValueOnce({ granted: false, refusal: "exhausted" });

    await runRoutine("worker-1");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  /** Only the refusal is quiet: a model that failed is still a failure. */
  it("still emails a prompt run whose model failed after the unit was taken", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.execute.mockRejectedValue(new Error("the model refused"));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" failed');
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

/** An answer cut off at its output limit is never announced as a result. */
describe("an answer cut off at its output limit", () => {
  const cutOff = () =>
    new TruncatedAIResponseError({
      provider: "anthropic",
      model: "claude-opus-5",
      usage: null,
    });

  it("is told as a failed prompt run, never a completed one", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.execute.mockRejectedValue(cutOff());

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" failed');
  });

  it("is never announced as a detected change", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    mocks.execute.mockRejectedValue(cutOff());

    await runRoutine("worker-1");

    const subjects = mocks.send.mock.calls.map((call) => call[0].subject);
    expect(subjects).not.toContain('[Koqentra] "Careers page" detected a change');
  });
});

/**
 * A plan that lets one worker email: only the chosen one does, for every kind
 * of message a run can send.
 *
 * **The run is untouched either way.** Whether an email goes is decided after
 * the outcome is recorded, so a worker that may not email still completes or
 * fails exactly as it would have.
 */
describe("a plan that lets one worker email", () => {
  function lite(chosen: string | null) {
    emailPlan.getEffectiveEntitlement.mockResolvedValue({
      state: "active",
      entitled: true,
      plan: "lite",
      limits: { email: "one-worker" },
      trial: null,
      period: null,
      expiresAt: null,
      notificationWorkerId: chosen,
    });
  }

  it.each([
    ["the chosen worker", "worker-1", 1],
    ["another worker", "worker-9", 0],
    ["nobody chosen", null, 0],
  ] as const)("emails a completed prompt run for %s accordingly", async (_label, chosen, sent) => {
    lite(chosen);
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(sent);
    expect(written().status).toBe("completed");
  });

  it.each([
    ["the chosen worker", "worker-1", 1],
    ["another worker", "worker-9", 0],
  ] as const)("emails a failed run for %s accordingly", async (_label, chosen, sent) => {
    lite(chosen);
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.execute.mockRejectedValue(new Error("the model refused"));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(sent);
    expect(written().status).toBe("failed");
  });

  it.each([
    ["the chosen worker", "worker-1", 1],
    ["another worker", "worker-9", 0],
  ] as const)("emails a changed page for %s accordingly", async (_label, chosen, sent) => {
    lite(chosen);
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(sent);
  });

  it("sends nothing for the chosen worker when its own switch is off", async () => {
    lite("worker-1");
    mocks.findUniqueOrThrow.mockResolvedValue(
      worker({ kind: "prompt", emailNotificationsEnabled: false }),
    );

    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
    expect(emailPlan.getEffectiveEntitlement).not.toHaveBeenCalled();
  });

  it.each(["standard", "pro", "trial", "beta"])(
    "lets every worker on %s email, chosen or not",
    async (plan) => {
      emailPlan.getEffectiveEntitlement.mockResolvedValue({
        state: plan === "trial" ? "trialing" : "active",
        entitled: true,
        plan,
        limits: { email: "all-workers" },
        trial: null,
        period: null,
        expiresAt: null,
        notificationWorkerId: "worker-9",
      });
      mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));

      await runRoutine("worker-1");

      expect(mocks.send).toHaveBeenCalledTimes(1);
    },
  );

  /** Not knowing is not permission, and it changes nothing about the run. */
  it("sends nothing when the plan cannot be read, and leaves the run as it was", async () => {
    emailPlan.getEffectiveEntitlement.mockRejectedValue(new Error("connection lost"));
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));

    await runRoutine("worker-1");

    expect(mocks.send).not.toHaveBeenCalled();
    expect(written().status).toBe("completed");
  });

  it("reads the plan when the email is about to go, for the owner named on the worker", async () => {
    lite("worker-1");
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt", userId: "user-a" }));

    await runRoutine("worker-1");

    expect(emailPlan.getEffectiveEntitlement).toHaveBeenCalledWith("user-a");
  });
});


/**
 * A website worker waiting for something, through the same send gate.
 *
 * **The decision only decides whether there is anything to tell.** A change
 * judged not to be the one waited for is told to nobody; one that is, or a run
 * that failed, then goes through the plan's rules exactly as any other run's
 * message does.
 */
describe("a website worker with a target condition", () => {
  function plan(email: "all-workers" | "one-worker", chosen: string | null = null) {
    emailPlan.getEffectiveEntitlement.mockResolvedValue({
      state: "active",
      entitled: true,
      plan: email === "one-worker" ? "lite" : "beta",
      limits: { email },
      trial: null,
      period: null,
      expiresAt: null,
      notificationWorkerId: chosen,
    });
  }

  function waiting() {
    mocks.findUniqueOrThrow.mockResolvedValue({
      ...worker(),
      targetCondition: "A room opens for May 2",
    });
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
  }

  function decides(notify: boolean) {
    mocks.execute.mockResolvedValue(
      aiResult(JSON.stringify({ notify, summary: notify ? "May 2 opened." : "Only May 3." })),
    );
  }

  it.each([
    ["not the change, every worker may email", false, "all-workers", null, 0],
    ["the change, every worker may email", true, "all-workers", null, 1],
    ["the change, this is the one emailing worker", true, "one-worker", "worker-1", 1],
    ["the change, another worker emails", true, "one-worker", "worker-9", 0],
    ["not the change, this is the one emailing worker", false, "one-worker", "worker-1", 0],
  ] as const)("%s", async (_label, notify, email, chosen, sent) => {
    plan(email, chosen);
    waiting();
    decides(notify);

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(sent);
    if (sent === 1) {
      expect(subject()).toBe('[Koqentra] "Careers page" detected a change');
    }
  });

  it.each([
    ["this is the one emailing worker", "worker-1", 1],
    ["another worker emails", "worker-9", 0],
  ] as const)("tells a failed decision the usual way when %s", async (_label, chosen, sent) => {
    plan("one-worker", chosen);
    waiting();
    mocks.execute.mockResolvedValue(aiResult("not a decision"));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(sent);
    if (sent === 1) {
      expect(subject()).toBe('[Koqentra] "Careers page" failed');
    }
  });
});

/**
 * One failure email per streak.
 *
 * `findMany` stands for the worker's earlier runs, newest first — what the
 * streak lookup reads. Each run below is one call of `runRoutine`, so a
 * sequence is the same worker run again with the history it would then have.
 */
describe("a worker that keeps failing", () => {
  const COMPLETED = { status: "completed", errorMessage: null };
  const FAILED = { status: "failed", errorMessage: "The site answered with 503." };
  const RUNNING = { status: "running", errorMessage: null };
  const ALLOWANCE = { status: "failed", errorMessage: "AI processing limit reached." };

  function failFetch() {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("http-error", "The site answered with 503."),
    );
  }

  async function runWith(earlier: { status: string; errorMessage: string | null }[]) {
    mocks.findMany.mockResolvedValueOnce(earlier);
    await runRoutine("worker-1");
  }

  it("emails the first failure after a completed run", async () => {
    failFetch();

    await runWith([COMPLETED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" failed');
  });

  it("emails the first failure of a worker with no earlier run", async () => {
    failFetch();

    await runWith([]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("emails once over completed → failed → failed, and the run still says failed", async () => {
    failFetch();

    await runWith([COMPLETED]);
    await runWith([FAILED, COMPLETED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(written().status).toBe("failed");
    expect(written().errorMessage).toBe("The site answered with 503.");
  });

  it("emails again after a recovery: completed → failed → failed → completed → failed", async () => {
    failFetch();

    await runWith([COMPLETED]);
    await runWith([FAILED, COMPLETED]);
    await runWith([COMPLETED, FAILED, FAILED, COMPLETED]);

    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("keeps the streak when the error changes: fetch, then provider", async () => {
    failFetch();
    await runWith([COMPLETED]);

    // The page has moved, and the model now fails on it.
    mocks.fetchWatchedPage.mockReset().mockResolvedValue(fetched());
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());
    mocks.execute.mockRejectedValue(new Error("the model refused"));
    await runWith([FAILED, COMPLETED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("emails when the earlier run is still marked running", async () => {
    failFetch();

    await runWith([RUNNING, FAILED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("skips a silent failure to find the streak: failed → allowance → failed", async () => {
    failFetch();

    await runWith([ALLOWANCE, FAILED]);

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not let a silent failure start one: completed → allowance → failed", async () => {
    failFetch();

    await runWith([ALLOWANCE, COMPLETED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("asks only about earlier runs of this worker, excluding this run, newest first, twenty at most", async () => {
    failFetch();

    await runWith([]);

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        routineId: "worker-1",
        id: { not: RUN_ROW.id },
        startedAt: { lt: RUN_ROW.startedAt },
      },
      orderBy: { startedAt: "desc" },
      take: 20,
    });
  });

  it("sends when the earlier runs cannot be read", async () => {
    failFetch();
    mocks.findMany.mockRejectedValueOnce(new Error("the database refused"));

    await runRoutine("worker-1");

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("never reads earlier runs for a worker with email off", async () => {
    failFetch();
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ emailNotificationsEnabled: false }));

    await runRoutine("worker-1");

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("never reads earlier runs for a silent failure, which sends nothing as before", async () => {
    mocks.fetchWatchedPage.mockRejectedValue(
      new WatcherError("throttled", "Koqentra fetched this site a moment ago."),
    );

    await runRoutine("worker-1");

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("suppresses a prompt worker's repeated failure the same way", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));
    mocks.execute.mockRejectedValue(new Error("the model refused"));

    await runWith([COMPLETED]);
    await runWith([FAILED, COMPLETED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  /** Only failure emails: a streak never silences news that something worked. */
  it("still emails a changed page while earlier runs failed", async () => {
    mocks.getWebsiteSnapshot.mockResolvedValue(changedSnapshot());

    await runWith([FAILED, FAILED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" detected a change');
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("still emails a completed prompt run while earlier runs failed", async () => {
    mocks.findUniqueOrThrow.mockResolvedValue(worker({ kind: "prompt" }));

    await runWith([FAILED]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(subject()).toBe('[Koqentra] "Careers page" completed');
  });

  describe("on a plan that lets one worker email", () => {
    function lite(chosen: string | null) {
      emailPlan.getEffectiveEntitlement.mockResolvedValue({
        state: "active",
        entitled: true,
        plan: "lite",
        limits: { email: "one-worker" },
        trial: null,
        period: null,
        expiresAt: null,
        notificationWorkerId: chosen,
      });
    }

    it("emails the chosen worker's first failure and not its second", async () => {
      lite("worker-1");
      failFetch();

      await runWith([COMPLETED]);
      await runWith([FAILED, COMPLETED]);

      expect(mocks.send).toHaveBeenCalledTimes(1);
    });

    it("still emails nothing for a worker that is not the chosen one", async () => {
      lite("worker-9");
      failFetch();

      await runWith([COMPLETED]);

      expect(mocks.send).not.toHaveBeenCalled();
    });

    it("does not read the plan for a failure that repeats one already sent", async () => {
      lite("worker-1");
      failFetch();

      await runWith([FAILED]);

      expect(emailPlan.getEffectiveEntitlement).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    });
  });
});
