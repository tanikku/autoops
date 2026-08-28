import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saving an edit, and the prompt contract it has to enforce.
 *
 * A worker left on a cadence with nothing to run is a state this action can
 * create and the hire form cannot, because the status may arrive by fallback
 * rather than in the submission — so the rule has to be asked about the value
 * that will be saved, not the one that was sent.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getRoutineForEdit: vi.fn(),
  updateRoutine: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  getWebsiteSource: vi.fn(),
  updateWebsiteSourceUrl: vi.fn(),
  deleteWebsiteSnapshot: vi.fn(),
  transaction: vi.fn(),
  lockUser: vi.fn(),
  countRoutines: vi.fn(),
  revalidatePath: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/routines", () => ({
  getRoutineForEdit: mocks.getRoutineForEdit,
  updateRoutine: mocks.updateRoutine,
}));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
  updateWebsiteSourceUrl: mocks.updateWebsiteSourceUrl,
}));
vi.mock("@/lib/website-snapshots", () => ({
  deleteWebsiteSnapshot: mocks.deleteWebsiteSnapshot,
}));
// The transaction is the boundary under test, so the fake runs the callback and
// hands it a marker: what the assertions want is that all three writes were
// given the *same* client, and that it was not the module's own.
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

/**
 * The client a transaction hands its callback.
 *
 * **It carries the two tables the account quota reads**, so the quota runs for
 * real rather than being stood in for: turning a worker on has to lock the
 * account, count what is already active, and write — all in the transaction
 * the marker identifies.
 */
const TX = {
  tag: "transaction-client",
  user: { update: mocks.lockUser },
  routine: { count: mocks.countRoutines },
} as const;

const { updateRoutineAction } = await import(
  "@/app/dashboard/workers/[id]/edit/actions"
);
// The limit itself belongs to the quota module; these read it rather than
// restating it, so raising it does not silently leave these testing nothing.
const { ACTIVE_WORKER_LIMIT } = await import("@/lib/worker-quota");

class RedirectSignal extends Error {}
class NotFoundSignal extends Error {}

