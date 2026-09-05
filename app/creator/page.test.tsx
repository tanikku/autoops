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
  getUserLanguage: vi.fn(),
  listCreatorReviewItems: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
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
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.listCreatorReviewItems.mockReset().mockResolvedValue([]);
});

describe("who it reads for", () => {
  /** Middleware guards the route; a page that trusted only that would be
      trusting an edit nobody has made yet. */
  it("asks who is signed in", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  it("reads the list and the language for that account", async () => {
    mocks.requireUserId.mockResolvedValue("user-9");

    await render();

    expect(mocks.listCreatorReviewItems).toHaveBeenCalledWith("user-9");
    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-9");
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
