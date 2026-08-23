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
  ensureUser: vi.fn(),
  getUserTimezone: vi.fn(),
  createRoutine: vi.fn(),
  createWebsiteSource: vi.fn(),
  transaction: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/users", () => ({
  ensureUser: mocks.ensureUser,
  getUserTimezone: mocks.getUserTimezone,
}));
vi.mock("@/lib/routines", () => ({ createRoutine: mocks.createRoutine }));
vi.mock("@/lib/website-sources", () => ({
  createWebsiteSource: mocks.createWebsiteSource,
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
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

const TX = { tag: "transaction-client" } as const;

const { createRoutineAction, generateWorkerDraftAction } = await import(
  "@/app/dashboard/new/actions"
);
const { ProviderError } = await import("@/lib/ai/provider");
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
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.createRoutine.mockReset().mockResolvedValue({ id: "worker-1" });
  mocks.createWebsiteSource.mockReset().mockResolvedValue({ id: "source-1" });
  mocks.transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(TX));
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
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createWebsiteSource).not.toHaveBeenCalled();
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
   * Provisioning is for writes that need the account row to exist. This writes
   * nothing, so asking for one would create a row because somebody pressed a
   * button and changed their mind.
   */
  it("does not provision the account row", async () => {
    mocks.generate.mockResolvedValue({
      status: "supported",
      draft: PROMPT_DRAFT,
    });

    await ask("three ideas each morning");

    expect(mocks.ensureUser).not.toHaveBeenCalled();
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
    mocks.generate.mockResolvedValue({
      status: "supported",
      draft: PROMPT_DRAFT,
    });

    const result = await ask("a".repeat(MAX_WORKER_DRAFT_REQUEST_CHARS));

    expect(result?.status).toBe("supported");
  });

  it("carries a prompt draft back", async () => {
    mocks.generate.mockResolvedValue({
      status: "supported",
      draft: PROMPT_DRAFT,
    });

    await expect(ask("three ideas each morning")).resolves.toEqual({
      status: "supported",
      draft: PROMPT_DRAFT,
    });
  });

  it("carries a website draft back", async () => {
    mocks.generate.mockResolvedValue({
      status: "supported",
      draft: WEBSITE_DRAFT,
    });

    await expect(
      ask("watch https://example.com/news daily"),
    ).resolves.toMatchObject({
      status: "supported",
      draft: { kind: "website", websiteUrl: "https://example.com/news" },
    });
  });

  /** The addresses come from the request, and the model only points at them. */
  it("finds the addresses itself and hands them over", async () => {
    mocks.generate.mockResolvedValue({
      status: "supported",
      draft: WEBSITE_DRAFT,
    });

    await ask("watch https://example.com/news and https://example.com/x daily");

    expect(mocks.generate).toHaveBeenCalledWith({
      request: "watch https://example.com/news and https://example.com/x daily",
      urlCandidates: ["https://example.com/news", "https://example.com/x"],
    });
  });

  it("carries an unsupported answer back as it is", async () => {
    mocks.generate.mockResolvedValue({
      status: "unsupported",
      reason: "AutoOps cannot read email.",
    });

    await expect(ask("read my email")).resolves.toEqual({
      status: "unsupported",
      reason: "AutoOps cannot read email.",
    });
  });

  it("carries a question about the address back as it is", async () => {
    mocks.generate.mockResolvedValue({
      status: "needs_input",
      field: "websiteUrl",
      message: "Add the address of the page you want AutoOps to watch.",
    });

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
    mocks.generate.mockResolvedValue(answer);

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
