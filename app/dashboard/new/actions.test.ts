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
  ensureUser: vi.fn(),
  getUserTimezone: vi.fn(),
  createRoutine: vi.fn(),
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

const { createRoutineAction } = await import("@/app/dashboard/new/actions");

class RedirectSignal extends Error {}

function form(overrides?: Record<string, string>) {
  const data = new FormData();
  data.set("name", "Daily digest");
  data.set("description", "");
  data.set("prompt", "Summarise {{today}}");
  data.set("status", "active");
  data.set("frequency", "daily");
  data.set("runAt", "09:00");
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
