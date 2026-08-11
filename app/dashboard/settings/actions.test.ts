import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Saving a timezone from an account that may have no row yet.
 *
 * The provisioning boundary is exercised for real here — only `auth` and the
 * persistence layer are stood in for — because the order is the thing being
 * fixed. A submission that gets rejected must not create the row that saving
 * it would have needed, and a row that could not be written must not read as
 * a timezone that could not be saved for some other reason.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  ensureUser: vi.fn(),
  setUserTimezone: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/users", () => ({
  ensureUser: mocks.ensureUser,
  setUserTimezone: mocks.setUserTimezone,
}));

const { updateTimezoneAction } = await import(
  "@/app/dashboard/settings/actions"
);

class RedirectSignal extends Error {}

function form(timezone: string, extra?: Record<string, string>) {
  const data = new FormData();
  data.set("timezone", timezone);
  for (const [key, value] of Object.entries(extra ?? {})) {
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
  mocks.setUserTimezone.mockReset().mockResolvedValue(undefined);
  mocks.revalidatePath.mockReset();
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new RedirectSignal(to);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updateTimezoneAction", () => {
  /**
   * The bug this sprint exists for: an account that has never created a
   * worker had no row, and `update` had nothing to write to.
   */
  it("provisions the account row before writing the timezone", async () => {
    const result = await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(result).toEqual({ status: "success", message: "Timezone saved." });
    expect(mocks.ensureUser).toHaveBeenCalledTimes(1);
    expect(mocks.setUserTimezone).toHaveBeenCalledWith(
      "google-sub-1",
      "Asia/Tokyo",
    );
    expect(mocks.ensureUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setUserTimezone.mock.invocationCallOrder[0],
    );
  });

  /**
   * Provisioning refreshes the provider's own fields. The timezone is not one
   * of them, so saving one cannot be undone by the call that precedes it.
   */
  it("leaves the provider profile intact and never sends a timezone to it", async () => {
    await updateTimezoneAction(null, form("Europe/Paris"));

    expect(mocks.ensureUser).toHaveBeenCalledWith({
      id: "google-sub-1",
      email: "someone@example.com",
      name: "Someone",
      image: null,
    });
    expect(mocks.ensureUser.mock.calls[0][0]).not.toHaveProperty("timezone");
  });

  it("rejects an unrecognised zone without provisioning or writing anything", async () => {
    const result = await updateTimezoneAction(null, form("Mars/Olympus_Mons"));

    expect(result).toEqual({
      status: "error",
      message: "Select a timezone from the list.",
    });
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * Who is asking is settled before what they sent is judged. Provisioning is
   * the step that waits for a valid submission — authenticating is not, and
   * the two are separate for that reason.
   */
  it("still establishes who is asking when the submission is rejected", async () => {
    await updateTimezoneAction(null, form("Mars/Olympus_Mons"));

    expect(mocks.auth).toHaveBeenCalled();
  });

  it("redirects a signed-out visitor even when what they sent was invalid", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(
      updateTimezoneAction(null, form("Mars/Olympus_Mons")),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
  });

  it("treats a missing field the same way", async () => {
    const result = await updateTimezoneAction(null, new FormData());

    expect(result?.status).toBe("error");
    expect(mocks.ensureUser).not.toHaveBeenCalled();
    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
  });

  /**
   * The driver's own wording is for the log. What comes back is the same
   * sentence either failure gets, because there is nothing the person who
   * pressed Save can do differently about one versus the other.
   */
  it("fails safely when the account row cannot be written", async () => {
    mocks.ensureUser.mockRejectedValue(
      new Error('relation "User" does not exist'),
    );

    const result = await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(result).toEqual({
      status: "error",
      message: "Could not save your timezone.",
    });
    expect(result?.message).not.toContain("relation");
    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("still fails safely when the timezone itself cannot be written", async () => {
    mocks.setUserTimezone.mockRejectedValue(new Error("P2025"));

    const result = await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(result).toEqual({
      status: "error",
      message: "Could not save your timezone.",
    });
    expect(result?.message).not.toContain("P2025");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * A redirect leaves by being thrown. Catching it to report a form error
   * would leave a signed-out visitor looking at the settings page.
   */
  it("lets a signed-out visitor be redirected rather than reporting a save failure", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(
      updateTimezoneAction(null, form("Asia/Tokyo")),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
  });

  /** The owner is the session's, and a form saying otherwise changes nothing. */
  it("takes the owner from the session, never from the form", async () => {
    await updateTimezoneAction(
      null,
      form("Asia/Tokyo", { userId: "someone-else" }),
    );

    expect(mocks.setUserTimezone).toHaveBeenCalledWith(
      "google-sub-1",
      "Asia/Tokyo",
    );
  });

  it("can be saved twice in a row", async () => {
    expect((await updateTimezoneAction(null, form("Asia/Tokyo")))?.status).toBe(
      "success",
    );
    expect((await updateTimezoneAction(null, form("UTC")))?.status).toBe(
      "success",
    );
    expect(mocks.setUserTimezone).toHaveBeenLastCalledWith(
      "google-sub-1",
      "UTC",
    );
  });

  it("revalidates the dashboard only once the write has landed", async () => {
    await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });
});
