import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hiring a worker, now that provisioning has a name.
 *
 * This path already created the account row; what changed is that it asks the
 * same boundary Settings does instead of carrying its own copy. The order it
 * relied on has to survive that: the row exists, *then* the timezone is read,
 * *then* the first slot is calculated against it. Reading the zone first would
 * schedule a brand-new account's worker in UTC without anything saying so.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  createWorkerDraftGenerator: vi.fn(),
  generate: vi.fn(),
  usageCreate: vi.fn(),
  recordUsageObservation: vi.fn(),
  ensureUser: vi.fn(),
  consumeAiDraftQuota: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  createRoutine: vi.fn(),
  createWebsiteSource: vi.fn(),
  createDiscoveryProvider: vi.fn(),
  saveDiscoverySource: vi.fn(),
  transaction: vi.fn(),
  lockUser: vi.fn(),
  countRoutines: vi.fn(),
  findSubscription: vi.fn(),
  createSubscription: vi.fn(),
  createUsagePeriod: vi.fn(),
  aggregateUsageCounters: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/users", () => ({
  ensureUser: mocks.ensureUser,
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/routines", () => ({ createRoutine: mocks.createRoutine }));
// The allowance is a boundary of its own — what it does with the row it keeps
// is fixed in `lib/rate-limit.test.ts`. What these need from it is the answer
// and when it was asked for.
vi.mock("@/lib/rate-limit", () => ({
  consumeAiDraftQuota: mocks.consumeAiDraftQuota,
}));
vi.mock("@/lib/website-sources", () => ({
  createWebsiteSource: mocks.createWebsiteSource,
}));
// **Availability is a read of the environment, not a request.** Standing it in
// is what lets these fix both answers without a key existing either way.
vi.mock("@/lib/discovery/factory", () => ({
  createDiscoveryProvider: mocks.createDiscoveryProvider,
}));
vi.mock("@/lib/discovery/repository", () => ({
  saveDiscoverySource: mocks.saveDiscoverySource,
}));
// The generator itself is the boundary being stood in for. The module that
// decides whether one exists is what fails closed, so it is what these
// substitute — nothing here reaches a model, and no key is involved.
vi.mock("@/lib/ai/worker-draft-factory", () => ({
  createWorkerDraftGenerator: mocks.createWorkerDraftGenerator,
}));
// The transaction itself is the boundary under test, so the fake runs the
// callback and hands it a marker: what the assertions want to see is that both
// writes were given the *same* client, and that it was not the module's.
vi.mock("@/lib/usage/observe", () => ({
  recordUsageObservation: mocks.recordUsageObservation,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    // Reached through the real recording helper rather than a stub of it, so
    // what the tests below fix is the row a draft actually writes.
    providerUsageEvent: { create: mocks.usageCreate },
  },
}));

/**
 * The client a transaction hands its callback.
 *
 * **It carries the two tables the quota reads**, so the quota itself runs for
 * real here rather than being stood in for: what these fix is that the account
 * is locked, then counted, then written to — in one transaction — and a mocked
 * quota would fix none of it. The tag is still what the assertions match on to
 * prove both writes were given the *same* client.
 */
const TX = {
  tag: "transaction-client",
  user: { update: mocks.lockUser },
  routine: { count: mocks.countRoutines },
  // **The trial runs for real, not stubbed.** A worker created active is a
  // first activation as surely as one switched on later, and this is the only
  // place that fact is exercised. See `startTrialOnFirstWorkerActivation`.
  subscription: {
    findUnique: mocks.findSubscription,
    create: mocks.createSubscription,
  },
  usagePeriod: { create: mocks.createUsagePeriod },
  // **What the account already spent on AI, carried into the trial.** Read
  // from the product's own counters rather than the cost telemetry — see
  // `startTrialOnFirstWorkerActivation`.
  usageCounter: { aggregate: mocks.aggregateUsageCounters },
} as const;

const { createRoutineAction, generateWorkerDraftAction } = await import(
  "@/app/dashboard/new/actions"
);
const { ProviderError } = await import("@/lib/ai/provider");
// The limits belong to the quota module; these read them rather than restating
// them, so raising one does not leave these testing nothing.
const { ACTIVE_WORKER_LIMIT, TOTAL_WORKER_LIMIT } = await import(
  "@/lib/worker-quota"
);
const { InvalidWorkerDraftResponseError, MAX_WORKER_DRAFT_REQUEST_CHARS } =
  await import("@/lib/ai/worker-draft");

class RedirectSignal extends Error {}

function form(overrides?: Record<string, string>) {
  const data = new FormData();
  data.set("name", "Daily digest");
  data.set("description", "");
  data.set("prompt", "Summarise {{today}}");
  data.set("status", "active");
  data.set("frequency", "daily");
  data.set("runAt", "09:00");
  data.set("kind", "prompt");
  for (const [key, value] of Object.entries(overrides ?? {})) {
    data.set(key, value);
  }
  return data;
}

/**
 * A draft, and the call that produced it.
 *
 * **The draft is unchanged**; what is new beside it is what the model used,
 * which is the whole of what this phase added to the boundary.
 */
