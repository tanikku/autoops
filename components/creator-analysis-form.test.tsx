import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the form may say, and what it must not.
 *
 * **The action is replaced, so nothing is submitted and nothing is sent.** What
 * is fixed here is the shape of the request the browser would build: two
 * fields, no owner, and none of the choices the application makes for itself.
 *
 * Also fixed are the two sentences that have to be in front of somebody at the
 * moment they hand over something unpublished — where it goes, and what their
 * earlier answers are used for.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/app/creator/actions", () => ({
  analyzeCreatorTextAction: vi.fn(),
  recordCreatorFeedbackAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { useActionResult } = vi.hoisted(() => ({ useActionResult: vi.fn() }));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult,
}));

const { CreatorAnalysisForm } = await import(
  "@/components/creator-analysis-form"
);
const { t } = await import("@/lib/i18n");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");

const render = (language = "en") =>
  renderToStaticMarkup(<CreatorAnalysisForm language={language} />);

describe("what the form asks for", () => {
  const html = render();

  it("asks for a title and a body, and labels which is optional", () => {
    expect(html).toContain('name="title"');
    expect(html).toContain('name="body"');
    expect(html).toContain(t("en", "creator.new.titleLabel"));
    expect(html).toContain(t("en", "creator.new.bodyLabel"));
    expect(html).toContain(t("en", "creator.new.titleOptional"));
  });

  it("requires the writing itself", () => {
    expect(html).toContain("required");
  });

  /**
   * **Everything else is either the session's to know or the application's to
   * decide.** A field naming an owner, a source, or a channel would be a claim
   * the server has to distrust anyway — so there is nothing to distrust.
   */
  it.each([
    "userId",
    "ownerId",
    "sourceKind",
    "sourceUrl",
    "targetChannel",
    "verdict",
    "model",
    "provider",
  ])("never sends %s", (name) => {
    expect(html).not.toContain(`name="${name}"`);
  });

  it("sends exactly two named fields", () => {
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);

    expect(names.sort()).toEqual(["body", "title"]);
  });
});

describe("the limits the box applies", () => {
  /**
   * Taken from the analyzer contract rather than written here, so the box stops
   * at the point a request would be refused. **A courtesy, not a check** — the
   * action and the service both measure again, and theirs decide.
   */
  it("stops at the lengths a request may carry", () => {
    const html = render();

    expect(html).toContain(`maxLength="${creatorAnalysisLimits.contentTitle}"`);
    expect(html).toContain(`maxLength="${creatorAnalysisLimits.contentBody}"`);
  });

  it("gives the writing a box worth pasting into", () => {
    expect(render()).toContain('rows="12"');
  });
});

describe("what somebody is told before they submit", () => {
  const html = render();

  /** Said where the decision is made, not only in a policy page. */
  it("says where the writing goes", () => {
    expect(html).toContain(t("en", "creator.new.privacyNote"));
    expect(html).toContain("Anthropic");
  });

  it("links to the full notice", () => {
    expect(html).toContain('href="/privacy"');
    expect(html).toContain(t("en", "creator.new.privacyLink"));
  });

  /**
   * **What past answers are actually for.** Context on the next analysis —
   * not a stored profile of somebody, which Koqentra does not build.
   */
  it("says what earlier answers are used for, without overclaiming", () => {
    expect(html).toContain(t("en", "creator.new.learningNote"));

    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\bmemory\b/i);
    expect(text).not.toMatch(/\blearns? (about )?you\b/i);
  });
});

describe("the words this side of the product uses", () => {
  it.each(["en", "ja"])("says neither Draft nor Run in %s", (language) => {
    const text = render(language).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
    expect(text).not.toContain("下書き");
    expect(text).not.toContain("実行");
  });

  it("calls the act analysis", () => {
    expect(render()).toContain(t("en", "creator.new.submit"));
  });

  it("speaks Japanese when the account does", () => {
    const html = render("ja");

    expect(html).toContain(t("ja", "creator.new.submit"));
    expect(html).toContain(t("ja", "creator.new.privacyNote"));
    expect(html).not.toContain(t("en", "creator.new.submit"));
  });
});

describe("where it goes afterwards", () => {
  /**
   * **The decisions are not in the answer.** They are in the database, and the
   * inbox is the screen that reads them — sending them back through a form's
   * state would put unpublished writing somewhere nobody asked for it.
   */
  it("sends the reader to the inbox on success", () => {
    useActionResult.mockClear();
    render();

    expect(useActionResult).toHaveBeenCalledWith(null, {
      redirectTo: "/creator",
    });
  });
});
