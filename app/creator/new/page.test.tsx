import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The page that hands a piece of writing over.
 *
 * **Rendering a form writes nothing**, so this asks for the session read-only.
 * The account row is brought into being by the action, once there is something
 * worth analysing — which is the ordering C1.4R fixed and this must not undo by
 * reaching for the provisioning boundary here.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  getUserLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
}));
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));
vi.mock("@/app/creator/actions", () => ({
  analyzeCreatorTextAction: vi.fn(),
  recordCreatorFeedbackAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: vi.fn(),
}));

const CreatorNewPage = (await import("@/app/creator/new/page")).default;
const { t } = await import("@/lib/i18n");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");

const render = async () => renderToStaticMarkup(await CreatorNewPage());

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
});

describe("who it renders for", () => {
  it("asks who is signed in", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  /** Looking at a form is not a reason to write an account row. */
  it("provisions nothing", async () => {
    await render();

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });

  it("reads the language for that account", async () => {
    mocks.requireUserId.mockResolvedValue("user-9");

    await render();

    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-9");
  });
});

describe("what it says", () => {
  it("names the act and describes it", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.new.title"));
    expect(html).toContain(t("en", "creator.new.description"));
  });

  /**
   * **A skip has to read as an answer before somebody sees one.** Arriving
   * expecting three posts per article would make the first skip look like a
   * failure.
   */
  it("says a skip is a normal answer", async () => {
    expect(t("en", "creator.new.description")).toContain(
      "Deciding against a channel is a normal answer",
    );
    expect(t("ja", "creator.new.description")).toContain(
      "見送りという答えも正常な結果です",
    );
  });

  it("carries the form, with its two fields and their limits", async () => {
    const html = await render();

    expect(html).toContain('name="title"');
    expect(html).toContain('name="body"');
    expect(html).toContain(`maxLength="${creatorAnalysisLimits.contentBody}"`);
  });

  it("tells somebody where their writing goes, and links the notice", async () => {
    const html = await render();

    expect(html).toContain("Anthropic");
    expect(html).toContain('href="/privacy"');
  });

  it("says what past answers are used for", async () => {
    expect(await render()).toContain(t("en", "creator.new.learningNote"));
  });

  it("speaks Japanese when the account does", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "creator.new.title"));
    expect(html).not.toContain(t("en", "creator.new.submit"));
  });

  it("says neither Draft nor Run", async () => {
    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
  });
});