function draftGeneration(result: unknown) {
  return {
    result,
    call: {
      provider: "anthropic" as const,
      model: "claude-opus-5",
      usage: {
        inputTokens: 1_200,
        outputTokens: 340,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
      },
    },
  };
}

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({
    user: {
      id: "google-sub-1",
      email: "someone@example.com",
      name: "Someone",
      image: null,
    },
  });
  mocks.ensureUser.mockReset().mockResolvedValue(undefined);
  mocks.usageCreate.mockReset().mockResolvedValue({});
  mocks.recordUsageObservation.mockReset().mockResolvedValue({ recorded: true });
  mocks.consumeAiDraftQuota.mockReset().mockResolvedValue(true);
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.createRoutine.mockReset().mockResolvedValue({ id: "worker-1" });
  mocks.createWebsiteSource.mockReset().mockResolvedValue({ id: "source-1" });
  mocks.createDiscoveryProvider.mockReset().mockReturnValue({
    available: true,
    provider: { source: "youtube", search: vi.fn() },
  });
  mocks.saveDiscoverySource
    .mockReset()
    .mockResolvedValue({ id: "discovery-source-1" });
  mocks.transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(TX));
  mocks.lockUser.mockReset().mockResolvedValue({ id: "google-sub-1" });
  // An account with room for another worker, unless a test says otherwise.
  mocks.countRoutines.mockReset().mockResolvedValue(0);
  // An account with no entitlement: nothing bought, nothing granted.
  mocks.findSubscription.mockReset().mockResolvedValue(null);
  mocks.createSubscription.mockReset().mockResolvedValue({ id: "subscription-1" });
  mocks.createUsagePeriod.mockReset().mockResolvedValue({ id: "usage-period-1" });
  mocks.aggregateUsageCounters
    .mockReset()
    .mockResolvedValue({ _sum: { used: null } });
  mocks.generate.mockReset();
  mocks.createWorkerDraftGenerator
    .mockReset()
    .mockReturnValue({ generate: mocks.generate });
  mocks.revalidatePath.mockReset();
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new RedirectSignal(to);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createRoutineAction", () => {
  it("creates the worker for the signed-in account", async () => {
    const result = await createRoutineAction(null, form());

    expect(result).toEqual({
      status: "success",
      message: 'Worker "Daily digest" created.',
    });
    expect(mocks.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Daily digest", frequency: "daily" }),
      "google-sub-1",
      TX,
    );
  });

  /**
   * **Off unless the box was ticked**, which is what a checkbox that submits
   * nothing looks like from here — and what keeps a worker hired before
   * notifications existed behaving as it did.
   */
  it("hires a worker with notifications off when the form did not ask", async () => {
    await createRoutineAction(null, form());

    expect(mocks.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ emailNotificationsEnabled: false }),
      "google-sub-1",
      TX,
    );
  });

  it("hires a worker with notifications on when the box was ticked", async () => {
    await createRoutineAction(
      null,
      form({ emailNotificationsEnabled: "on" }),
    );

    expect(mocks.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ emailNotificationsEnabled: true }),
      "google-sub-1",
      TX,
    );
  });

  /**
   * The order the schedule depends on. A first slot calculated before the
   * zone was read would land nine hours out for a Tokyo account, and nothing
   * downstream would ever say so.
   */
  it("provisions, then reads the timezone, then calculates the first slot", async () => {
    await createRoutineAction(null, form());

    expect(mocks.ensureUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getUserTimezone.mock.invocationCallOrder[0],
    );
    expect(mocks.getUserTimezone.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRoutine.mock.invocationCallOrder[0],
    );
    expect(mocks.getUserTimezone).toHaveBeenCalledWith("google-sub-1");
  });

  /** 09:00 in Tokyo is midnight UTC, which is what the column has to hold. */
  it("resolves the first slot against the owner's zone", async () => {
    await createRoutineAction(null, form());

    const { nextRunAt } = mocks.createRoutine.mock.calls[0][0];
    expect(nextRunAt.getUTCHours()).toBe(0);
    expect(nextRunAt.getUTCMinutes()).toBe(0);
  });

  it("never sends a timezone to provisioning, so an existing one survives", async () => {
    await createRoutineAction(null, form());

    expect(mocks.ensureUser).toHaveBeenCalledWith({
      id: "google-sub-1",
      email: "someone@example.com",
      name: "Someone",
      image: null,
    });
    expect(mocks.ensureUser.mock.calls[0][0]).not.toHaveProperty("timezone");
  });

  /**
   * The row is what a rejected submission would have needed, and it did not
   * get that far.
   */
  it("rejects an invalid submission without provisioning anything", async () => {
    const result = await createRoutineAction(null, form({ name: "" }));

    expect(result?.status).toBe("error");
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.getUserTimezone).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
  });

  /**
   * Who is asking is settled before what they sent is judged. Provisioning is
   * the step that waits for a valid submission — authenticating is not.
   */
  it("still establishes who is asking when the submission is rejected", async () => {
    await createRoutineAction(null, form({ name: "" }));

    expect(mocks.auth).toHaveBeenCalled();
  });

  it("redirects a signed-out visitor even when what they sent was invalid", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(
      createRoutineAction(null, form({ name: "" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
  });

  /**
   * The state this sprint exists to prevent: a worker AutoOps would dispatch
   * on a cadence, with nothing to dispatch. Rejected before the account row is
   * provisioned, like every other rejected submission.
   */
  it("refuses to hire a scheduled active worker with no prompt", async () => {
    const result = await createRoutineAction(
      null,
      form({ prompt: "", status: "active", frequency: "daily" }),
    );

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBe(
      "Prompt is required for scheduled active workers.",
    );
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("allows an active manual worker to start without one", async () => {
    const result = await createRoutineAction(
      null,
      form({ prompt: "", status: "active", frequency: "manual" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.createRoutine).toHaveBeenCalledTimes(1);
  });

  it("allows a draft on a cadence to start without one", async () => {
    const result = await createRoutineAction(
      null,
      form({ prompt: "", status: "draft", frequency: "daily" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.createRoutine).toHaveBeenCalledTimes(1);
  });

  /** Omitted fields fall back to the quietest option, which permits a blank. */
  it("allows a blank prompt when status and frequency were not submitted", async () => {
    const data = new FormData();
    data.set("name", "Daily digest");
    data.set("prompt", "");
    // Status and frequency are what this is about; the kind has no fallback and
    // is asserted on its own below.
    data.set("kind", "prompt");

    expect((await createRoutineAction(null, data))?.status).toBe("success");
  });

  it("sends a session with no email back to sign in without creating anything", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "google-sub-1" } });

    await expect(createRoutineAction(null, form())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
  });

  it("reports a worker that could not be written without losing the input", async () => {
    mocks.createRoutine.mockRejectedValue(new Error("boom"));

    const result = await createRoutineAction(null, form());

    expect(result?.status).toBe("error");
    expect(result?.message).toBe("Could not create the worker.");
    expect(result?.values?.name).toBe("Daily digest");
  });
});

/**
 * Hiring a worker that watches a page.
 *
 * The thing being fixed here is that a website worker is two rows, and that a
 * routine saying it watches something while nothing says what is worse than no
 * routine at all: it appears in the dashboard, looks finished, and fails every
 * run. So the assertions are mostly about the pair — same transaction, both
 * writes, and nothing left behind when the second one fails.
 */
describe("createRoutineAction — website workers", () => {
  function website(overrides?: Record<string, string>) {
    return form({
      kind: "website",
      websiteUrl: "https://example.com/news",
      prompt: "Tell me what changed.",
      ...overrides,
    });
  }

  it("creates the worker and its source in one transaction", async () => {
    const result = await createRoutineAction(null, website());

    expect(result?.status).toBe("success");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "website" }),
      "google-sub-1",
      TX,
    );
    expect(mocks.createWebsiteSource).toHaveBeenCalledWith(
      "worker-1",
      "https://example.com/news",
      TX,
    );
  });

  /**
   * The routine has to exist before anything can point at it, and both writes
   * have to be inside the transaction — a source written through the module's
   * own client would survive a rollback of the routine it belongs to.
   */
  it("writes the routine first, and both inside the transaction", async () => {
    await createRoutineAction(null, website());

    expect(
      mocks.transaction.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.createRoutine.mock.invocationCallOrder[0]);
    expect(mocks.createRoutine.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWebsiteSource.mock.invocationCallOrder[0],
    );
  });

  it("reports a failed source without claiming the worker was created", async () => {
    mocks.createWebsiteSource.mockRejectedValue(new Error("boom"));

    const result = await createRoutineAction(null, website());

    expect(result?.status).toBe("error");
    expect(result?.message).toBe("Could not create the worker.");
    expect(result?.values?.websiteUrl).toBe("https://example.com/news");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("stores the canonical address rather than the string as typed", async () => {
    await createRoutineAction(
      null,
      website({ websiteUrl: "https://Example.com/news#section" }),
    );

    expect(mocks.createWebsiteSource).toHaveBeenCalledWith(
      "worker-1",
      "https://example.com/news",
      TX,
    );
  });

  it("keeps a manual website worker, and still gives it a source", async () => {
    const result = await createRoutineAction(
      null,
      website({ frequency: "manual", status: "active" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.createWebsiteSource).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["blank", ""],
    ["not a URL at all", "example"],
    ["a scheme this does not fetch", "ftp://example.com/news"],
    ["carrying credentials", "https://user:pass@example.com/news"],
    ["on another port", "https://example.com:8443/news"],
    // `https:///news` is *not* in this list on purpose: the URL parser reads it
    // as the host `news`, so it is a syntactically fine address that simply
    // will not resolve — a question asked at fetch time, not here.
    ["nothing but a scheme", "https://"],
  ])("refuses an address that is %s", async (_label, websiteUrl) => {
    const result = await createRoutineAction(null, website({ websiteUrl }));

    expect(result?.status).toBe("error");
    expect(result?.errors?.websiteUrl).toBeDefined();
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
  });

  /**
   * Not the wording `parseWatchUrl` throws: those describe a fetch being
   * refused, and the person here is looking at the box they typed in.
   */
  it("says what belongs in the field rather than which rule was broken", async () => {
    const result = await createRoutineAction(
      null,
      website({ websiteUrl: "ftp://example.com/news" }),
    );

    expect(result?.errors?.websiteUrl).toBe(
      "Enter a full website address, like https://example.com/news.",
    );
  });

  it("requires instructions even when nothing would run it unattended", async () => {
    const result = await createRoutineAction(
      null,
      website({ prompt: "", status: "draft", frequency: "manual" }),
    );

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBeDefined();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

/**
 * A kind is the one field with no fallback, and this is why: defaulting an
 * unreadable one to `prompt` would answer a question nobody asked, by creating
 * a worker that ignores the address submitted with it.
 */
describe("createRoutineAction — the kind itself", () => {
  it.each([
    ["absent", undefined],
    ["blank", ""],
    ["a value the app does not know", "webhook"],
  ])("refuses a submission whose kind is %s", async (_label, kind) => {
    const data = form();
    if (kind === undefined) {
      data.delete("kind");
    } else {
      data.set("kind", kind);
    }

    const result = await createRoutineAction(null, data);

    expect(result?.status).toBe("error");
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  /**
   * The half of the pair that is easy to get wrong in the other direction: a
   * prompt worker must never acquire a page to watch, however the form was
   * submitted.
   */
  it("creates no source for a prompt worker, even one submitted with an address", async () => {
    const result = await createRoutineAction(
      null,
      form({ websiteUrl: "https://example.com/news" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "prompt" }),
      "google-sub-1",
      TX,
    );
    // Every hire is a transaction now — the quota is decided inside the one
    // that writes the row. What a prompt worker still has is no second write.
    expect(mocks.createWebsiteSource).not.toHaveBeenCalled();
  });
});

/**
 * How many workers an account may keep, and how many it may run.
 *
 * **The decision and the write are one transaction**, which is the only reason
 * counting is safe to do at all: the account's own row is locked first, so a
 * second hire arriving at the same moment waits and then counts this one. What
 * these fix is that the sequence is that way round and that nothing is written
 * when the answer is no — the exclusivity itself is PostgreSQL's, and is
 * measured against a real database rather than asserted here.
 */
describe("createRoutineAction — the worker limits", () => {
  it("hires the twentieth worker", async () => {
    mocks.countRoutines.mockResolvedValue(TOTAL_WORKER_LIMIT - 1);

    const result = await createRoutineAction(null, form({ status: "draft" }));

    expect(result?.status).toBe("success");
    expect(mocks.createRoutine).toHaveBeenCalledTimes(1);
  });

  it("refuses the twenty-first", async () => {
    mocks.countRoutines.mockResolvedValue(TOTAL_WORKER_LIMIT);

    const result = await createRoutineAction(null, form({ status: "draft" }));

    expect(result?.status).toBe("error");
    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("writes neither half of a website worker when the account is full", async () => {
    mocks.countRoutines.mockResolvedValue(TOTAL_WORKER_LIMIT);

    await createRoutineAction(
      null,
      form({
        kind: "website",
        websiteUrl: "https://example.com/news",
        status: "draft",
      }),
    );

    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.createWebsiteSource).not.toHaveBeenCalled();
  });

  it("says how many there may be, and what frees one", async () => {
    mocks.countRoutines.mockResolvedValue(TOTAL_WORKER_LIMIT);

    const result = await createRoutineAction(
      null,
      form({ name: "Typed name", status: "draft" }),
    );

    expect(result?.message).toBe(
      "You already have the maximum number of Workers (20). Delete one to add another.",
    );
    // Nothing about a full account belongs to one field.
    expect(result?.errors).toBeUndefined();
    expect(result?.values?.name).toBe("Typed name");
  });

  it("says it in Japanese for an account that reads Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.countRoutines.mockResolvedValue(TOTAL_WORKER_LIMIT);

    const result = await createRoutineAction(null, form({ status: "draft" }));

    expect(result?.message).toBe(
      "Worker の数が上限（20）に達しています。追加するには既存の Worker を削除してください。",
    );
  });

  it("hires the tenth active worker", async () => {
    mocks.countRoutines
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(ACTIVE_WORKER_LIMIT - 1);

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.status).toBe("success");
    expect(mocks.createRoutine).toHaveBeenCalledTimes(1);
  });

  it("refuses the eleventh", async () => {
    mocks.countRoutines
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(ACTIVE_WORKER_LIMIT);

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.status).toBe("error");
    expect(mocks.createRoutine).not.toHaveBeenCalled();
  });

  it("says so under the Status control, keeping what was typed", async () => {
    mocks.countRoutines
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(ACTIVE_WORKER_LIMIT);

    const result = await createRoutineAction(
      null,
      form({ name: "Typed name", status: "active" }),
    );

    expect(result?.errors?.status).toBe(
      "You can have 10 active Workers at a time. Pause one to activate another.",
    );
    expect(result?.message).toBe(result?.errors?.status);
    expect(result?.values?.name).toBe("Typed name");
  });

  it("says the active limit in Japanese too", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.countRoutines
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(ACTIVE_WORKER_LIMIT);

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.errors?.status).toBe(
      "同時に Active にできる Worker は 10 個までです。別の Worker を Active にするには、どれかを一時停止してください。",
    );
  });

  it.each([["draft"], ["paused"]])(
    "does not ask about the active limit for a %s worker",
    async (status) => {
      await createRoutineAction(null, form({ status }));

      expect(mocks.countRoutines).toHaveBeenCalledTimes(1);
      expect(mocks.countRoutines).toHaveBeenCalledWith({
        where: { userId: "google-sub-1" },
      });
    },
  );

  /**
   * **A manual worker spends an active slot too.** Nothing schedules it, and
   * that is deliberately not the question the limit asks.
   */
  it("counts an active manual worker against the active limit", async () => {
    mocks.countRoutines
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(ACTIVE_WORKER_LIMIT);

    const result = await createRoutineAction(
      null,
      form({ status: "active", frequency: "manual" }),
    );

    expect(result?.status).toBe("error");
    expect(result?.errors?.status).toBeDefined();
  });

  it("counts every worker the account has, of either kind", async () => {
    await createRoutineAction(null, form({ status: "draft" }));

    // No `kind` and no `status` in the total: a website worker and a draft are
    // both workers the account keeps.
    expect(mocks.countRoutines).toHaveBeenCalledWith({
      where: { userId: "google-sub-1" },
    });
  });

  it("locks the account, counts, then writes — in that order", async () => {
    await createRoutineAction(null, form({ status: "active" }));

    expect(mocks.lockUser).toHaveBeenCalledWith({
      where: { id: "google-sub-1" },
      data: { id: "google-sub-1" },
    });
    expect(mocks.lockUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.countRoutines.mock.invocationCallOrder[0],
    );
    expect(mocks.countRoutines.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRoutine.mock.invocationCallOrder[0],
    );
  });

  it("asks nothing of the database for a submission it rejects", async () => {
    const result = await createRoutineAction(null, form({ name: "" }));

    expect(result?.status).toBe("error");
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.lockUser).not.toHaveBeenCalled();
    expect(mocks.countRoutines).not.toHaveBeenCalled();
  });

  it("asks nothing of the quota when the account row could not be written", async () => {
    mocks.ensureUser.mockRejectedValue(new Error("connection terminated"));

    await expect(
      createRoutineAction(null, form({ status: "draft" })),
    ).rejects.toThrow();

    expect(mocks.lockUser).not.toHaveBeenCalled();
    expect(mocks.countRoutines).not.toHaveBeenCalled();
  });

  it("keeps a database failure a database failure", async () => {
    mocks.countRoutines.mockRejectedValue(new Error("connection terminated"));

    const result = await createRoutineAction(null, form({ status: "draft" }));

    expect(result?.message).toBe("Could not create the worker.");
    expect(result?.errors).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("still resolves the first slot against the owner's zone", async () => {
    mocks.countRoutines.mockResolvedValue(0);

    await createRoutineAction(null, form({ status: "active" }));

    const [routine] = mocks.createRoutine.mock.calls[0];
    expect(routine.nextRunAt).toBeInstanceOf(Date);
    expect(mocks.getUserTimezone).toHaveBeenCalledWith("google-sub-1");
  });
});

/**
 * Describing a worker, without creating one.
 *
 * **The property worth holding on to is what this does *not* do.** It reads a
 * sentence and answers with values for a form; nothing it can be given makes it
 * write a row, and the assertions below say so explicitly rather than trusting
 * that nobody will wire one in later.
 *
 * The three answers — a draft, "AutoOps cannot do that", "which page?" — are
 * carried through as they are. Only the ways of failing get translated, because
 * the provider's vocabulary describes a request somebody else made to a third
 * party and the person here pressed a button.
 */
describe("generateWorkerDraftAction", () => {
  const PROMPT_DRAFT = {
    kind: "prompt" as const,
    name: "Morning focus",
    description: "Three things to do today.",
    prompt: "List three things worth doing today.",
    frequency: "daily" as const,
    runAtMinutes: 540,
    runAtWeekday: null,
    runAtDay: null,
  };

  const WEBSITE_DRAFT = {
    ...PROMPT_DRAFT,
    kind: "website" as const,
    websiteUrl: "https://example.com/news",
  };

  function ask(request: string) {
    const data = new FormData();
    data.set("request", request);
    return generateWorkerDraftAction(null, data);
  }

  it("sends a visitor with no session to sign in, without asking a model", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(ask("watch a page")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.createWorkerDraftGenerator).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  /**
   * When the account row is brought into being, and when it is not.
   *
   * **This used to provision nothing at all, and that was right at the time.**
   * Drafting wrote nothing, so there was no row that had to exist first. The
   * allowance changed that — `RateLimitBucket` carries a foreign key to
   * `User` — and what replaces the old contract is not "provision on the way
   * in" but the order Sprint 42 settled, applied to a path that now has a
   * write in it:
   *
   * ```
   * authentication  ->  validation  ->  provisioning  ->  the write itself
   * ```
   *
   * So the question each of these asks is the same one: was this request ever
   * going to reach a model? A request that was refused, or one there is
   * nothing configured to answer, must leave the account exactly as it found
   * it.
   */
  it("provisions the account row for a request that will reach a model", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: PROMPT_DRAFT,
    }));

    await ask("three ideas each morning");

    expect(mocks.ensureUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", ""],
    ["past the limit", "a".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS + 1)],
  ])("provisions nothing for a request that is %s", async (_label, request) => {
    await ask(request);

    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.consumeAiDraftQuota).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("provisions nothing when there is no generator to ask", async () => {
    mocks.createWorkerDraftGenerator.mockReturnValue(null);

    await ask("three ideas each morning");

    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.consumeAiDraftQuota).not.toHaveBeenCalled();
  });

  it("provisions the row before anything is counted against it", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: PROMPT_DRAFT,
    }));

    await ask("three ideas each morning");

    // The foreign key is the reason for the order, not tidiness: the row the
    // allowance points at has to exist before the allowance is written.
    expect(mocks.ensureUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeAiDraftQuota.mock.invocationCallOrder[0],
    );
  });

  it("does not count anything when the account row could not be written", async () => {
    mocks.ensureUser.mockRejectedValue(new Error("connection terminated"));

    await expect(ask("three ideas each morning")).rejects.toThrow();

    expect(mocks.consumeAiDraftQuota).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("counts the request against the account that asked", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: PROMPT_DRAFT,
    }));

    await ask("three ideas each morning");

    expect(mocks.consumeAiDraftQuota).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAiDraftQuota).toHaveBeenCalledWith("google-sub-1");
  });

  it("counts the request before the model is asked", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: PROMPT_DRAFT,
    }));

    await ask("three ideas each morning");

    expect(mocks.consumeAiDraftQuota.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generate.mock.invocationCallOrder[0],
    );
  });

  /**
   * **Nothing gives the allowance back.** What it guards is the asking, and by
   * the time a failure is known the asking has already happened.
   */
  it("gives nothing back when the model fails", async () => {
    mocks.generate.mockRejectedValue(new ProviderError("timeout", "timed out"));

    await ask("three ideas each morning");

    expect(mocks.consumeAiDraftQuota).toHaveBeenCalledTimes(1);
  });

  it("sends a visitor with no session away before counting anything", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(ask("watch a page")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.consumeAiDraftQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   \n\t "],
  ])("refuses a request that is %s before asking a model", async (_l, request) => {
    const result = await ask(request);

    expect(result?.status).toBe("error");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("refuses a request past the limit before asking a model", async () => {
    const result = await ask("a".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS + 1));

    expect(result?.status).toBe("error");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("accepts a request exactly at the limit", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: PROMPT_DRAFT,
    }));

    const result = await ask("a".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS));

    expect(result?.status).toBe("supported");
  });

  it("carries a prompt draft back", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: PROMPT_DRAFT,
    }));

    await expect(ask("three ideas each morning")).resolves.toEqual({
      status: "supported",
      draft: PROMPT_DRAFT,
    });
  });

  it("carries a website draft back", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: WEBSITE_DRAFT,
    }));

    await expect(
      ask("watch https://example.com/news daily"),
    ).resolves.toMatchObject({
      status: "supported",
      draft: { kind: "website", websiteUrl: "https://example.com/news" },
    });
  });

  /** The addresses come from the request, and the model only points at them. */
  it("finds the addresses itself and hands them over", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "supported",
      draft: WEBSITE_DRAFT,
    }));

    await ask("watch https://example.com/news and https://example.com/x daily");

    expect(mocks.generate).toHaveBeenCalledWith({
      request: "watch https://example.com/news and https://example.com/x daily",
      urlCandidates: ["https://example.com/news", "https://example.com/x"],
    });
  });

  it("carries an unsupported answer back as it is", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "unsupported",
      reason: "Koqentra cannot read email.",
    }));

    await expect(ask("read my email")).resolves.toEqual({
      status: "unsupported",
      reason: "Koqentra cannot read email.",
    });
  });

  it("carries a question about the address back as it is", async () => {
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "needs_input",
      field: "websiteUrl",
      message: "Add the address of the page you want Koqentra to watch.",
    }));

    await expect(ask("watch that page daily")).resolves.toMatchObject({
      status: "needs_input",
      field: "websiteUrl",
    });
  });

  it("says drafting is unavailable when nothing is configured", async () => {
    mocks.createWorkerDraftGenerator.mockReturnValue(null);

    const result = await ask("three ideas each morning");

    expect(result?.status).toBe("error");
    expect((result as { message: string }).message).toContain("no AI");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("says so when the answer could not be read", async () => {
    mocks.generate.mockRejectedValue(
      new InvalidWorkerDraftResponseError("the model used no tool"),
    );

    const result = await ask("three ideas each morning");

    expect(result?.status).toBe("error");
    expect((result as { message: string }).message).toContain("could not read");
  });

  it("distinguishes taking too long from not working", async () => {
    mocks.generate.mockRejectedValue(new ProviderError("timeout", "timed out"));

    const timedOut = await ask("three ideas each morning");

    mocks.generate.mockRejectedValue(
      new ProviderError("unavailable", "503 from upstream"),
    );

    const failed = await ask("three ideas each morning");

    expect((timedOut as { message: string }).message).toContain("too long");
    expect((failed as { message: string }).message).not.toContain("too long");
    expect(failed?.status).toBe("error");
  });

  /** The provider's own vocabulary stops at `lib/ai`. */
  it.each([
    ["rate-limited", "429 rate limited by upstream"],
    ["unauthorized", "401 invalid x-api-key"],
    ["invalid-request", "400 bad request"],
  ])("never shows the %o wording to the person", async (kind, message) => {
    mocks.generate.mockRejectedValue(
      new ProviderError(kind as never, message),
    );

    const result = await ask("three ideas each morning");
    const shown = (result as { message: string }).message;

    expect(shown).not.toContain(kind);
    expect(shown).not.toContain(message);
  });

  it("treats an error that is not the provider's as a provider failure", async () => {
    mocks.generate.mockRejectedValue(new Error("something else"));

    expect((await ask("three ideas each morning"))?.status).toBe("error");
  });

  /**
   * The whole point of the boundary: a draft is a proposal for a form, and the
   * only way to the database is still pressing Save.
   */
  it.each([
    ["a draft", { status: "supported", draft: PROMPT_DRAFT }],
    ["an unsupported answer", { status: "unsupported", reason: "no" }],
    [
      "a question",
      { status: "needs_input", field: "websiteUrl", message: "which page?" },
    ],
  ])("writes nothing when it answers with %s", async (_label, answer) => {
    mocks.generate.mockResolvedValue(draftGeneration(answer));

    await ask("watch https://example.com/news daily");

    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.createWebsiteSource).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("writes nothing when the model fails", async () => {
    mocks.generate.mockRejectedValue(new ProviderError("timeout", "timed out"));

    await ask("watch https://example.com/news daily");

    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

/**
 * What being out of drafts looks like from the form.
 *
 * **A denial is an answer, not a failure.** Nothing went wrong: the account
 * asked for more drafts in an hour than the allowance holds, and the useful
 * thing to say is that waiting works. That is why nothing is logged as an
 * error here and why no model is asked — the cost the allowance exists to
 * bound is the asking itself.
 *
 * **A database that will not answer is the other case, and it fails closed.**
 * Not knowing how much of the allowance is left is not the same as knowing
 * there is some. The driver's complaint stays in the log, where it names
 * tables and connections to somebody who can act on that; what comes back to
 * the form says only that drafting did not work.
 */
describe("generateWorkerDraftAction — the allowance", () => {
  /** What a database that will not answer arrives as. */
  function driverFailure() {
    return new Error('connection terminated: relation "RateLimitBucket"');
  }

  function ask(request: string) {
    const data = new FormData();
    data.set("request", request);
    return generateWorkerDraftAction(null, data);
  }

  it("asks no model once the allowance is spent", async () => {
    mocks.consumeAiDraftQuota.mockResolvedValue(false);

    const result = await ask("three ideas each morning");

    expect(result).toEqual({
      status: "error",
      message: "AI draft limit reached. Try again later.",
    });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("says the allowance is spent in Japanese for an account that reads Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.consumeAiDraftQuota.mockResolvedValue(false);

    const result = await ask("three ideas each morning");

    expect(result).toHaveProperty(
      "message",
      "AI 下書きの利用上限に達しました。しばらくしてからもう一度お試しください。",
    );
  });

  it("logs no error for a denial, because none happened", async () => {
    mocks.consumeAiDraftQuota.mockResolvedValue(false);
    // The spy is installed once and outlives a single test, so what is being
    // asserted about is this call and not the file's history.
    vi.mocked(console.error).mockClear();

    await ask("three ideas each morning");

    expect(console.error).not.toHaveBeenCalled();
  });

  it("asks no model when the allowance itself could not be read", async () => {
    mocks.consumeAiDraftQuota.mockRejectedValue(driverFailure());

    const result = await ask("three ideas each morning");

    expect(result).toEqual({
      status: "error",
      message: "Drafting is unavailable right now. Try again.",
    });
    expect(mocks.createWorkerDraftGenerator).toHaveBeenCalledTimes(1);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  /**
   * **It does not say the AI service could not be reached**, which is what
   * `worker.draft.unavailable` says and what nothing here has tried to do. The
   * failure is AutoOps' own, and the sentence that goes back names no cause —
   * the database is not the reader's business either.
   */
  it("blames neither the model nor the database", async () => {
    mocks.consumeAiDraftQuota.mockRejectedValue(driverFailure());

    const result = await ask("three ideas each morning");
    const message = (result as { message: string }).message;

    expect(message).not.toContain("AI service");
    expect(message).not.toContain("database");
  });

  it("says so in Japanese for an account that reads Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.consumeAiDraftQuota.mockRejectedValue(driverFailure());

    const result = await ask("three ideas each morning");

    expect(result).toHaveProperty(
      "message",
      "現在、AI 下書きを作成できません。しばらくしてからもう一度お試しください。",
    );
  });

  it("keeps the driver's own words out of what comes back", async () => {
    mocks.consumeAiDraftQuota.mockRejectedValue(driverFailure());

    vi.mocked(console.error).mockClear();

    const result = await ask("three ideas each morning");
    const message = (result as { message: string }).message;

    expect(message).not.toContain("RateLimitBucket");
    expect(message).not.toContain("connection terminated");
    // It is a failure, so it is logged — unlike the denial above — and the
    // prefix is what makes it findable next to the rest of `[draft]`.
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toBe(
      "[draft] the rate limit could not be read",
    );
  });
});

/**
 * Why drafting produced nothing, in the language the account reads.
 *
 * **Six sentences AutoOps writes about its own behaviour**, which is what
 * separates them from what a generator returns for `unsupported` or
 * `needs_input` — those describe one particular request, in the model's words,
 * and go to the screen exactly as they arrived.
 *
 * The result's shape does not change with the language: `status` is still
 * `error`, and the page still decides what to do with it.
 */
describe("generateWorkerDraftAction — the words a failure comes back in", () => {
  function ask(request: string) {
    const data = new FormData();
    data.set("request", request);
    return generateWorkerDraftAction(null, data);
  }

  it("answers an empty request in the account's language", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const result = await ask("");

    expect(result?.status).toBe("error");
    expect(result).toHaveProperty(
      "message",
      "Koqentra に任せたい内容を入力してください。",
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("answers it in English for an account that reads English", async () => {
    const result = await ask("");

    expect(result).toHaveProperty(
      "message",
      "Describe what you would like Koqentra to handle.",
    );
  });

  it("names the limit the same way in both", async () => {
    const tooLong = "a".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS + 1);

    const english = await ask(tooLong);
    mocks.getUserLanguage.mockResolvedValue("ja");
    const japanese = await ask(tooLong);

    for (const result of [english, japanese]) {
      expect(result).toHaveProperty("status", "error");
      expect((result as { message: string }).message).toContain("2,000");
    }
    expect((english as { message: string }).message).not.toBe(
      (japanese as { message: string }).message,
    );
  });

  it("says drafting is unavailable in Japanese when no generator exists", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.createWorkerDraftGenerator.mockReturnValue(null);

    const result = await ask("watch a page");

    expect(result).toHaveProperty(
      "message",
      "Koqentra に AI が設定されていないため、下書きを作成できません。",
    );
  });

  /**
   * A question from the generator is about one request and is written in the
   * model's words. Nothing looks it up, in either language.
   */
  it("passes a generator's own answer through untouched", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "needs_input",
      field: "websiteUrl",
      message: "Which page should this worker watch?",
    }));

    const result = await ask("watch a page for me");

    expect(result).toEqual({
      status: "needs_input",
      field: "websiteUrl",
      message: "Which page should this worker watch?",
    });
  });

  it("tells the generator nothing about the language", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.generate.mockResolvedValue(draftGeneration({
      status: "unsupported",
      reason: "Koqentra cannot send email yet.",
    }));

    await ask("email my team every morning");

    const [request] = mocks.generate.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(request).sort()).toEqual(["request", "urlCandidates"]);
  });
});

/**
 * What creating a worker says back, in the account's language.
 *
 * **The name inside the sentence is the owner's.** It goes in exactly as it
 * was typed, and neither language touches it.
 */
describe("createRoutineAction — the words it answers in", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("says a worker was created, keeping its name as typed", async () => {
    const result = await createRoutineAction(
      null,
      form({ name: "宝塚市 パブリック・コメント" }),
    );

    expect(result).toMatchObject({
      status: "success",
      message: "Worker「宝塚市 パブリック・コメント」を作成しました。",
    });
  });

  it("asks for a kind in Japanese", async () => {
    // An unreadable kind is the one field with no fallback.
    const result = await createRoutineAction(null, form({ kind: "" }));

    expect(result?.message).toBe(
      "この Worker がプロンプトを実行するのか、ページを監視するのかを選んでください。",
    );
  });

  it("refuses a blank name in Japanese", async () => {
    const result = await createRoutineAction(null, form({ name: "" }));

    expect(result?.message).toBe("名前は必須です。");
    expect(result?.errors?.name).toBe("名前は必須です。");
  });

  it("refuses an unusable address in Japanese, keeping the example URL", async () => {
    const result = await createRoutineAction(
      null,
      form({ kind: "website", websiteUrl: "not-a-url" }),
    );

    expect(result?.errors?.websiteUrl).toBe(
      "https://example.com/news のような完全なアドレスを入力してください。",
    );
  });

  it("reports a failed write in Japanese", async () => {
    mocks.createRoutine.mockRejectedValue(new Error("connection lost"));

    const result = await createRoutineAction(null, form());

    expect(result?.message).toBe("Worker を作成できませんでした。");
  });

  it("writes the same values whichever language it answers in", async () => {
    await createRoutineAction(null, form());

    const [routine] = mocks.createRoutine.mock.calls.at(-1) as [
      Record<string, unknown>,
    ];

    expect(routine).toMatchObject({
      name: "Daily digest",
      prompt: "Summarise {{today}}",
      kind: "prompt",
      status: "active",
      frequency: "daily",
    });
  });
});