/** The worker as it stands before the edit. */
function stored(overrides?: Record<string, unknown>) {
  return {
    id: "worker-1",
    userId: "google-sub-1",
    name: "Daily digest",
    description: "",
    prompt: "Summarise today's news.",
    kind: "prompt",
    status: "draft",
    frequency: "manual",
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    nextRunAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** What the form submits. Anything omitted here is omitted from the post. */
function form(fields: Record<string, string>) {
  const data = new FormData();
  data.set("name", "Daily digest");
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function save(data: FormData) {
  return updateRoutineAction("worker-1", null, data);
}

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({
    user: { id: "google-sub-1", email: "someone@example.com", name: null, image: null },
  });
  mocks.getRoutineForEdit.mockReset().mockResolvedValue(stored());
  mocks.updateRoutine.mockReset().mockResolvedValue(stored());
  mocks.getWebsiteSource.mockReset().mockResolvedValue(null);
  mocks.updateWebsiteSourceUrl.mockReset().mockResolvedValue(true);
  mocks.deleteWebsiteSnapshot.mockReset().mockResolvedValue(1);
  mocks.transaction
    .mockReset()
    .mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(TX));
  mocks.lockUser.mockReset().mockResolvedValue({ id: "google-sub-1" });
  // An account with room to turn another worker on, unless a test says so.
  mocks.countRoutines.mockReset().mockResolvedValue(0);
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
  // English by default, so the assertions above stay about what was saved
  // rather than about what it was called.
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.revalidatePath.mockReset();
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new NotFoundSignal();
  });
  mocks.redirect.mockReset().mockImplementation(() => {
    throw new RedirectSignal();
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * Turning a worker on, when the account has only so many it may run at once.
 *
 * **Only the transition asks.** A worker that is already active is part of the
 * count rather than an addition to it, so editing one must not be refused
 * because the account is full — it is what the account is full *of*. What has
 * to hold is that the answer and the write are the same transaction: a decision
 * committed on its own is a decision about a moment that has passed.
 *
 * The limit itself is fixed in `lib/worker-quota.test.ts`; what these fix is
 * which edits ask, and what an account at its limit is told.
 */
describe("updateRoutineAction — the active-worker limit", () => {
  /** A worker that is on, and one the account has yet to turn on. */
  const paused = () => stored({ status: "paused" });
  const draft = () => stored({ status: "draft" });

  it("turns a paused worker on when there is room", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT - 1);

    const result = await save(form({ status: "active", frequency: "manual" }));

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  it("refuses to turn one on when the account is at its limit", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    const result = await save(form({ status: "active", frequency: "manual" }));

    expect(result?.status).toBe("error");
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a draft the same way", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(draft());
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    expect(
      (await save(form({ status: "active", frequency: "manual" })))?.status,
    ).toBe("error");
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  it("says so under the Status control, keeping what was typed", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    const result = await save(
      form({ name: "Renamed", status: "active", frequency: "manual" }),
    );

    expect(result?.errors?.status).toBe(
      "You can have 10 active Workers at a time. Pause one to activate another.",
    );
    expect(result?.message).toBe(result?.errors?.status);
    expect(result?.values?.name).toBe("Renamed");
  });

  it("says it in Japanese for an account that reads Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.getRoutineForEdit.mockResolvedValue(paused());
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    const result = await save(form({ status: "active", frequency: "manual" }));

    expect(result?.errors?.status).toBe(
      "同時に Active にできる Worker は 10 個までです。別の Worker を Active にするには、どれかを一時停止してください。",
    );
  });

  it("counts only this account's active workers", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());

    await save(form({ status: "active", frequency: "manual" }));

    expect(mocks.countRoutines).toHaveBeenCalledWith({
      where: { userId: "google-sub-1", status: "active" },
    });
  });

  it("locks the account, counts, then writes — in that order", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());

    await save(form({ status: "active", frequency: "manual" }));

    expect(mocks.lockUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.countRoutines.mock.invocationCallOrder[0],
    );
    expect(mocks.countRoutines.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateRoutine.mock.invocationCallOrder[0],
    );
    // And all of it in the transaction the write belongs to.
    expect(mocks.updateRoutine).toHaveBeenCalledWith(
      "worker-1",
      expect.anything(),
      "google-sub-1",
      TX,
    );
  });

  it("asks nothing of the quota when editing a worker that is already on", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(stored({ status: "active" }));
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    const result = await save(
      form({ name: "Renamed", status: "active", frequency: "manual" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.lockUser).not.toHaveBeenCalled();
    expect(mocks.countRoutines).not.toHaveBeenCalled();
  });

  it("lets a full account turn a worker off", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(stored({ status: "active" }));
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    const result = await save(form({ status: "paused", frequency: "manual" }));

    expect(result?.status).toBe("success");
    expect(mocks.countRoutines).not.toHaveBeenCalled();
  });

  it("asks nothing when a paused worker stays paused", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());

    await save(form({ status: "paused", frequency: "manual" }));

    expect(mocks.countRoutines).not.toHaveBeenCalled();
  });

  /**
   * **A manual worker spends a slot too.** Nothing schedules it, and that is
   * deliberately not the question: the limit is about the state somebody can
   * see on the dashboard.
   */
  it("counts a manual worker being turned on", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    expect(
      (await save(form({ status: "active", frequency: "manual" })))?.status,
    ).toBe("error");
  });

  it("moves the address and the baseline in the same transaction as the check", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "paused", kind: "website" }),
    );
    mocks.getWebsiteSource.mockResolvedValue({
      id: "source-1",
      url: "https://example.com/old",
    });

    const result = await save(
      form({
        status: "active",
        frequency: "manual",
        prompt: "Summarise what changed.",
        websiteUrl: "https://example.com/new",
      }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateWebsiteSourceUrl).toHaveBeenCalledWith(
      "worker-1",
      "google-sub-1",
      "https://example.com/new",
      TX,
    );
    expect(mocks.deleteWebsiteSnapshot).toHaveBeenCalledWith("source-1", TX);
  });

  it("touches neither the address nor the baseline when the quota refuses", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "paused", kind: "website" }),
    );
    mocks.getWebsiteSource.mockResolvedValue({
      id: "source-1",
      url: "https://example.com/old",
    });
    mocks.countRoutines.mockResolvedValue(ACTIVE_WORKER_LIMIT);

    await save(
      form({
        status: "active",
        frequency: "manual",
        prompt: "Summarise what changed.",
        websiteUrl: "https://example.com/new",
      }),
    );

    expect(mocks.updateWebsiteSourceUrl).not.toHaveBeenCalled();
    expect(mocks.deleteWebsiteSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a database failure a database failure", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());
    mocks.countRoutines.mockRejectedValue(new Error("connection terminated"));

    const result = await save(form({ status: "active", frequency: "manual" }));

    expect(result?.message).toBe("Could not save the worker.");
    expect(result?.errors?.status).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  /**
   * **Turning a worker on is not a schedule change**, so the pending slot it
   * already had is left exactly where it was — including one in the past, which
   * the next tick will pick up. That is the existing catch-up behaviour and the
   * quota does not touch it.
   */
  it("still leaves the pending slot alone when only the status changes", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(paused());

    await save(form({ status: "active", frequency: "manual" }));

    const [, update] = mocks.updateRoutine.mock.calls[0];
    expect(update).not.toHaveProperty("nextRunAt");
  });
});

