import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The claims this page has to keep making — now in two languages.
 *
 * **Not a snapshot.** Fixing every paragraph would make rewording it a test
 * failure, which teaches people to update the expectation without reading it.
 * What is checked instead is the handful of statements that would be a lie by
 * omission if they disappeared — and the promises that must never appear,
 * because nothing in the code would keep them.
 *
 * Creator is the reason this matters now: a worker sends instructions somebody
 * wrote to be sent, while Creator sends a piece of writing that has not been
 * published anywhere.
 *
 * **The Japanese half is checked the same way, and for the same reason.** A
 * translation that quietly dropped the twelve-answer limit, or the fact that
 * nothing here can be deleted, would be a different privacy notice for the
 * people reading it. Substrings rather than sentences, so rewording the
 * Japanese stays possible without rewriting these.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserLanguage: vi.fn(),
  supportMailtoHref: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
/**
 * **Stood in so the contact section exists at all.** It is only rendered when
 * `SUPPORT_EMAIL` is configured, which it is not under test — so without this
 * the localised subject and action would be checked against markup that was
 * never produced.
 */
vi.mock("@/lib/support", () => ({
  supportMailtoHref: mocks.supportMailtoHref,
}));

const PrivacyPage = (await import("@/app/privacy/page")).default;

/** The rendered page with its markup stripped, for whichever session is set. */
const render = async () =>
  renderToStaticMarkup(await PrivacyPage()).replace(/<[^>]*>/g, " ");

const signedOut = () => {
  mocks.auth.mockResolvedValue(null);
};

const signedInWith = (userId: string, language: "en" | "ja") => {
  mocks.auth.mockResolvedValue({ user: { id: userId } });
  mocks.getUserLanguage.mockResolvedValue(language);
};

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.getUserLanguage.mockReset();
  mocks.supportMailtoHref
    .mockReset()
    .mockImplementation(
      (subject: string) =>
        `mailto:support@example.test?subject=${encodeURIComponent(subject)}`,
    );
});

describe("which language the notice is written in", () => {
  /**
   * **A signed-out visitor must still get the page.** Asking for a session the
   * way `requireUserId` does would redirect them to sign in to read a privacy
   * notice, which is the opposite of what one is for.
   */
  it("renders in English for a visitor with no session, without reading a language", async () => {
    signedOut();

    const text = await render();

    expect(text).toContain("Privacy");
    expect(text).toContain("Koqentra is in Closed Beta");
    expect(mocks.getUserLanguage).not.toHaveBeenCalled();
  });

  it("renders in Japanese for a signed-in account set to Japanese", async () => {
    signedInWith("user-ja", "ja");

    const text = await render();

    expect(text).toContain("プライバシー");
    expect(text).toContain("Koqentraはクローズドベータです");
    expect(mocks.getUserLanguage).toHaveBeenCalledTimes(1);
    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-ja");
  });

  it("renders in English for a signed-in account set to English", async () => {
    signedInWith("user-en", "en");

    const text = await render();

    expect(text).toContain("Koqentra is in Closed Beta");
    expect(text).not.toContain("プライバシー");
  });

  /**
   * **The id comes from the session and nowhere else.** A page that accepted
   * one as a prop or a search param would read somebody else's setting for the
   * asking, so it takes no arguments at all.
   */
  it("takes no request input, so no caller can choose whose language is read", () => {
    expect(PrivacyPage.length).toBe(0);
  });
});