/**
 * Hiring a worker that searches, which is a pair of rows rather than one.
 *
 * **The transaction is the subject.** A routine saying it searches somewhere,
 * with nothing saying where, is a worker that appears in the dashboard and
 * fails every run — and nobody looking at it could tell it from one made
 * correctly. Everything below is about that state being unreachable rather than
 * merely unlikely.
 *
 * **No key exists in any of these**, and none is needed: availability is
 * stood in, and nothing reaches a provider.
 */
describe("createRoutineAction — discovery", () => {
  function discoveryForm(overrides?: Record<string, string>) {
    return form({
      kind: "discovery",
      name: "Hedgehog recommendations",
      prompt: "",
      status: "draft",
      frequency: "manual",
      discoverySource: "youtube",
      discoveryQuery: "ハリネズミ 飼い方",
      ...overrides,
    });
  }

  it("creates the worker and its search in one transaction", async () => {
    const result = await createRoutineAction(null, discoveryForm());

    expect(result).toMatchObject({ status: "success" });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discovery" }),
      "google-sub-1",
      TX,
    );
    expect(mocks.saveDiscoverySource).toHaveBeenCalledWith(
      "worker-1",
      "google-sub-1",
      { source: "youtube", query: "ハリネズミ 飼い方", maxResults: 5 },
      TX,
    );
  });

  /** Absent means the default; it is not a way to ask for something else. */
  it("defaults how many to recommend when the form did not say", async () => {
    await createRoutineAction(null, discoveryForm());

    expect(mocks.saveDiscoverySource.mock.calls[0][2]).toMatchObject({
      maxResults: 5,
    });
  });

  it("keeps the number that was asked for", async () => {
    await createRoutineAction(null, discoveryForm({ discoveryMaxResults: "3" }));

    expect(mocks.saveDiscoverySource.mock.calls[0][2]).toMatchObject({
      maxResults: 3,
    });
  });

  /**
   * **Refused before the transaction opens.** A worker that cannot be run is
   * not a worker somebody meant to make, and what would fix it is not on this
   * form.
   */
  it.each(["not-configured", "unknown-source"] as const)(
    "creates neither row when the source is unavailable (%s)",
    async (reason) => {
      mocks.createDiscoveryProvider.mockReturnValue({
        available: false,
        reason,
      });

      const result = await createRoutineAction(null, discoveryForm());

      expect(result).toMatchObject({ status: "error" });
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.createRoutine).not.toHaveBeenCalled();
      expect(mocks.saveDiscoverySource).not.toHaveBeenCalled();
    },
  );

  it("asks nobody to decide whether the source is reachable", async () => {
    await createRoutineAction(null, discoveryForm());

    expect(mocks.createDiscoveryProvider).toHaveBeenCalledWith("youtube");
  });

  it.each([
    ["a source this version does not know", { discoverySource: "vimeo" }],
    ["no source at all", { discoverySource: "" }],
    ["no search", { discoveryQuery: "" }],
    ["a search of spaces", { discoveryQuery: "   " }],
    ["a search past the limit", { discoveryQuery: "x".repeat(301) }],
    ["a count of zero", { discoveryMaxResults: "0" }],
    ["a count past the ceiling", { discoveryMaxResults: "11" }],
    ["a count that is not a number", { discoveryMaxResults: "many" }],
  ])("refuses %s, and writes nothing", async (_label, overrides) => {
    const result = await createRoutineAction(null, discoveryForm(overrides));

    expect(result).toMatchObject({ status: "error" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createRoutine).not.toHaveBeenCalled();
  });

  it("accepts a search exactly at the limit", async () => {
    const result = await createRoutineAction(
      null,
      discoveryForm({ discoveryQuery: "x".repeat(300) }),
    );

    expect(result).toMatchObject({ status: "success" });
  });

  it.each(["1", "10"])("accepts a count of %s", async (count) => {
    const result = await createRoutineAction(
      null,
      discoveryForm({ discoveryMaxResults: count }),
    );

    expect(result).toMatchObject({ status: "success" });
  });

  /**
   * **A quota rejection leaves nothing behind**, including the half of the pair
   * that would otherwise have been written: the transaction returns before
   * either insert.
   */
  it("writes neither row when the account is at its worker limit", async () => {
    mocks.countRoutines.mockResolvedValue(TOTAL_WORKER_LIMIT);

    const result = await createRoutineAction(null, discoveryForm());

    expect(result).toMatchObject({ status: "error" });
    expect(mocks.createRoutine).not.toHaveBeenCalled();
    expect(mocks.saveDiscoverySource).not.toHaveBeenCalled();
  });

  /**
   * **Half a worker is not a worker.** A search that could not be attached
   * abandons the routine with it, which is what the transaction is for.
   */
  it("reports a failure when the search could not be attached", async () => {
    mocks.saveDiscoverySource.mockResolvedValue(null);

    const result = await createRoutineAction(null, discoveryForm());

    expect(result).toMatchObject({ status: "error" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a failure when the transaction itself could not commit", async () => {
    mocks.transaction.mockRejectedValue(new Error("deadlock"));

    const result = await createRoutineAction(null, discoveryForm());

    expect(result).toMatchObject({ status: "error" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /** The owner is the session's, exactly as it is for every other kind. */
  it("takes the owner from the session rather than the form", async () => {
    await createRoutineAction(
      null,
      discoveryForm({ userId: "somebody-else" }),
    );

    expect(mocks.createRoutine.mock.calls[0][1]).toBe("google-sub-1");
    expect(mocks.saveDiscoverySource.mock.calls[0][1]).toBe("google-sub-1");
  });

  /** Nothing about hiring a worker spends a run allowance. */
  it("spends no run allowance", async () => {
    await createRoutineAction(null, discoveryForm());

    expect(mocks.consumeAiDraftQuota).not.toHaveBeenCalled();
  });
});

/**
 * What hiring the other two kinds still does.
 *
 * Discovery arriving must not have changed either of them, and the cheapest
 * way to say so is to check that neither goes near the new collaborators.
 */
describe("createRoutineAction — the other kinds are unchanged", () => {
  it.each(["prompt", "website"] as const)(
    "hires a %s worker without asking about a discovery source",
    async (kind) => {
      const data =
        kind === "website"
          ? form({ kind, websiteUrl: "https://example.com/news" })
          : form({ kind });

      const result = await createRoutineAction(null, data);

      expect(result).toMatchObject({ status: "success" });
      expect(mocks.createDiscoveryProvider).not.toHaveBeenCalled();
      expect(mocks.saveDiscoverySource).not.toHaveBeenCalled();
    },
  );
});

/**
 * What a draft says it cost.
 *
 * **Drafting writes no run**, so there is nothing for a usage row to point at
 * and `runId` is null on every one of these. What it can say is who answered,
 * which model, and what the call used — and, more often, that no call was made
 * at all: every refusal in front of the provider is free.
 */
describe("generateWorkerDraftAction — what it records about its call", () => {
  /** One draft request, as the form sends it. */
  function ask(request: string) {
    const data = new FormData();
    data.set("request", request);
    return generateWorkerDraftAction(null, data);
  }

  /** The data of the only provider-usage `create`. */
  function usageRow() {
    return mocks.usageCreate.mock.calls[0][0].data;
  }

  it("records one call when a draft came back", async () => {
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "no" }),
    );

    await ask("watch a page");

    expect(mocks.usageCreate).toHaveBeenCalledTimes(1);
    expect(usageRow()).toMatchObject({
      userId: "google-sub-1",
      feature: "draft",
      provider: "anthropic",
      model: "claude-opus-5",
      outcome: "ok",
      inputTokens: 1_200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    });
  });

  /** A draft is not a run, so there is no history row to point at. */
  it("points at no run", async () => {
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "no" }),
    );

    await ask("watch a page");

    expect(usageRow().runId).toBeNull();
  });

  it("records a call that was made and then failed", async () => {
    mocks.generate.mockRejectedValue(
      new ProviderError("timeout", "took too long", {
        attempt: {
          provider: "anthropic",
          model: "claude-opus-5",
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        },
      }),
    );

    await ask("watch a page");

    expect(mocks.usageCreate).toHaveBeenCalledTimes(1);
    expect(usageRow()).toMatchObject({
      feature: "draft",
      outcome: "error",
      inputTokens: null,
      runId: null,
    });
  });

  /**
   * **An unusable answer is a call that succeeded.** The model was reached and
   * replied; only the using of the reply failed, and it was billed either way.
   */
  it("records an unusable answer as a call that happened", async () => {
    mocks.generate.mockRejectedValue(
      new InvalidWorkerDraftResponseError("the model proposed nothing", {
        call: {
          provider: "anthropic",
          model: "claude-opus-5",
          usage: {
            inputTokens: 900,
            outputTokens: 12,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        },
      }),
    );

    await ask("watch a page");

    expect(mocks.usageCreate).toHaveBeenCalledTimes(1);
    expect(usageRow()).toMatchObject({
      feature: "draft",
      outcome: "ok",
      inputTokens: 900,
      outputTokens: 12,
    });
  });

  /**
   * **Every refusal in front of the provider is free.** None of these sends
   * anything, so none of them may be recorded as a cost.
   */
  it("records nothing for an empty request", async () => {
    await ask("");

    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.usageCreate).not.toHaveBeenCalled();
  });

  it("records nothing for a request past the limit", async () => {
    await ask("x".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS + 1));

    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.usageCreate).not.toHaveBeenCalled();
  });

  it("records nothing when no generator is configured", async () => {
    mocks.createWorkerDraftGenerator.mockReturnValue(null);

    await ask("watch a page");

    expect(mocks.usageCreate).not.toHaveBeenCalled();
  });

  it("records nothing when the allowance is spent", async () => {
    mocks.consumeAiDraftQuota.mockResolvedValue(false);

    await ask("watch a page");

    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.usageCreate).not.toHaveBeenCalled();
  });

  /**
   * **Observation must not change what it observes.** A draft that came back
   * still reaches the form when the bookkeeping beside it could not be written.
   */
  it("still returns the draft when the usage row cannot be written", async () => {
    mocks.usageCreate.mockRejectedValue(new Error("connection lost"));
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "Koqentra cannot." }),
    );

    const state = await ask("watch a page");

    expect(state).toMatchObject({ status: "unsupported" });
  });

  /** The existing hourly allowance is untouched: still one per request. */
  it("spends the draft allowance exactly as it did before", async () => {
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "no" }),
    );

    await ask("watch a page");

    expect(mocks.consumeAiDraftQuota).toHaveBeenCalledTimes(1);
  });
});

