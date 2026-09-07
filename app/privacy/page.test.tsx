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
const { generateMetadata } = await import("@/app/privacy/page");

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

    /**
     * **Twelve go individually, and the rest are not simply absent.**
     *
     * This used to say "not your whole history", which was true while older
     * answers fell out of the window and went nowhere. They are summarised now,
     * and that summary is sent — so the honest statement is which form each
     * kind of answer travels in, not that the older ones are withheld.
     */
    it("says recent answers travel with it, and how many", async () => {
      const text = await render();

      expect(text).toContain("twelve");
      expect(text).toContain("sent individually");
      expect(text).not.toContain("not your whole history");
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
  /** 12件は個別に、それより古い回答は要約として送られる。 */
  it("says at most the last twelve answers travel individually", async () => {
    const text = await render();

    expect(text).toContain("直近12件");
    expect(text).toContain("個別に送られるのは");
    expect(text).not.toContain("全履歴ではありません");
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

/**
 * Reading a page by its address, which is the one thing C1.9A adds to what
 * leaves this deployment.
 *
 * **A URL is not a paste with a different field.** Koqentra's own server
 * contacts a site the reader named, and that site sees a request it did not
 * get before. Every statement below is one somebody would be misled by if it
 * disappeared — and the two negatives are the ones a reader most needs, because
 * "does it send my login?" is the first question a fetch invites.
 */
describe("what fetching a page is said to do", () => {
  const english = [
    // Koqentra's server makes the request, not the reader's browser.
    "own server",
    "HTTP request",
    // What is not forwarded.
    "cookies",
    "not sent to that site",
    "authorization header",
    // Only public HTML.
    "public pages served as HTML",
    "require a sign-in are not fetched",
    "PDFs",
    // What reaches Anthropic, and what is kept.
    "sent to Anthropic",
    "stores that address",
    // What it still does not do.
    "does not post anything to that address",
  ];

  it.each(english)("says %o in English", async (phrase) => {
    signedOut();

    const text = await render();

    expect(text.toLowerCase()).toContain(phrase.toLowerCase());
  });

  const japanese = [
    "Koqentraのサーバー自身",
    "HTTPリクエスト",
    "Cookie",
    "送信されません",
    "Authorization",
    "HTMLとして公開されているページ",
    "サインインが必要なページは取得せず",
    "PDF",
    "Anthropicへ送信",
    "アドレス、読み取った本文",
    "他のどこにも投稿しません",
  ];

  it.each(japanese)("says %o in Japanese", async (phrase) => {
    signedInWith("user-ja", "ja");

    const text = await render();

    expect(text).toContain(phrase);
  });

  /**
   * **Precise about what a site does still receive.** An ordinary request
   * carries an address, a path and a user agent; claiming nothing at all is
   * sent would be a promise the transport does not keep.
   */
  it("does not claim the site is told nothing", async () => {
    signedOut();

    const text = await render();

    expect(text.toLowerCase()).not.toContain("sends nothing to");
    expect(text.toLowerCase()).not.toContain("no information is sent to");
  });

  it("does not claim the site is told nothing, in Japanese", async () => {
    signedInWith("user-ja", "ja");

    const text = await render();

    expect(text).not.toContain("何も送信しません");
    expect(text).not.toContain("一切送信されません");
  });

  /** Neither language may claim a standard nothing here demonstrates. */
  it.each(["robots.txt", "GDPR"])("does not claim %o", async (claim) => {
    signedOut();

    const text = await render();

    expect(text).not.toContain(claim);
  });
});

/**
 * The summary of older answers — a second thing sent to Anthropic, and a second
 * thing stored.
 *
 * **Older answers stopped simply falling out of the window.** They are
 * summarised instead, by a separate request, and the summary is kept and reused.
 * Both halves are new, so both are disclosed — and the summary's standing has
 * to be stated too, because a reader shown "Koqentra has a summary of you"
 * without being told it is an AI's inference would reasonably assume otherwise.
 */
describe("what the summary of older answers is said to be", () => {
  const english = [
    // Older answers are represented, not withheld.
    "summary of them",
    "generated by Anthropic",
    // The refresh is its own request, and what it carries.
    "separate request to Anthropic",
    "previous summary",
    // What it never carries.
    "never carries your",
    // Catch-up is incremental, and says so rather than claiming completeness.
    "a batch at a time",
    // What is stored — including which answers are already accounted for.
    "stores the summary, the number of older answers",
    "which of your older answers have already been incorporated",
    "the same answer is not incorporated twice",
    "holds no copy of what you wrote",
    // What it is, and what outranks it.
    "written by an AI, not by you",
    "can be wrong or incomplete",
    "take priority over it",
    // The limits that already applied, applying here too.
    "no way to edit, rebuild or delete it",
  ];

  it.each(english)("says %o in English", async (phrase) => {
    signedOut();

    expect((await render()).toLowerCase()).toContain(phrase.toLowerCase());
  });

  const japanese = [
    "まとめた要約",
    "Anthropicに生成させて保持し",
    "Anthropicへの別のリクエスト",
    "既存の要約がある場合はそれと",
    "含まれることはありません",
    "分割して取り込まれます",
    "何件の古い回答から作られたか",
    "どの古い回答をすでに要約へ取り込んだかの記録",
    "同じ回答を重複して要約へ取り込まない",
    "利用者が書いた内容は",
    "利用者本人ではなくAIが書いたもの",
    "誤っていたり不完全であったり",
    "優先されます",
    "編集・再作成・削除する手段はなく",
  ];

  it.each(japanese)("says %o in Japanese", async (phrase) => {
    signedInWith("user-ja", "ja");

    expect(await render()).toContain(phrase);
  });

  /**
   * **What the bookkeeping guarantees is one direction only.** The unique index
   * stops an answer being incorporated a second time; nothing promises that
   * every older answer is eventually incorporated at all. Catch-up happens a
   * batch at a time inside analyses somebody chooses to run, an answer too
   * large to send alone is never sent, and a provider failure simply leaves the
   * summary where it was. Wording that said "exactly once" would be reading a
   * service commitment into a database constraint.
   */
  it("promises no more than the bookkeeping actually guarantees", async () => {
    signedOut();

    const english = (await render()).toLowerCase();

    expect(english).toContain("the same answer is not incorporated twice");
    expect(english).not.toContain("exactly once");
    expect(english).not.toContain("none is skipped");
    expect(english).not.toContain("every older answer");

    signedInWith("user-ja", "ja");

    const japanese = await render();

    expect(japanese).toContain("同じ回答を重複して要約へ取り込まない");
    expect(japanese).not.toContain("ちょうど一度");
    expect(japanese).not.toContain("必ず一度");
    expect(japanese).not.toContain("取りこぼし");
  });

  /**
   * **The twelve are individual; the rest are summarised.** The old wording
   * said the whole history never travelled, which stopped being true.
   */
  it("distinguishes the twelve sent one by one from the rest", async () => {
    signedOut();

    const text = await render();

    expect(text).toContain("sent individually");
    expect(text).toContain("in place of the individual answers it covers");
    expect(text).not.toContain("not your whole history");
  });

  it("distinguishes them in Japanese too", async () => {
    signedInWith("user-ja", "ja");

    const text = await render();

    expect(text).toContain("個別に送られるのは");
    expect(text).toContain("代わりにその要約を");
    expect(text).not.toContain("全履歴ではありません");
  });

  /** Nothing here may promise controls that do not exist. */
  it.each([
    "delete your summary",
    "rebuild the summary",
    "edit the summary",
    "automatically deleted",
  ])("promises no %o", async (claim) => {
    signedOut();

    expect((await render()).toLowerCase()).not.toContain(claim.toLowerCase());
  });

  it("still says nothing is posted automatically", async () => {
    signedOut();

    expect((await render()).toLowerCase()).toContain(
      "does not post anything anywhere",
    );
  });
});

/**
 * What a browser tab and a search result say this page is.
 *
 * **The one public page that speaks Japanese used to title itself in English.**
 * The notice below has always followed the account's language while the title
 * above it did not, which left a document declaring `lang="ja"` and then
 * naming itself in English — the state a screen reader takes literally.
 *
 * **Driven through the real resolver.** The session and the stored language
 * are already replaced for the rendering tests above, so these go through
 * `getDocumentLanguage` as it actually runs rather than around it — which also
 * fixes that a signed-out visitor gets English without an account row being
 * read into existence.
 */
describe("what the tab says", () => {
  it("keeps the English title and description exactly as they were", async () => {
    signedOut();

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Privacy — Koqentra",
      description:
        "What Koqentra stores, where it goes, and what it does not do.",
    });
  });

  it("says the same thing in Japanese when the account reads Japanese", async () => {
    signedInWith("user-ja", "ja");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "プライバシー — Koqentra",
      description:
        "Koqentra が何を保存し、どこへ送られ、何をしないのかを説明します。",
    });
  });

  it("titles itself in English for a signed-in English account", async () => {
    signedInWith("user-en", "en");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Privacy — Koqentra",
    });
  });

  /**
   * **Not the opening sentence of the notice.** `intro` says what Koqentra
   * receives; this says what is kept, where it goes and what is not done. They
   * were separated because they answer different questions, and reusing one
   * for the other would have reworded the product to save a string.
   */
  it("does not reuse the opening sentence of the notice", async () => {
    signedOut();

    const { description } = await generateMetadata();

    expect(description).not.toContain("What Koqentra receives");
  });

  /** The product name is a name in both languages. */
  it("leaves the name untranslated in either language", async () => {
    signedOut();
    expect((await generateMetadata()).title).toContain("Koqentra");

    signedInWith("user-ja", "ja");
    expect((await generateMetadata()).title).toContain("Koqentra");
  });
});
