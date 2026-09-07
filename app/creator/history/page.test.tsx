import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The history reads; it never changes anything.
 *
 * Three things are worth fixing here. The list is read for the signed-in
 * account and nobody else. **Nothing on the page can be pressed** — feedback is
 * append-only, so a form or an action appearing here would be a way to rewrite
 * a record. And **opening it writes nothing**: looking at what happened must
 * not be what brings an account row into being.
 */

const mocks = vi.hoisted(() => ({
  getDocumentLanguage: vi.fn(),
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  getUserLanguage: vi.fn(),
  getUserTimezone: vi.fn(),
  listCreatorHistoryItems: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/i18n/server", () => ({
  getDocumentLanguage: mocks.getDocumentLanguage,
}));
vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
}));
vi.mock("@/lib/users", () => ({
  getUserLanguage: mocks.getUserLanguage,
  getUserTimezone: mocks.getUserTimezone,
}));
vi.mock("@/lib/creator/review", () => ({
  listCreatorHistoryItems: mocks.listCreatorHistoryItems,
}));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));

const CreatorHistoryPage = (await import("@/app/creator/history/page")).default;
const { generateMetadata } = await import("@/app/creator/history/page");
const { t } = await import("@/lib/i18n");

const USER = "user-1";

const item = {
  contentItemId: "content-1",
  title: "テスト3",
  sourceExcerpt: "The opening lines of an earlier piece…",
  analyzedAt: new Date("2026-09-06T03:34:00.000Z"),
  // Pasted by default, so the source block stays out of the existing tests.
  source: { kind: "text" as const },
  decisions: [
    {
      id: "decision-1",
      targetChannel: "x" as const,
      verdict: "recommend" as const,
      reason: "It stands on its own.",
      postText: "A short post.",
      action: "edit" as const,
      editedPostText: "What I actually posted.",
      answeredAt: new Date("2026-09-06T03:45:00.000Z"),
    },
  ],
};

const render = async () => renderToStaticMarkup(await CreatorHistoryPage());

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.listCreatorHistoryItems.mockReset().mockResolvedValue([]);
});

describe("who it reads for", () => {
  it("asks who is signed in", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  it("reads the history, the language and the zone for that account", async () => {
    mocks.requireUserId.mockResolvedValue("user-9");

    await render();

    expect(mocks.listCreatorHistoryItems).toHaveBeenCalledWith("user-9");
    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-9");
    expect(mocks.getUserTimezone).toHaveBeenCalledWith("user-9");
  });

  /** **Reading a record must not create an account row.** */
  it("never reaches the provisioning boundary", async () => {
    await render();

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });
});

describe("with nothing answered yet", () => {
  it("says so, and says what would put something here", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.history.emptyTitle"));
    expect(html).toContain(t("en", "creator.history.emptyBody"));
  });

  it("offers the way back to the queue", async () => {
    expect(await render()).toContain('href="/creator"');
  });
});

describe("with something answered", () => {
  beforeEach(() => {
    mocks.listCreatorHistoryItems.mockResolvedValue([item]);
  });

  it("names the screen and says what it holds", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.history.title"));
    expect(html).toContain(t("en", "creator.history.description"));
  });

  /**
   * **The point of the whole checkpoint.** Two submissions of the same piece
   * are two identical headings otherwise.
   */
  it("dates the analysis, absolutely, in the account's zone", async () => {
    expect(await render()).toContain("2026-09-06 12:34 Asia/Tokyo");
  });

  it("dates the answer separately from the analysis", async () => {
    expect(await render()).toContain("2026-09-06 12:45 Asia/Tokyo");
  });

  it("says how many judgements were answered", async () => {
    const html = await render();

    expect(html).toContain(
      t("en", "creator.history.answeredCount", { count: "1" }),
    );
  });

  /** The same piece can be on both screens, and that is not a duplicate. */
  it("explains why a piece may also be in the inbox", async () => {
    expect(await render()).toContain(t("en", "creator.history.pendingNote"));
  });

  it("shows the piece, the proposal and the rewrite", async () => {
    const html = await render();

    expect(html).toContain("テスト3");
    expect(html).toContain("The opening lines of an earlier piece…");
    expect(html).toContain("A short post.");
    expect(html).toContain("What I actually posted.");
  });

  it("offers both ways back", async () => {
    const html = await render();

    expect(html).toContain('href="/creator"');
    expect(html).toContain('href="/creator/new"');
  });

  /** Append-only: there is nothing here to undo, redo, delete or re-answer. */
  it("offers nothing to press", async () => {
    const html = await render();

    expect(html.match(/<form/g) ?? []).toHaveLength(0);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  it("speaks Japanese when the account does", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "creator.history.title"));
    expect(html).not.toContain(t("en", "creator.history.title"));
  });

  it("calls an untitled piece untitled rather than blank", async () => {
    mocks.listCreatorHistoryItems.mockResolvedValue([
      { ...item, title: null },
    ]);

    expect(await render()).toContain(t("en", "creator.inbox.untitled"));
  });

  /**
   * "Draft" and "run" already mean other things in Koqentra, and this screen
   * is about neither.
   */
  it.each(["en", "ja"])("says neither Draft nor Run in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);

    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
    expect(text).not.toContain("下書き");
    expect(text).not.toContain("実行");
  });
});

