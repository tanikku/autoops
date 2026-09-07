import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which language the document claims to be in, decided from the session alone.
 *
 * **Two things are being fixed here, and the second is the quiet one.** The
 * obvious rule is that a Japanese account gets `ja`. The rule that is easy to
 * break later is that a signed-out visitor costs no database query and creates
 * no account row: this runs on the public landing page and on the privacy
 * notice, which anybody can open, and a read that provisioned a row would turn
 * every visit into a write.
 *
 * The session and the stored language are both replaced, so nothing here needs
 * a database or a key — the same arrangement the pages' own tests use.
 */

const { auth, getUserLanguage } = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/users", () => ({ getUserLanguage }));

const { getDocumentLanguage } = await import("@/lib/i18n/server");

beforeEach(() => {
  auth.mockReset();
  getUserLanguage.mockReset();
});

describe("when nobody is signed in", () => {
  /** No session at all: the ordinary state of every public page. */
  it("answers English for a visitor with no session", async () => {
    auth.mockResolvedValue(null);

    await expect(getDocumentLanguage()).resolves.toBe("en");
  });

  /**
   * A session object without a usable id is not a signed-in person. It is the
   * shape a half-established or expired session can arrive in, and treating it
   * as an account would mean reading a row for an id that is not there.
   */
  it.each([
    ["a session with no user", {}],
    ["a user with no id", { user: {} }],
    ["an id that is not there", { user: { id: undefined } }],
  ])("answers English for %s", async (_name, session) => {
    auth.mockResolvedValue(session);

    await expect(getDocumentLanguage()).resolves.toBe("en");
  });

  /**
   * **The database is never asked.** Anonymous requests are most of the traffic
   * a public page sees, and there is no row to read for somebody who has not
   * signed in.
   */
  it.each([
    ["no session", null],
    ["a session with no id", { user: {} }],
  ])("reads no stored language when there is %s", async (_name, session) => {
    auth.mockResolvedValue(session);

    await getDocumentLanguage();

    expect(getUserLanguage).not.toHaveBeenCalled();
  });
});

describe("when somebody is signed in", () => {
  beforeEach(() => {
    auth.mockResolvedValue({ user: { id: "google-sub-1" } });
  });

  it.each(["en", "ja"] as const)("answers with their stored %s", async (language) => {
    getUserLanguage.mockResolvedValue(language);

    await expect(getDocumentLanguage()).resolves.toBe(language);
  });

  it("asks for the language of the account in the session, and no other", async () => {
    getUserLanguage.mockResolvedValue("ja");

    await getDocumentLanguage();

    expect(getUserLanguage).toHaveBeenCalledTimes(1);
    expect(getUserLanguage).toHaveBeenCalledWith("google-sub-1");
  });

  /**
   * The fallback for an unreadable or missing stored value belongs to
   * `getUserLanguage`, which already answers English for both. What is checked
   * here is only that this passes that answer through rather than deciding
   * again on its own — two places deciding would be two places to disagree.
   */
  it("passes the stored answer through rather than re-deciding", async () => {
    getUserLanguage.mockResolvedValue("en");

    await expect(getDocumentLanguage()).resolves.toBe("en");
  });
});
