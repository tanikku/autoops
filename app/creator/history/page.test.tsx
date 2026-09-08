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
  listCreatorHistoryPage: vi.fn(),
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
  listCreatorHistoryPage: mocks.listCreatorHistoryPage,
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

const render = async (
  query: Record<string, string | string[] | undefined> = {},
) =>
  renderToStaticMarkup(
    await CreatorHistoryPage({ searchParams: Promise.resolve(query) }),
  );

/** One page of answered analyses, as the read layer hands it over. */
const historyPage = (
  items: unknown[] = [],
  nextCursor: { analyzedAt: Date; contentItemId: string } | null = null,
) => ({ items, nextCursor });

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.listCreatorHistoryPage.mockReset().mockResolvedValue(historyPage());
});

describe("who it reads for", () => {
  it("asks who is signed in", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  it("reads the history, the language and the zone for that account", async () => {
    mocks.requireUserId.mockResolvedValue("user-9");

    await render();

    expect(mocks.listCreatorHistoryPage).toHaveBeenCalledWith("user-9", null);
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
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([item]));
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
    mocks.listCreatorHistoryPage.mockResolvedValue(
      historyPage([{ ...item, title: null }]),
    );

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
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([fromUrl()]));

    const html = await render();

    expect(html).toContain(t("en", "creator.source.page"));
    expect(html).toContain(PAGE);
    expect(html).toContain(`href="${PAGE}"`);
  });

  it("opens it away from the history, without a referrer, and lets it wrap", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([fromUrl()]));

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
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([item]));

    expect(await render()).not.toContain(t("en", "creator.source.page"));
  });

  /** The record is what was written down, not what the address says today. */
  it("shows the address without asking whether it still works", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([fromUrl()]));

    await render();

    expect(mocks.listCreatorHistoryPage).toHaveBeenCalledTimes(1);
  });

  it("leaves the timestamps exactly where they were", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([fromUrl()]));

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

/**
 * Reaching an answer older than the twenty this page shows.
 *
 * **The rows were always there; the route was not.** The read has always been
 * bounded to twenty, which is what keeps it one query — but nothing named the
 * twenty-first, so an answer somebody gave was kept and unreachable.
 *
 * **A position in the URL, not a page number.** The record grows at the top as
 * new analyses are answered; counting rows from the newest would shift under a
 * reader mid-way through.
 */
describe("reaching older answers", () => {
  const AT = new Date("2026-09-01T01:02:03.000Z");
  const OLDER = "Older answers";
  const LATEST = "Back to latest";

  it("reads the newest page when the address says nothing", async () => {
    await render();

    expect(mocks.listCreatorHistoryPage).toHaveBeenCalledWith(USER, null);
  });

  it("continues from the position the address names", async () => {
    await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(mocks.listCreatorHistoryPage).toHaveBeenCalledWith(USER, {
      analyzedAt: AT,
      contentItemId: "content-019",
    });
  });

  /**
   * **Both halves or neither.** The pair names a position in an ordering whose
   * tie-break is the id, so half of it is not a position. A broken link is a
   * broken link — the newest page is the honest answer, not a 404.
   */
  it.each([
    ["only a timestamp", { historyBefore: AT.toISOString() }],
    ["only an id", { historyBeforeId: "content-019" }],
    [
      "a timestamp that is not a date",
      { historyBefore: "last tuesday", historyBeforeId: "content-019" },
    ],
    [
      "a blank id",
      { historyBefore: AT.toISOString(), historyBeforeId: "   " },
    ],
    ["something else entirely", { page: "2" }],
  ])("falls back to the newest page given %s", async (_name, query) => {
    await render(query);

    expect(mocks.listCreatorHistoryPage).toHaveBeenCalledWith(USER, null);
  });

  it("offers a way further back when there is more", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(
      historyPage([item], { analyzedAt: AT, contentItemId: "content-019" }),
    );

    expect(await render()).toContain(OLDER);
  });

  it("offers none when the record ends here", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([item]));

    const html = await render();

    expect(html).not.toContain(OLDER);
    expect(html).not.toContain(LATEST);
  });

  it("offers the way back only once the reader has gone somewhere", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([item]));

    const html = await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(html).toContain(LATEST);
  });

  /** A middle page has somewhere to go in both directions. */
  it("offers both on a page with older answers behind it", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(
      historyPage([item], { analyzedAt: AT, contentItemId: "content-039" }),
    );

    const html = await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(html).toContain(LATEST);
    expect(html).toContain(OLDER);
  });

  /**
   * **A cursor page can legitimately be empty**, and somebody who has walked
   * back through the record still needs the way out — so the control is not
   * inside the empty state.
   */
  it("still offers the way back from an empty cursor page", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([]));

    const html = await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(html).toContain(LATEST);
  });

  /**
   * **Escaped by the framework, not by hand.** An ISO timestamp carries colons,
   * and a hand-built query string would put them in a URL unencoded.
   */
  it("carries the position in the address, encoded", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(
      historyPage([item], { analyzedAt: AT, contentItemId: "content-019" }),
    );

    const html = await render();

    expect(html).toContain("historyBefore=2026-09-01T01%3A02%3A03.000Z");
    expect(html).toContain("historyBeforeId=content-019");
    expect(html).toContain("/creator/history?");
  });

  it("sends the way back to the record with nothing appended", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(historyPage([item]));

    const html = await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(html).toContain('href="/creator/history"');
  });

  it.each(["en", "ja"] as const)("names both ways in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);
    mocks.listCreatorHistoryPage.mockResolvedValue(
      historyPage([item], { analyzedAt: AT, contentItemId: "content-039" }),
    );

    const html = await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(html).toContain(t(language, "creator.history.olderAnswers"));
    expect(html).toContain(t(language, "creator.history.backToLatest"));
  });

  /**
   * **Still a record, not a workspace.** Feedback is append-only, so there is
   * nothing here to undo or redo — and paging back through it must not have
   * quietly introduced somewhere to write from.
   */
  it("adds nothing that writes", async () => {
    mocks.listCreatorHistoryPage.mockResolvedValue(
      historyPage([item], { analyzedAt: AT, contentItemId: "content-019" }),
    );

    const html = await render();

    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<button");
  });

  it("still never reaches the provisioning boundary", async () => {
    await render({
      historyBefore: AT.toISOString(),
      historyBeforeId: "content-019",
    });

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });
});
