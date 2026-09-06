import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The account settings page, now that it reads a Creator profile too.
 *
 * **Rendering it writes nothing.** The profile row is created by the save
 * below the form, or by an analysis — never by somebody opening this page. An
 * account that has never analysed anything must reach a working form, which is
 * what `EMPTY_CREATOR_PROFILE` is for and what the provisioning assertion here
 * protects.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  readCreatorProfile: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
}));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/creator/repository", () => ({
  readCreatorProfile: mocks.readCreatorProfile,
}));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));
vi.mock("@/app/dashboard/settings/actions", () => ({
  updateTimezoneAction: vi.fn(),
  updateLanguageAction: vi.fn(),
  updateCreatorPreferencesAction: vi.fn(),
}));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: vi.fn(),
}));

const SettingsPage = (await import("@/app/dashboard/settings/page")).default;
const { t } = await import("@/lib/i18n");

const STORED = {
  audience: "Solo founders shipping alone",
  goals: "Be useful, not loud",
  voiceInstructions: "Plain sentences. No exclamation marks.",
};

const render = async () => renderToStaticMarkup(await SettingsPage());

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.readCreatorProfile.mockReset().mockResolvedValue(STORED);
});

describe("who it reads for", () => {
  it("reads the profile for the signed-in account", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
    expect(mocks.readCreatorProfile).toHaveBeenCalledWith("user-1");
  });

  /** **Opening a page must not bring an account row into being.** */
  it("never reaches the provisioning boundary", async () => {
    await render();

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });
});

describe("the Creator preferences section", () => {
  it("shows the stored values in the form", async () => {
    const html = await render();

    expect(html).toContain(t("en", "settings.creator.title"));
    expect(html).toContain("Solo founders shipping alone");
    expect(html).toContain("Be useful, not loud");
    expect(html).toContain("Plain sentences. No exclamation marks.");
  });

  it("renders in the language the account reads", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "settings.creator.title"));
    expect(html).not.toContain(t("en", "settings.creator.title"));
  });

  /** An account with no row yet gets an empty form, not an error. */
  it("renders for an account that has stated nothing", async () => {
    mocks.readCreatorProfile.mockResolvedValue({
      audience: "",
      goals: "",
      voiceInstructions: "",
    });

    const html = await render();

    expect(html).toContain(t("en", "settings.creator.title"));
    expect(html).toContain('name="audience"');
  });

  /**
   * After Language, where the page's own order puts it. The Support section
   * below is absent unless an address is configured, so it is not part of
   * what a render can be held to here.
   */
  it("sits after the Language section", async () => {
    const html = await render();
    const creator = html.indexOf(t("en", "settings.creator.title"));

    expect(html.indexOf(t("en", "settings.language.title"))).toBeLessThan(
      creator,
    );
  });
});