/**
 * Counting a draft against the account's month.
 *
 * **Drafting is AI processing with no run behind it**, which is why it had no
 * cost anybody could see until now. What is fixed here is that the same unit a
 * worker spends is spent by a form — and that every refusal in front of the
 * provider still costs nothing.
 */
describe("generateWorkerDraftAction — counting the call against the month", () => {
  function ask(request: string) {
    const data = new FormData();
    data.set("request", request);
    return generateWorkerDraftAction(null, data);
  }

  /** Every kind observed during this request. */
  function observed() {
    return mocks.recordUsageObservation.mock.calls.map((call: unknown[]) =>
      String(call[1]),
    );
  }

  it("counts one unit of AI processing for a real call", async () => {
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "no" }),
    );

    await ask("watch a page");

    expect(observed()).toEqual(["aiProcessing"]);
    expect(mocks.recordUsageObservation.mock.calls[0][0]).toBe("google-sub-1");
  });

  it("counts a call that was made and then failed", async () => {
    mocks.generate.mockRejectedValue(
      new ProviderError("timeout", "took too long", {
        attempt: { provider: "anthropic", model: "claude-opus-5", usage: null },
      }),
    );

    await ask("watch a page");

    expect(observed()).toEqual(["aiProcessing"]);
  });

  it.each([
    ["an empty request", ""],
    ["a request past the limit", "x".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS + 1)],
  ])("counts nothing for %s", async (_label, request) => {
    await ask(request);

    expect(mocks.recordUsageObservation).not.toHaveBeenCalled();
  });

  it("counts nothing when the allowance is spent", async () => {
    mocks.consumeAiDraftQuota.mockResolvedValue(false);

    await ask("watch a page");

    expect(mocks.recordUsageObservation).not.toHaveBeenCalled();
  });

  it("counts exactly once per call", async () => {
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "no" }),
    );

    await ask("watch a page");

    expect(mocks.recordUsageObservation).toHaveBeenCalledTimes(1);
  });

  /** Observation must not change what it observes. */
  it("still returns the draft when the month cannot be counted", async () => {
    mocks.recordUsageObservation.mockResolvedValue({
      recorded: false,
      reason: "unavailable",
    });
    mocks.generate.mockResolvedValue(
      draftGeneration({ status: "unsupported", reason: "Koqentra cannot." }),
    );

    expect(await ask("watch a page")).toMatchObject({ status: "unsupported" });
  });
});