describe("updateRoutineAction — the prompt contract", () => {
  it("A: a draft with no prompt stays saveable", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(stored({ prompt: "" }));

    const result = await save(
      form({ prompt: "", status: "draft", frequency: "manual" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  it("B: a draft with no prompt cannot be put on a schedule", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(stored({ prompt: "" }));

    const result = await save(
      form({ prompt: "", status: "active", frequency: "daily" }),
    );

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBe(
      "Prompt is required for scheduled active workers.",
    );
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("C: the same worker goes active once it has a prompt", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(stored({ prompt: "" }));

    const result = await save(
      form({ prompt: "Summarise today.", status: "active", frequency: "daily" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  /** The one that breaks a worker already running on a schedule. */
  it("D: a scheduled active worker cannot have its prompt emptied", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "active", frequency: "daily", runAtMinutes: 540 }),
    );

    const result = await save(
      form({ prompt: "", status: "active", frequency: "daily", runAt: "09:00" }),
    );

    expect(result?.status).toBe("error");
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  /**
   * Status and prompt arrive together, so stepping down and clearing it is one
   * save rather than two — there is no order in which this is rejected.
   */
  it("E: clearing the prompt while stepping down to draft is allowed", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "active", frequency: "daily", runAtMinutes: 540 }),
    );

    const result = await save(
      form({ prompt: "", status: "draft", frequency: "daily", runAt: "09:00" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  it("F: changing only the schedule leaves the prompt rule satisfied", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "active", frequency: "daily", runAtMinutes: 540 }),
    );

    const result = await save(
      form({
        prompt: "Summarise today's news.",
        status: "active",
        frequency: "weekly",
        runAt: "09:00",
        runAtWeekday: "3",
      }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine.mock.calls[0][1]).toHaveProperty("nextRunAt");
  });

  /**
   * The fallbacks are what a submission that leaves a field out lands on, and
   * the rule has to be asked about those rather than about the absence.
   */
  it("G: a submission with no status is judged against the status it will keep", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "active", frequency: "daily", runAtMinutes: 540 }),
    );

    const result = await save(form({ prompt: "", frequency: "daily" }));

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBeDefined();
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  it("H: a submission with no frequency is judged against the cadence it will keep", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "active", frequency: "weekly", runAtWeekday: 3 }),
    );

    const result = await save(form({ prompt: "", status: "active" }));

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBeDefined();
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  it("leaves an active manual worker free to have no prompt", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ status: "active", frequency: "manual" }),
    );

    const result = await save(
      form({ prompt: "", status: "active", frequency: "manual" }),
    );

    expect(result?.status).toBe("success");
  });
});

/**
 * A separate concern at the other end of the same function: whether the write
 * landed at all. Nothing here is about the prompt.
 */