/**
 * Where an answered analysis came from.
 *
 * The same rule as the inbox, on the screen that looks back: an address only
 * where there was one, and the address the body was actually read from.
 */
describe("the source of an answered analysis", () => {
  const PAGE = "https://www.example.com/a-fairly-long-article-path/";

  const fromUrl = () => ({
    ...item,
    source: { kind: "url" as const, url: PAGE },
  });

  it("names the page and links to it", async () => {
    mocks.listCreatorHistoryItems.mockResolvedValue([fromUrl()]);

    const html = await render();

    expect(html).toContain(t("en", "creator.source.page"));
    expect(html).toContain(PAGE);
    expect(html).toContain(`href="${PAGE}"`);
  });

  it("opens it away from the history, without a referrer, and lets it wrap", async () => {
    mocks.listCreatorHistoryItems.mockResolvedValue([fromUrl()]);

    const link = (await render()).match(
      new RegExp(`<a[^>]*href="${PAGE}"[^>]*>`),
    )?.[0];

    expect(link).toBeDefined();
    expect(link).toContain('target="_blank"');
    expect(link).toContain("noreferrer");
    expect(link).toContain("noopener");
    expect(link).toContain("break-all");
  });

  it("says nothing about a source for a pasted piece", async () => {
    mocks.listCreatorHistoryItems.mockResolvedValue([item]);

    expect(await render()).not.toContain(t("en", "creator.source.page"));
  });

  /** The record is what was written down, not what the address says today. */
  it("shows the address without asking whether it still works", async () => {
    mocks.listCreatorHistoryItems.mockResolvedValue([fromUrl()]);

    await render();

    expect(mocks.listCreatorHistoryItems).toHaveBeenCalledTimes(1);
  });

  it("leaves the timestamps exactly where they were", async () => {
    mocks.listCreatorHistoryItems.mockResolvedValue([fromUrl()]);

    const html = await render();

    expect(html).toContain("2026-09-06 12:34 Asia/Tokyo");
    expect(html).toContain("2026-09-06 12:45 Asia/Tokyo");
  });
});

/**
 * What a browser tab and a search result say this screen is.
 *
 * **The document declares a language and the title has to be in it.** The root
 * layout writes the account's language onto `<html>`; a title left in English
 * under `lang="ja"` is the one part of the page contradicting the attribute a
 * screen reader chooses its voice from.
 *
 * **The resolver is replaced, not re-tested.** Which language a request is in
 * is settled in `lib/i18n/server.test.ts`; what is checked here is only the
 * mapping from a language to the two strings — including that the English
 * wording is exactly what it has always been, since a correctness fix must not
 * quietly reword the product.
 */
describe("what the tab says", () => {
  it("keeps the English title and description exactly as they were", async () => {
    mocks.getDocumentLanguage.mockResolvedValue("en");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Answer history — Koqentra",
      description: "The judgements you have already answered.",
    });
  });

  it("says the same thing in Japanese when the account reads Japanese", async () => {
    mocks.getDocumentLanguage.mockResolvedValue("ja");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: `${t("ja", "creator.history.title")} — Koqentra`,
      description: t("ja", "creator.history.metadataDescription"),
    });
  });

  /** The product name is a name in both languages. See the i18n parity test. */
  it("leaves the name untranslated in either language", async () => {
    for (const language of ["en", "ja"] as const) {
      mocks.getDocumentLanguage.mockResolvedValue(language);

      expect((await generateMetadata()).title).toContain("Koqentra");
    }
  });
});
