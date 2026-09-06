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
}));

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

describe("which page it claims to be on", () => {
  /**
   * **It claims none, and that is the fix.** `aria-current="page"` was
   * hard-coded on the Dashboard link, so a screen reader was told Dashboard was
   * the current page while somebody stood on `/creator` or Settings — a wrong
   * answer stated confidently, which is worse than no answer.
   *
   * Saying nothing is accurate until the bar knows its own route. Doing that
   * properly needs the pathname or a prop from every page, and that is a design
   * question rather than something to guess at inside a correctness patch.
   */
  it("marks no link as the current page", async () => {
    expect(await render()).not.toContain("aria-current");
  });
});