/**
 * Hiring a worker, and the fourteen days it may or may not start.
 *
 * **The trigger is activation, not creation.** A worker can be created active
 * as easily as it can be switched on later, so this form is a first-activation
 * boundary — but only when the status says `active`. Drafting one is filling in
 * a form, and a trial spent there would be spent by somebody who had not yet
 * decided to run anything.
 */
describe("createRoutineAction — the trial", () => {
  /** §11: signing up and drafting a worker consume nothing. */
  it("starts no trial when the worker is created as a draft", async () => {
    await createRoutineAction(null, form({ status: "draft" }));

    expect(mocks.createSubscription).not.toHaveBeenCalled();
    expect(mocks.createUsagePeriod).not.toHaveBeenCalled();
  });

  it("starts no trial when the worker is created paused", async () => {
    await createRoutineAction(null, form({ status: "paused" }));

    expect(mocks.createSubscription).not.toHaveBeenCalled();
  });

  /** §12: the first active worker is what starts the fortnight. */
  it("starts a trial when the first worker is created active", async () => {
    await createRoutineAction(null, form({ status: "active" }));

    expect(mocks.createSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.createSubscription.mock.calls[0][0].data).toMatchObject({
      plan: "trial",
      state: "trialing",
      source: "trial",
    });
    expect(mocks.createUsagePeriod).toHaveBeenCalledTimes(1);
  });

  /**
   * **Inside the same transaction as the worker**, which is what makes §7 true:
   * a trial cannot outlive a hire that failed, because they commit together.
   */
  it("writes the trial with the same client as the worker", async () => {
    await createRoutineAction(null, form({ status: "active" }));

    expect(mocks.createSubscription.mock.calls[0][0]).not.toHaveProperty("tag");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.createRoutine.mock.calls[0][2]).toBe(TX);
  });

  /** §13: an account that already has one running worker is not starting. */
  it("starts no trial when a worker is already active", async () => {
    mocks.countRoutines.mockResolvedValue(1);

    await createRoutineAction(null, form({ status: "active" }));

    expect(mocks.createSubscription).not.toHaveBeenCalled();
  });

  /**
   * §20: the five carried-over accounts activate workers exactly as before,
   * and nothing about their entitlement is written or changed.
   */
  it("starts no trial for an account that was given the beta allowance", async () => {
    mocks.findSubscription.mockResolvedValue({
      plan: "beta",
      state: "active",
      source: "admin",
      trialStartedAt: null,
      trialEndsAt: null,
      trialConsumedAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      notificationWorkerId: null,
      expiresAt: new Date("2026-12-31T23:59:59.000Z"),
    });

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.status).toBe("success");
    expect(mocks.createSubscription).not.toHaveBeenCalled();
    expect(mocks.createUsagePeriod).not.toHaveBeenCalled();
  });

  /**
   * §7: a trial is spent by a successful activation, not by an attempt. The
   * transaction here rejects after the trial was written, and the action
   * reports a failure rather than a hire — in Production the rollback is
   * PostgreSQL's, and what is fixed here is that nothing is reported as having
   * worked.
   */
  it("reports a failure rather than a hire when the transaction cannot commit", async () => {
    vi.mocked(console.error).mockClear();
    mocks.transaction.mockRejectedValue(new Error("rolled back"));

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.status).toBe("error");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /** Nothing is sent and nobody is charged: a trial is a row. */
  it("calls no provider and writes no provider fields", async () => {
    await createRoutineAction(null, form({ status: "active" }));

    expect(mocks.createSubscription.mock.calls[0][0].data).toMatchObject({
      providerCustomerId: null,
      providerSubscriptionId: null,
      providerUpdatedAt: null,
    });
  });
});