describe("updateRoutineAction — a write that matched no row", () => {
  it("does not report success when nothing was updated", async () => {
    mocks.updateRoutine.mockResolvedValue(null);

    const result = await save(form({ prompt: "Summarise today." }));

    expect(result?.status).toBe("error");
    expect(result?.message).toBe("Worker not found.");
  });

  it("does not revalidate anything when nothing was updated", async () => {
    mocks.updateRoutine.mockResolvedValue(null);

    await save(form({ prompt: "Summarise today." }));

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("hands the submitted values back so the form keeps them", async () => {
    mocks.updateRoutine.mockResolvedValue(null);

    const result = await save(form({ prompt: "Summarise today." }));

    expect(result?.values?.prompt).toBe("Summarise today.");
  });

  it("still reports success, and revalidates, when a row was updated", async () => {
    const result = await save(form({ prompt: "Summarise today." }));

    expect(result?.status).toBe("success");
    expect(result?.message).toBe('Worker "Daily digest" saved.');
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/workers/worker-1",
    );
  });

  it("reports a write that threw as a failure rather than as a missing worker", async () => {
    mocks.updateRoutine.mockRejectedValue(new Error("connection terminated"));

    const result = await save(form({ prompt: "Summarise today." }));

    expect(result?.message).toBe("Could not save the worker.");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("updateRoutineAction — ownership", () => {
  it("404s on a worker that is not the signed-in owner's", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(null);

    await expect(save(form({ prompt: "x" }))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });
});

/**
 * Editing a worker that watches a page.
 *
 * Two things are being held apart, and they are easy to confuse because both
 * are "saving an edit". Changing what a worker *says* — its name, its
 * instructions, when it runs — says nothing about the page it watches, and must
 * leave the baseline alone: losing it means the next run reports a page it has
 * already reported. Changing *which page* it watches invalidates the baseline
 * completely, because a baseline only means anything against the page it came
 * from.
 *
 * So the question every test here asks is which of those happened, and the
 * answer is decided by comparing canonical URLs — never the strings as typed.
 */
describe("updateRoutineAction — website workers", () => {
  const WATCHED = "https://example.com/news";
  const MOVED = "https://example.com/updates";

  function website(fields?: Record<string, string>) {
    return form({
      websiteUrl: WATCHED,
      prompt: "Tell me what changed.",
      ...fields,
    });
  }

  beforeEach(() => {
    mocks.getRoutineForEdit.mockResolvedValue(
      stored({ kind: "website", prompt: "Tell me what changed." }),
    );
    mocks.updateRoutine.mockResolvedValue(
      stored({ kind: "website", prompt: "Tell me what changed." }),
    );
    mocks.getWebsiteSource.mockResolvedValue({
      id: "source-1",
      routineId: "worker-1",
      url: WATCHED,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  describe("when the page is the same one", () => {
    it("saves without touching the source or the baseline", async () => {
      const result = await save(website({ name: "Renamed" }));

      expect(result?.status).toBe("success");
      expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.updateWebsiteSourceUrl).not.toHaveBeenCalled();
      expect(mocks.deleteWebsiteSnapshot).not.toHaveBeenCalled();
    });

    /**
     * The fragment is never sent, so `parseWatchUrl` drops it — which means an
     * address written with one is the same page as the address without it.
     * Comparing what was typed would call that a move and spend the baseline.
     */
    it.each([
      ["a fragment", `${WATCHED}#section`],
      ["surrounding space", `  ${WATCHED}  `],
      ["a redundant port", "https://example.com:443/news"],
      ["a capitalised host", "https://Example.com/news"],
    ])("treats %s as the same page", async (_label, websiteUrl) => {
      const result = await save(website({ websiteUrl }));

      expect(result?.status).toBe("success");
      expect(mocks.deleteWebsiteSnapshot).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it.each([
      ["the instructions", { prompt: "Say what moved." }],
      ["the name", { name: "Renamed" }],
      ["the description", { description: "Now with a description." }],
      ["the status", { status: "paused" }],
      ["the cadence", { frequency: "daily", runAt: "09:00" }],
      ["it to manual", { frequency: "manual" }],
    ])("keeps the baseline when %s changes", async (_label, fields) => {
      await save(website(fields));

      expect(mocks.deleteWebsiteSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("when the page changes", () => {
    it("updates the worker, the address and the baseline in one transaction", async () => {
      const result = await save(website({ websiteUrl: MOVED }));

      expect(result?.status).toBe("success");
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.updateRoutine).toHaveBeenCalledWith(
        "worker-1",
        expect.any(Object),
        "google-sub-1",
        TX,
      );
      expect(mocks.updateWebsiteSourceUrl).toHaveBeenCalledWith(
        "worker-1",
        "google-sub-1",
        MOVED,
        TX,
      );
      expect(mocks.deleteWebsiteSnapshot).toHaveBeenCalledWith("source-1", TX);
    });

    it("throws the baseline away only after the address has moved", async () => {
      await save(website({ websiteUrl: MOVED }));

      expect(
        mocks.updateWebsiteSourceUrl.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.deleteWebsiteSnapshot.mock.invocationCallOrder[0]);
    });

    /**
     * A worker edited before it has ever run has no baseline yet, and that is
     * ordinary rather than a problem — otherwise a brand-new website worker
     * would be the only kind whose address could not be corrected.
     */
    it("succeeds when there is no baseline to throw away", async () => {
      mocks.deleteWebsiteSnapshot.mockResolvedValue(0);

      const result = await save(website({ websiteUrl: MOVED }));

      expect(result?.status).toBe("success");
    });

    it("does not report a save when the address could not be moved", async () => {
      mocks.updateWebsiteSourceUrl.mockResolvedValue(false);

      const result = await save(website({ websiteUrl: MOVED }));

      expect(result?.status).toBe("error");
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("does not report a save when the baseline could not be thrown away", async () => {
      mocks.deleteWebsiteSnapshot.mockRejectedValue(new Error("boom"));

      const result = await save(website({ websiteUrl: MOVED }));

      expect(result?.status).toBe("error");
      expect(result?.message).toBe("Could not save the worker.");
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("does not report a save when the worker was deleted mid-save", async () => {
      mocks.updateRoutine.mockResolvedValue(null);

      const result = await save(website({ websiteUrl: MOVED }));

      expect(result?.status).toBe("error");
      expect(result?.message).toBe("Worker not found.");
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("what it will not save", () => {
    it.each([
      ["blank", ""],
      ["not a URL at all", "example"],
      ["a scheme this does not fetch", "ftp://example.com/news"],
      ["carrying credentials", "https://user:pass@example.com/news"],
      ["on another port", "https://example.com:8443/news"],
      ["nothing but a scheme", "https://"],
    ])("refuses an address that is %s", async (_label, websiteUrl) => {
      const result = await save(website({ websiteUrl }));

      expect(result?.status).toBe("error");
      expect(result?.errors?.websiteUrl).toBeDefined();
      expect(mocks.updateRoutine).not.toHaveBeenCalled();
      expect(mocks.deleteWebsiteSnapshot).not.toHaveBeenCalled();
    });

    it("refuses an address longer than the limit", async () => {
      const long = `https://example.com/${"a".repeat(8_192)}`;

      const result = await save(website({ websiteUrl: long }));

      expect(result?.errors?.websiteUrl).toBeDefined();
      expect(mocks.updateRoutine).not.toHaveBeenCalled();
    });

    it.each([
      ["blank", ""],
      ["only whitespace", "   "],
    ])("refuses instructions that are %s", async (_label, prompt) => {
      const result = await save(website({ prompt }));

      expect(result?.status).toBe("error");
      expect(result?.errors?.prompt).toBeDefined();
      expect(mocks.updateRoutine).not.toHaveBeenCalled();
    });

    /** Stricter than a prompt worker: nothing about the status relaxes it. */
    it("requires instructions even on a manual draft", async () => {
      const result = await save(
        website({ prompt: "", status: "draft", frequency: "manual" }),
      );

      expect(result?.errors?.prompt).toBeDefined();
    });

    it("accepts instructions exactly at the limit", async () => {
      const result = await save(website({ prompt: "a".repeat(10_000) }));

      expect(result?.status).toBe("success");
    });

    it("refuses instructions past the limit", async () => {
      const result = await save(website({ prompt: "a".repeat(10_001) }));

      expect(result?.errors?.prompt).toBeDefined();
      expect(mocks.updateRoutine).not.toHaveBeenCalled();
    });

    it("keeps the address in the values it hands back", async () => {
      const result = await save(website({ name: "", websiteUrl: MOVED }));

      expect(result?.values?.websiteUrl).toBe(MOVED);
    });
  });

  /**
   * A website worker with nothing to watch is a state that should not exist.
   * Saving the form as though it were a prompt worker would make it permanent —
   * the conversion this whole boundary refuses, arrived at by accident.
   */
  it("refuses to save a website worker that has no page", async () => {
    mocks.getWebsiteSource.mockResolvedValue(null);

    const result = await save(website());

    expect(result?.status).toBe("error");
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

/**
 * What a worker is cannot be edited.
 *
 * The type system carries most of this — `updateRoutine` takes a
 * `Partial<RoutineInput>`, which has no kind in it, so there is no value it
 * could be handed that would write one. What the tests add is the boundary
 * either side: a submission claiming a kind is read past, and a stored kind
 * nothing recognises stops the save rather than being repaired into one.
 */
describe("updateRoutineAction — the kind cannot be edited", () => {
  it.each(["website", "webhook", ""])(
    "ignores a submitted kind of %s on a prompt worker",
    async (kind) => {
      const result = await save(form({ prompt: "Summarise.", kind }));

      expect(result?.status).toBe("success");
      expect(mocks.updateRoutine).toHaveBeenCalledWith(
        "worker-1",
        expect.not.objectContaining({ kind: expect.anything() }),
        "google-sub-1",
      );
      expect(mocks.getWebsiteSource).not.toHaveBeenCalled();
      expect(mocks.updateWebsiteSourceUrl).not.toHaveBeenCalled();
      expect(mocks.deleteWebsiteSnapshot).not.toHaveBeenCalled();
    },
  );

  it("ignores a submitted kind of prompt on a website worker", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(stored({ kind: "website" }));
    mocks.getWebsiteSource.mockResolvedValue({
      id: "source-1",
      routineId: "worker-1",
      url: "https://example.com/news",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    // Reads as a website worker throughout: the address is still required, and
    // leaving it out is what proves the submitted kind was not believed.
    const result = await save(form({ kind: "prompt", prompt: "Summarise." }));

    expect(result?.status).toBe("error");
    expect(result?.errors?.websiteUrl).toBeDefined();
  });

  /**
   * `getRoutineForEdit` answers null for a kind it cannot read, which is the
   * same answer it gives for somebody else's worker — in both cases there is
   * nothing here this caller may change.
   */
  it("404s rather than editing a worker of an unrecognised kind", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(null);

    await expect(save(form({ prompt: "x" }))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });
});

/**
 * What saving a worker says back, in the account's language.
 *
 * **The worker inside the sentence is the owner's**, and so is everything the
 * form saved: a language decides the wording of the answer and nothing about
 * what was written.
 */
describe("updateRoutineAction — the words it answers in", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("says a worker was saved, keeping its name as typed", async () => {
    const result = await save(form({ name: "宝塚市 パブリック・コメント" }));

    expect(result).toMatchObject({
      status: "success",
      message: "Worker「宝塚市 パブリック・コメント」を保存しました。",
    });
  });

  it("refuses a blank name in Japanese", async () => {
    const result = await save(form({ name: "" }));

    expect(result?.message).toBe("名前は必須です。");
    expect(result?.errors?.name).toBe("名前は必須です。");
  });

  it("says a worker was not found in Japanese", async () => {
    mocks.updateRoutine.mockResolvedValue(null);

    const result = await save(form({}));

    expect(result?.message).toBe("Worker が見つかりません。");
  });

  it("reports a failed write in Japanese", async () => {
    mocks.updateRoutine.mockRejectedValue(new Error("connection lost"));

    const result = await save(form({}));

    expect(result?.message).toBe("Worker を保存できませんでした。");
  });

  it("saves the same values whichever language it answers in", async () => {
    await save(form({ name: "Watcher" }));

    const call = mocks.updateRoutine.mock.calls.at(-1) as unknown[];

    expect(call[1]).toMatchObject({ name: "Watcher" });
  });
});