describe("English notice", () => {
  beforeEach(signedOut);

  describe("what Creator sends", () => {
    it("says the writing goes to Anthropic", async () => {
      const text = await render();

      expect(text).toContain("Anthropic");
      expect(text).toContain("analyze");
    });

    /** Preferences and recent answers travel with it; the whole history does not. */
    it("says recent answers travel with it, and how many", async () => {
      const text = await render();

      expect(text).toContain("twelve");
      expect(text).toContain("not your whole history");
    });

    it("names what an answer can carry", async () => {
      const text = await render();

      expect(text).toContain("edited text");
      expect(text).toContain("extract");
    });
  });

  describe("what Creator stores", () => {
    it("says what a successful analysis keeps", async () => {
      const text = await render();

      expect(text).toContain("stores the title and body");
      expect(text).toContain("post text");
    });

    it("says what an answer keeps, and that the original is not overwritten", async () => {
      const text = await render();

      expect(text).toContain("agreed, rewrote it, or turned it down");
      expect(text).toContain("kept as it was written");
    });
  });

  describe("what Creator does not do", () => {
    /** The single most important sentence on the page for this feature. */
    it("says it posts nothing anywhere", async () => {
      const text = await render();

      expect(text).toContain("does not post anything anywhere");
    });

    it("says the output may be wrong", async () => {
      const text = await render();

      expect(text).toContain("may be wrong");
    });
  });

  describe("how long it is kept", () => {
    it("says nothing expires it", async () => {
      const text = await render();

      expect(text).toContain("no way to delete it from inside Koqentra");
      expect(text).toContain("nothing removes it after a period of time");
    });

    /**
     * **The misreading worth heading off.** Somebody who deletes their workers
     * to clear their data would otherwise assume Creator went with them.
     */
    it("says deleting a worker does not delete Creator data", async () => {
      const text = await render();

      expect(text).toContain("does not delete anything from Creator");
    });
  });

  /**
   * **Narrowed rather than dropped.** The page used to say nothing is used to
   * build a profile, which sat badly beside Creator carrying audience, goals
   * and recent answers into the next analysis. What is provable is that the
   * information serves the features and is not sold, so that is what it says.
   */
  it("keeps the selling claim without claiming no profile is built", async () => {
    const text = await render();

    expect(text).toContain("does not sell it");
    expect(text).not.toContain("build a profile of you");
  });

  /** The subject the message opens with is read in the page's own language. */
  it("keeps the support subject and action in English", async () => {
    const text = await render();

    expect(mocks.supportMailtoHref).toHaveBeenCalledWith("Koqentra support");
    expect(text).toContain("Email support");
  });

  /**
   * **No address configured, no section.** The same behaviour as Settings: a
   * reader is not shown a link that goes nowhere.
   */
  it("omits the contact section when no address is configured", async () => {
    mocks.supportMailtoHref.mockReturnValue(null);

    const text = await render();

    expect(text).not.toContain("Email support");
    expect(text).toContain("Back to Koqentra");
  });

  it("keeps the footer link in English", async () => {
    const text = await render();

    expect(text).toContain("Back to Koqentra");
  });
});

describe("Japanese notice", () => {
  beforeEach(() => {
    signedInWith("user-ja", "ja");
  });

  it("says the writing goes to Anthropic", async () => {
    const text = await render();

    expect(text).toContain("Anthropic");
  });

  /** The limit is the claim: recent answers, not the whole history. */
  it("says at most the last twelve answers travel with it, not everything", async () => {
    const text = await render();

    expect(text).toContain("直近12件");
    expect(text).toContain("全履歴ではありません");
  });

  it("names what an answer can carry", async () => {
    const text = await render();

    expect(text).toContain("編集した場合はその文章");
    expect(text).toContain("抜粋");
  });

  it("says what a successful analysis stores", async () => {
    const text = await render();

    expect(text).toContain("保存");
    expect(text).toContain("投稿文");
  });

  it("says the post the AI first proposed is not overwritten", async () => {
    const text = await render();

    expect(text).toContain("上書きされません");
  });

  it("says it posts nothing anywhere", async () => {
    const text = await render();

    expect(text).toContain("自動投稿しません");
  });

  it("says the output may be wrong and should be checked before publishing", async () => {
    const text = await render();

    expect(text).toContain("誤っていることがあり");
    expect(text).toContain("公開する前に必ず確認");
  });

  it("says there is no way to delete Creator data and nothing expires it", async () => {
    const text = await render();

    expect(text).toContain("削除する手段はありません");
    expect(text).toContain("自動的に削除される仕組みもありません");
  });

  it("says deleting a worker does not delete Creator data", async () => {
    const text = await render();

    expect(text).toContain("ワーカーを削除しても、Creatorのデータは何も削除されません");
  });

  it("keeps the selling claim in the narrowed form", async () => {
    const text = await render();

    expect(text).toContain("販売しません");
  });

  it("localises the support subject, the support link and the footer", async () => {
    const text = await render();

    expect(mocks.supportMailtoHref).toHaveBeenCalledWith("Koqentra サポート");
    expect(text).toContain("メールで問い合わせる");
    expect(text).toContain("Koqentraに戻る");
  });
});

describe("promises nothing here could keep", () => {
  /**
   * Each of these describes behaviour that does not exist — in Koqentra or in
   * somebody else's service this page cannot speak for. Writing one down would
   * be worse than saying nothing.
   */
  const english = [
    "deleted immediately",
    "not used for training",
    "will be deleted after",
    "encrypted at rest",
    "data residency",
    "automatically deleted",
  ];

  it.each(english)("does not claim %o in English", async (claim) => {
    signedOut();

    const text = await render();

    expect(text.toLowerCase()).not.toContain(claim.toLowerCase());
  });

  /**
   * The same undertakings, in the language the translation could most easily
   * have invented them in. Kept to a short list rather than mirroring every
   * English phrase: this checks the translation added no promise, not that it
   * avoided a vocabulary.
   */
  const japanese = ["即時削除", "学習に使用しません", "暗号化", "データ所在地"];

  it.each(japanese)("does not claim %o in Japanese", async (claim) => {
    signedInWith("user-ja", "ja");

    const text = await render();

    expect(text).not.toContain(claim);
  });
});