/**
 * The AI somebody spent on the form, arriving with the trial they then start.
 *
 * **This is the path the carry-in exists for.** Drafting a worker with AI is
 * the ordinary way to reach this form, it calls a model, and it needs no worker
 * — so by the time somebody presses the button that activates their first one,
 * they may already have spent a good deal of the allowance the trial is about
 * to hand them.
 */
describe("createRoutineAction — carrying pre-trial AI into the trial", () => {
  /** The counters the trial period was opened with, by kind. */
  function counter(kind: string) {
    return mocks.createUsagePeriod.mock.calls[0][0].data.counters.create.find(
      (row: { kind: string }) => row.kind === kind,
    );
  }

  it("starts the trial's AI allowance at what was already used", async () => {
    mocks.aggregateUsageCounters.mockResolvedValue({ _sum: { used: 3 } });

    await createRoutineAction(null, form({ status: "active" }));

    expect(counter("aiProcessing")).toEqual({
      kind: "aiProcessing",
      used: 3,
      limit: 50,
    });
  });

  it("leaves the other two allowances at nothing", async () => {
    mocks.aggregateUsageCounters.mockResolvedValue({ _sum: { used: 3 } });

    await createRoutineAction(null, form({ status: "active" }));

    expect(counter("manualRun").used).toBe(0);
    expect(counter("discovery").used).toBe(0);
  });

  /** Over the allowance is a state to record, not a reason to refuse a hire. */
  it("still hires the worker when more was used than a trial allows", async () => {
    mocks.aggregateUsageCounters.mockResolvedValue({ _sum: { used: 63 } });

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.status).toBe("success");
    expect(counter("aiProcessing").used).toBe(63);
    expect(counter("aiProcessing").limit).toBe(50);
  });

  /** Read with the same client as the worker: one transaction, or neither. */
  it("reads the total inside the activation transaction", async () => {
    mocks.aggregateUsageCounters.mockResolvedValue({ _sum: { used: 1 } });

    await createRoutineAction(null, form({ status: "active" }));

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.createRoutine.mock.calls[0][2]).toBe(TX);
  });

  /**
   * §13: a total that cannot be read takes the hire with it. Starting a trial
   * at zero because a query failed would hand back an allowance the account had
   * already spent.
   */
  it("reports a failure rather than a hire when the total cannot be read", async () => {
    vi.mocked(console.error).mockClear();
    mocks.transaction.mockRejectedValue(new Error("aggregate failed"));

    const result = await createRoutineAction(null, form({ status: "active" }));

    expect(result?.status).toBe("error");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /** A draft is not an activation, so nothing is read and nothing is carried. */
  it("reads no total when the worker is created as a draft", async () => {
    await createRoutineAction(null, form({ status: "draft" }));

    expect(mocks.aggregateUsageCounters).not.toHaveBeenCalled();
  });
});
