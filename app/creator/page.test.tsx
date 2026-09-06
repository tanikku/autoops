import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The inbox reads; it does not decide.
 *
 * Two things are worth fixing here and both are about what reaches a browser:
 * the list is read for the signed-in account and nobody else, and the whole of
 * a submitted piece never appears in the page — the read model hands over an
 * excerpt, and this is where a future edit could quietly start rendering the
 * body instead.
 *
 * The nav is replaced because it reaches `auth()`, which is a different
 * question from the one being asked.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  getUserLanguage: vi.fn(),
  getUserTimezone: vi.fn(),
  listCreatorReviewItems: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
}));
vi.mock("@/lib/users", () => ({
  getUserLanguage: mocks.getUserLanguage,
  getUserTimezone: mocks.getUserTimezone,
}));
vi.mock("@/lib/creator/review", () => ({
  listCreatorReviewItems: mocks.listCreatorReviewItems,
}));
vi.mock("@/components/dashboard-nav", () => ({
  DashboardNav: () => null,
}));
vi.mock("@/app/creator/actions", () => ({
  recordCreatorFeedbackAction: vi.fn(),
  analyzeCreatorTextAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: vi.fn(),
}));

const CreatorInboxPage = (await import("@/app/creator/page")).default;
const { t } = await import("@/lib/i18n");

const USER = "user-1";

const item = {
  contentItemId: "content-1",
  title: "An earlier piece",
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
    },
    {
      id: "decision-2",
      targetChannel: "reddit" as const,
      verdict: "skip" as const,
      reason: "No community configured.",
      postText: null,
    },
  ],
};

const render = async () => renderToStaticMarkup(await CreatorInboxPage());

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.listCreatorReviewItems.mockReset().mockResolvedValue([]);
});

describe("who it reads for", () => {
  /** Middleware guards the route; a page that trusted only that would be
      trusting an edit nobody has made yet. */
  it("asks who is signed in", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  it("reads the list, the language and the zone for that account", async () => {
    mocks.requireUserId.mockResolvedValue("user-9");

    await render();

    expect(mocks.listCreatorReviewItems).toHaveBeenCalledWith("user-9");
    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-9");
    expect(mocks.getUserTimezone).toHaveBeenCalledWith("user-9");
  });

  /** Looking at a queue must not be what creates an account row. */
  it("never reaches the provisioning boundary", async () => {
    await render();

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });
});

describe("with nothing waiting", () => {
  /** The ordinary state, and it reads as a finished queue rather than a fault. */
  it("says so, and says what would put something here", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.inbox.emptyTitle"));
    expect(html).toContain(t("en", "creator.inbox.emptyBody"));
  });

  it("still offers the way to start one", async () => {
    expect(await render()).toContain('href="/creator/new"');
  });
});

describe("with something waiting", () => {
  beforeEach(() => {
    mocks.listCreatorReviewItems.mockResolvedValue([item]);
  });

  it("names the inbox and offers an analysis", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.inbox.title"));
    expect(html).toContain(t("en", "creator.inbox.analyzeCta"));
  });

  it("shows the piece and how many answers it is waiting for", async () => {
    const html = await render();

    expect(html).toContain("An earlier piece");
    expect(html).toContain("2");
  });

  it("renders each channel's judgement", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.channel.x"));
    expect(html).toContain(t("en", "creator.channel.reddit"));
    expect(html).toContain("It stands on its own.");
    expect(html).toContain("No community configured.");
    expect(html).toContain("A short post.");
  });

  /**
   * **The excerpt is what the read model handed over.** If a future edit
   * started passing the body through instead, every stored word would be in the
   * page's payload — this is where that would show up.
   */
  it("shows the excerpt it was given, and no more", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([
      { ...item, sourceExcerpt: "A SHORT EXCERPT" },
    ]);

    const html = await render();

    expect(html).toContain("A SHORT EXCERPT");
    expect(html).not.toContain(USER);
  });

  it("calls an untitled piece untitled rather than blank", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([{ ...item, title: null }]);

    expect(await render()).toContain(t("en", "creator.inbox.untitled"));
  });

  it("speaks Japanese when the account does", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "creator.inbox.title"));
    expect(html).not.toContain(t("en", "creator.inbox.title"));
  });

  it("says neither Draft nor Run", async () => {
    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
  });
});

