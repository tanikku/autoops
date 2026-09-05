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
  it("offers the dashboard, Creator and settings, in that order", async () => {
    const html = await render();

    const dashboard = html.indexOf('href="/dashboard"');
    const creator = html.indexOf('href="/creator"');
    const settings = html.indexOf('href="/dashboard/settings"');

    expect(dashboard).toBeGreaterThan(-1);
    expect(creator).toBeGreaterThan(dashboard);
    expect(settings).toBeGreaterThan(creator);
  });

  it("names Creator in the account's language", async () => {
    expect(await render()).toContain(t("en", "nav.creator"));

    mocks.getUserLanguage.mockResolvedValue("ja");
    expect(await render()).toContain(t("ja", "nav.creator"));
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
