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
  getUserLanguage: vi.fn(),
  setUserLanguage: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/users", () => ({
  ensureUser: mocks.ensureUser,
  setUserTimezone: mocks.setUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
  setUserLanguage: mocks.setUserLanguage,
}));

const { updateTimezoneAction, updateLanguageAction } = await import(
  "@/app/dashboard/settings/actions"
);
const { en } = await import("@/lib/i18n/en");
const { ja } = await import("@/lib/i18n/ja");

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
  // The timezone save reads this for the wording of its answer. English by
  // default, so the existing assertions keep describing what they described.
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
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

/**
 * Choosing which language AutoOps speaks in.
 *
 * The same order the timezone save keeps — authenticate, validate, provision,
 * write — and the same reason for it: a submission that gets rejected must not
 * create the row that saving it would have needed.
 *
 * **What is different is which language the answer is in.** A save speaks the
 * language that was just chosen, because that is what the reloaded page will
 * be in. A rejection speaks the one still in force, because nothing changed.
 */
describe("updateLanguageAction", () => {
  function languageForm(language: string) {
    const data = new FormData();
    data.set("language", language);
    return data;
  }

  beforeEach(() => {
    mocks.getUserLanguage.mockReset().mockResolvedValue("en");
    mocks.setUserLanguage.mockReset().mockResolvedValue(undefined);
  });

  it("saves a language the application knows", async () => {
    const result = await updateLanguageAction(null, languageForm("ja"));

    expect(mocks.setUserLanguage).toHaveBeenCalledWith("google-sub-1", "ja");
    expect(result).toEqual({
      status: "success",
      message: ja["settings.language.saved"],
    });
  });

  it("answers in the language that was just chosen", async () => {
    mocks.getUserLanguage.mockResolvedValue("en");

    const toJapanese = await updateLanguageAction(null, languageForm("ja"));
    const toEnglish = await updateLanguageAction(null, languageForm("en"));

    expect(toJapanese?.message).toBe(ja["settings.language.saved"]);
    expect(toEnglish?.message).toBe(en["settings.language.saved"]);
  });

  it("revalidates every screen, because every screen will read it", async () => {
    await updateLanguageAction(null, languageForm("ja"));

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });

  it.each(["", "fr", "EN", "ja-JP", "english"])(
    "refuses %o without writing anything",
    async (language) => {
      const result = await updateLanguageAction(null, languageForm(language));

      expect(result?.status).toBe("error");
      expect(mocks.setUserLanguage).not.toHaveBeenCalled();
      expect(mocks.ensureUser).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  /** Nothing changed, so the refusal is written in the language still in force. */
  it("refuses in the language currently stored", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const result = await updateLanguageAction(null, languageForm("fr"));

    expect(result?.message).toBe(ja["settings.language.invalid"]);
  });

  it("sends a visitor with no session to sign in", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(
      updateLanguageAction(null, languageForm("ja")),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.setUserLanguage).not.toHaveBeenCalled();
  });

  /**
   * The row is provisioned by the boundary this action calls, and that boundary
   * writes: a database that refuses the write is a provisioning failure, not a
   * signed-out visitor.
   */
  it("reports an account row that could not be provisioned", async () => {
    mocks.ensureUser.mockRejectedValue(
      new Error('relation "User" does not exist'),
    );

    const result = await updateLanguageAction(null, languageForm("ja"));

    expect(result?.status).toBe("error");
    expect(result?.message).toBe(ja["settings.language.failed"]);
    expect(result?.message).not.toContain("relation");
    expect(mocks.setUserLanguage).not.toHaveBeenCalled();
  });

  it("reports a write that failed without claiming it saved", async () => {
    mocks.setUserLanguage.mockRejectedValue(new Error("boom"));

    const result = await updateLanguageAction(null, languageForm("ja"));

    expect(result?.status).toBe("error");
    expect(result?.message).toBe(ja["settings.language.failed"]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /** The two settings on this page are two writes, and stay that way. */
  it("does not touch the timezone", async () => {
    await updateLanguageAction(null, languageForm("ja"));

    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
  });
});

/**
 * What saving a zone says back, in the account's language.
 *
 * **The zone itself is not translated.** An IANA identifier is what the column
 * holds and what the scheduler reads; only the sentence about it moves.
 */
describe("updateTimezoneAction — the words it answers in", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("says a zone was saved", async () => {
    const result = await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(result).toEqual({
      status: "success",
      message: "タイムゾーンを保存しました。",
    });
  });

  it("refuses a zone it does not know", async () => {
    const result = await updateTimezoneAction(null, form("Mars/Olympus"));

    expect(result).toEqual({
      status: "error",
      message: "一覧からタイムゾーンを選んでください。",
    });
    expect(mocks.setUserTimezone).not.toHaveBeenCalled();
  });

  it("reports a failed write", async () => {
    mocks.setUserTimezone.mockRejectedValue(new Error("connection lost"));

    const result = await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(result).toEqual({
      status: "error",
      message: "タイムゾーンを保存できませんでした。",
    });
  });

  it("stores the identifier itself, unchanged", async () => {
    await updateTimezoneAction(null, form("Asia/Tokyo"));

    expect(mocks.setUserTimezone).toHaveBeenCalledWith(
      expect.anything(),
      "Asia/Tokyo",
    );
  });
});