/**
 * Which analysis a heading belongs to.
 *
 * **The problem this answers happened in Production**: two submissions of the
 * same piece sat one above the other under identical titles, and nothing on the
 * screen said which was the newer. The moment is absolute and in the account's
 * own zone, because "3 minutes ago" reads better and does not tell them apart.
 */
describe("telling two analyses apart", () => {
  beforeEach(() => {
    mocks.listCreatorReviewItems.mockResolvedValue([item]);
  });

  it("dates the analysis in the account's zone", async () => {
    expect(await render()).toContain("2026-09-06 12:34 Asia/Tokyo");
  });

  it("reads the same instant differently in another zone", async () => {
    mocks.getUserTimezone.mockResolvedValue("UTC");

    expect(await render()).toContain("2026-09-06 03:34 UTC");
  });

  it("distinguishes two submissions of the same title", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([
      {
        ...item,
        contentItemId: "content-2",
        title: "テスト3",
        analyzedAt: new Date("2026-09-06T05:00:00.000Z"),
      },
      {
        ...item,
        contentItemId: "content-1",
        title: "テスト3",
        analyzedAt: new Date("2026-09-06T03:34:00.000Z"),
      },
    ]);

    const html = await render();

    expect(html).toContain("2026-09-06 14:00 Asia/Tokyo");
    expect(html).toContain("2026-09-06 12:34 Asia/Tokyo");
  });

  it.each(["en", "ja"])("uses no relative wording in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);

    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bago\b/i);
    expect(text).not.toContain("前");
  });
});

describe("the way to the record", () => {
  it("offers the history, without losing the way to start one", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([item]);

    const html = await render();

    expect(html).toContain('href="/creator/history"');
    expect(html).toContain('href="/creator/new"');
    expect(html).toContain(t("en", "creator.inbox.historyCta"));
  });

  /** The queue being empty is not a reason to hide what was already answered. */
  it("still offers a way to start one when nothing is waiting", async () => {
    expect(await render()).toContain('href="/creator/new"');
  });
});

/**
 * Where an analysis came from, when it came from somewhere.
 *
 * **Only for a page.** A pasted piece has no source to name, and an empty label
 * would read as a page that failed to load. The address shown is the one the
 * body was actually read from — after redirects — because that is the page the
 * decisions are about.
 */
describe("the source of an analysis", () => {
  const PAGE = "https://www.example.com/a-fairly-long-article-path/";

  const fromUrl = (url = PAGE) => ({
    ...item,
    source: { kind: "url" as const, url },
  });

  it("names the page and links to it", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([fromUrl()]);

    const html = await render();

    expect(html).toContain(t("en", "creator.source.page"));
    expect(html).toContain(PAGE);
    expect(html).toContain(`href="${PAGE}"`);
  });

  /** A new tab, and nothing about this page travels to the other one. */
  it("opens it away from the inbox, without a referrer", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([fromUrl()]);

    const link = (await render()).match(
      new RegExp(`<a[^>]*href="${PAGE}"[^>]*>`),
    )?.[0];

    expect(link).toBeDefined();
    expect(link).toContain('target="_blank"');
    expect(link).toContain("noreferrer");
    expect(link).toContain("noopener");
  });

  /**
   * A long URL is one unbroken token and would widen the page on a phone. The
   * `href` stays the whole address; only the drawing of it wraps.
   */
  it("lets a long address wrap rather than widening the page", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([fromUrl()]);

    const link = (await render()).match(
      new RegExp(`<a[^>]*href="${PAGE}"[^>]*>`),
    )?.[0];

    expect(link).toContain("break-all");
  });

  it("says nothing about a source for a pasted piece", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([item]);

    const html = await render();

    expect(html).not.toContain(t("en", "creator.source.page"));
    expect(html).not.toContain("href=\"https://");
  });

  it("names it in Japanese too", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.listCreatorReviewItems.mockResolvedValue([fromUrl()]);

    expect(await render()).toContain(t("ja", "creator.source.page"));
  });

  /** Reading a list is not a reason to contact anybody. */
  it("renders the address without fetching it", async () => {
    mocks.listCreatorReviewItems.mockResolvedValue([fromUrl()]);

    await render();

    expect(mocks.listCreatorReviewItems).toHaveBeenCalledTimes(1);
  });
});
