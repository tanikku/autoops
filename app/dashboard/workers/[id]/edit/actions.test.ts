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
  getRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  getUserTimezone: vi.fn(),
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
  getRoutine: mocks.getRoutine,
  updateRoutine: mocks.updateRoutine,
}));
vi.mock("@/lib/users", () => ({ getUserTimezone: mocks.getUserTimezone }));

const { updateRoutineAction } = await import(
  "@/app/dashboard/workers/[id]/edit/actions"
);

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
  mocks.getRoutine.mockReset().mockResolvedValue(stored());
  mocks.updateRoutine.mockReset().mockResolvedValue(stored());
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
  mocks.revalidatePath.mockReset();
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new NotFoundSignal();
  });
  mocks.redirect.mockReset().mockImplementation(() => {
    throw new RedirectSignal();
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updateRoutineAction — the prompt contract", () => {
  it("A: a draft with no prompt stays saveable", async () => {
    mocks.getRoutine.mockResolvedValue(stored({ prompt: "" }));

    const result = await save(
      form({ prompt: "", status: "draft", frequency: "manual" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  it("B: a draft with no prompt cannot be put on a schedule", async () => {
    mocks.getRoutine.mockResolvedValue(stored({ prompt: "" }));

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
    mocks.getRoutine.mockResolvedValue(stored({ prompt: "" }));

    const result = await save(
      form({ prompt: "Summarise today.", status: "active", frequency: "daily" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  /** The one that breaks a worker already running on a schedule. */
  it("D: a scheduled active worker cannot have its prompt emptied", async () => {
    mocks.getRoutine.mockResolvedValue(
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
    mocks.getRoutine.mockResolvedValue(
      stored({ status: "active", frequency: "daily", runAtMinutes: 540 }),
    );

    const result = await save(
      form({ prompt: "", status: "draft", frequency: "daily", runAt: "09:00" }),
    );

    expect(result?.status).toBe("success");
    expect(mocks.updateRoutine).toHaveBeenCalledTimes(1);
  });

  it("F: changing only the schedule leaves the prompt rule satisfied", async () => {
    mocks.getRoutine.mockResolvedValue(
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
    mocks.getRoutine.mockResolvedValue(
      stored({ status: "active", frequency: "daily", runAtMinutes: 540 }),
    );

    const result = await save(form({ prompt: "", frequency: "daily" }));

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBeDefined();
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  it("H: a submission with no frequency is judged against the cadence it will keep", async () => {
    mocks.getRoutine.mockResolvedValue(
      stored({ status: "active", frequency: "weekly", runAtWeekday: 3 }),
    );

    const result = await save(form({ prompt: "", status: "active" }));

    expect(result?.status).toBe("error");
    expect(result?.errors?.prompt).toBeDefined();
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });

  it("leaves an active manual worker free to have no prompt", async () => {
    mocks.getRoutine.mockResolvedValue(
      stored({ status: "active", frequency: "manual" }),
    );

    const result = await save(
      form({ prompt: "", status: "active", frequency: "manual" }),
    );

    expect(result?.status).toBe("success");
  });
});

describe("updateRoutineAction — ownership", () => {
  it("404s on a worker that is not the signed-in owner's", async () => {
    mocks.getRoutine.mockResolvedValue(null);

    await expect(save(form({ prompt: "x" }))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
    expect(mocks.updateRoutine).not.toHaveBeenCalled();
  });
});
