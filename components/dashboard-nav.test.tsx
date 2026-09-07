import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The bar every signed-in page carries, now with a third link.
 *
 * **Three links, an account name and a sign-out do not fit on a phone in one
 * row.** So the bar wraps rather than dropping anything: the links move to
 * their own row below `sm` and return to the single row above it. What is fixed
 * here is that nothing was removed to make room — sign out least of all — and
 * that the wrapping is actually configured rather than left to overflow.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getUserLanguage: vi.fn(),
  usePathname: vi.fn(),
}));

/**
 * **The links became a client component and are rendered for real here.** They
 * need the pathname, which only a browser has, so it is replaced — but the
 * component itself is not, because what these tests check is that the bar still
 * carries the same three destinations and labels after the split.
 */
vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));

vi.mock("@/auth", () => ({
  auth: mocks.auth,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));

const { DashboardNav } = await import("@/components/dashboard-nav");
const { t } = await import("@/lib/i18n");

const render = async () => renderToStaticMarkup(await DashboardNav());

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({
    user: { id: "user-1", email: "someone@example.com", name: "Someone" },
  });
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.usePathname.mockReset().mockReturnValue("/creator");
});

describe("where it can go", () => {
  /**
   * **The order is the whole of the hierarchy.** No link is styled as primary
   * and none is marked as current, so which one comes first is what says what
   * Koqentra is about — and it is the screen sign-in now opens on.
   */
  it("offers Creator, Workers and settings, in that order", async () => {
    const html = await render();

    const creator = html.indexOf('href="/creator"');
    const workers = html.indexOf('href="/dashboard"');
    const settings = html.indexOf('href="/dashboard/settings"');

    expect(creator).toBeGreaterThan(-1);
    expect(workers).toBeGreaterThan(creator);
    expect(settings).toBeGreaterThan(workers);
  });

  /**
   * **The Worker route did not move.** Everything behind `/dashboard` works
   * exactly as it did; the label and the position are what changed.
   */
  it("leaves every destination where it was", async () => {
    const html = await render();

    expect(html).toContain('href="/creator"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/dashboard/settings"');
  });

  it("names Creator in the account's language", async () => {
    expect(await render()).toContain(t("en", "nav.creator"));

    mocks.getUserLanguage.mockResolvedValue("ja");
    expect(await render()).toContain(t("ja", "nav.creator"));
  });

  /**
   * **Named for what it holds, not for the route it sits on.** A bar reading
   * "Dashboard" promises the whole product, and that stopped being true when
   * Creator became the first screen — so the label says Workers while the
   * address stays `/dashboard`.
   */
  it.each(["en", "ja"] as const)("names Workers in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);

    expect(await render()).toContain(t(language, "nav.workers"));
  });

  it("no longer calls that link the dashboard", async () => {
    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toContain(t("en", "nav.dashboard"));
  });
});

describe("what a third link must not cost", () => {
  it("keeps sign out", async () => {
    expect(await render()).toContain(t("en", "nav.signOut"));
  });

  it("keeps the account name", async () => {
    expect(await render()).toContain("Someone");
  });

  /**
   * Wrapping rather than overflowing is the whole mobile fix. Without it the
   * bar scrolls sideways on a 375px screen, which is where most of this will be
   * read.
   */
  it("wraps instead of overflowing on a narrow screen", async () => {
    const html = await render();

    expect(html).toContain("flex-wrap");
    expect(html).toContain("sm:flex-nowrap");
  });

  it("is still rendered on the server", async () => {
    expect(await render()).not.toContain("use client");
  });
});

/**
 * **The dictionary stays here.** The links became a client component so they
 * could read the pathname; taking a language with them would have pulled
 * `lib/i18n` — both dictionaries, every string in the product — into the
 * browser bundle of every signed-in page to render three words. The lookup
 * happens on this side and the resolved words are what cross.
 */
describe("where the words are looked up", () => {
  it.each(["en", "ja"] as const)("names all three links in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);

    const html = await render();

    for (const key of ["nav.creator", "nav.workers", "nav.settings"] as const) {
      expect(html).toContain(t(language, key));
    }
  });

  /**
   * A label that arrived as a key rather than a word would mean the client had
   * been handed the means to translate instead of the translation.
   */
  it("hands over words, not keys", async () => {
    const html = await render();

    expect(html).not.toContain("nav.creator");
    expect(html).not.toContain("nav.workers");
    expect(html).not.toContain("nav.settings");
  });
});

describe("which page it claims to be on", () => {
  /**
   * **The bar used to claim the wrong one, then none at all.**
   * `aria-current="page"` was hard-coded on the Worker link, so a screen reader
   * was told Dashboard was the current page while somebody stood on Creator or
   * Settings. Removing it left the bar accurate but silent; knowing the route
   * is what lets it be accurate and useful at once.
   *
   * The full route classification is checked where it lives, in
   * `dashboard-nav-links.test.tsx`. What matters here is that the split did not
   * lose it — that the server bar still renders links which know where they
   * are.
   */
  it("marks the section the reader is standing on", async () => {
    mocks.usePathname.mockReturnValue("/creator");

    expect(await render()).toContain('aria-current="page"');
  });

  it("claims nothing on a route it does not cover", async () => {
    mocks.usePathname.mockReturnValue("/privacy");

    expect(await render()).not.toContain("aria-current");
  });

  /** Never two at once, whichever section is current. */
  it("claims at most one", async () => {
    for (const pathname of ["/creator", "/dashboard", "/dashboard/settings"]) {
      mocks.usePathname.mockReturnValue(pathname);

      const html = await render();

      expect(html.match(/aria-current=/g) ?? []).toHaveLength(1);
    }
  });
});
