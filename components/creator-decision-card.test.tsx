import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What one judgement offers a person, and what it asks for back.
 *
 * **The action is never executed here.** It is replaced, so nothing reaches a
 * database and nothing reaches Anthropic; what is fixed is the markup — the
 * words, the hidden fields, and which buttons exist for which verdict.
 *
 * Rendering to a string is the smallest way to ask: no DOM, no renderer beyond
 * the one React already ships for the server, and no new dependency. It cannot
 * press a button, so what happens *after* a submission is not fixed here.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
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

const { CreatorDecisionCard } = await import(
  "@/components/creator-decision-card"
);
const { t } = await import("@/lib/i18n");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");

type Decision = Parameters<typeof CreatorDecisionCard>[0]["decision"];

const recommended: Decision = {
  id: "decision-1",
  targetChannel: "x",
  verdict: "recommend",
  reason: "It stands on its own.",
  postText: "A short post worth reading.",
};

const skipped: Decision = {
  id: "decision-2",
  targetChannel: "reddit",
  verdict: "skip",
  reason: "No community has been configured.",
  postText: null,
};

function render(decision: Decision, language = "en") {
  return renderToStaticMarkup(
    <CreatorDecisionCard decision={decision} language={language} />,
  );
}

/**
 * A dictionary string as it appears once React has written it out.
 *
 * "Edit & use" leaves the renderer as `Edit &amp; use`. Weakening the assertion
 * to a substring would stop it noticing the label changing, so the expectation
 * is escaped the same way the output is instead.
 */
const asRendered = (text: string) => text.replace(/&/g, "&amp;");

describe("a recommendation", () => {
  const html = render(recommended);

  it("says which channel, and that it is recommended", () => {
    expect(html).toContain(t("en", "creator.channel.x"));
    expect(html).toContain(t("en", "creator.verdict.recommend"));
  });

  it("gives the reason", () => {
    expect(html).toContain("It stands on its own.");
  });

  it("shows the post itself, under that name", () => {
    expect(html).toContain(t("en", "creator.postText"));
    expect(html).toContain("A short post worth reading.");
  });

  it("offers all three answers", () => {
    expect(html).toContain(t("en", "creator.feedback.useAsIs"));
    expect(html).toContain(asRendered(t("en", "creator.feedback.editAndUse")));
    expect(html).toContain(t("en", "creator.feedback.reject"));
  });
});

describe("a skip", () => {
  const html = render(skipped);

  it("says which channel, and that it is a skip", () => {
    expect(html).toContain(t("en", "creator.channel.reddit"));
    expect(html).toContain(t("en", "creator.verdict.skip"));
  });

  it("gives the reason", () => {
    expect(html).toContain("No community has been configured.");
  });

  /** There was never a post, so there is nothing to show and nothing to edit. */
  it("shows no post text and no empty placeholder for one", () => {
    expect(html).not.toContain(t("en", "creator.postText"));
  });

  it("does not offer to edit what was never written", () => {
    expect(html).not.toContain(asRendered(t("en", "creator.feedback.editAndUse")));
  });

  /**
   * **Agreeing with a skip and agreeing with a recommendation are different
   * sentences.** Both send `approve`; asking the reader to work that out from a
   * shared label would be asking them to think in the database's words.
   */
  it("asks its own question rather than the recommendation's", () => {
    expect(html).toContain(t("en", "creator.feedback.agreeWithSkip"));
    expect(html).toContain(t("en", "creator.feedback.wouldPost"));
    expect(html).not.toContain(t("en", "creator.feedback.useAsIs"));
  });
});

describe("what a submission carries", () => {
  /**
   * **The decision, and nothing about who is asking.** A form naming an owner
   * would be naming a tenant the server has to distrust anyway — and the server
   * takes the session's, so a field here could only ever be noise or an attempt.
   */
  it("names the decision and never an owner", () => {
    const html = render(recommended);

    expect(html).toContain('name="editorialDecisionId"');
    expect(html).toContain('value="decision-1"');
    expect(html).not.toContain('name="userId"');
    expect(html).not.toContain('name="ownerId"');
  });

  it.each([
    ["approve", recommended],
    ["reject", recommended],
    ["approve", skipped],
    ["reject", skipped],
  ])("submits %s for a %o decision", (action, decision) => {
    expect(render(decision as Decision)).toContain(`value="${action}"`);
  });

  /** No reason box in C1.5: the first inbox is meant to be one tap. */
  it("asks for no written reason", () => {
    expect(render(recommended)).not.toContain('name="reason"');
    expect(render(skipped)).not.toContain('name="reason"');
  });

  /**
   * **One form, one submit button.** `FeedbackForm` used to append a button of
   * its own on top of whatever `children` supplied, which meant any branch
   * passing its own — the edit box does — rendered two. Counting them per form
   * is what would have caught it, so it is counted here.
   */
  it.each([
    ["a recommendation", recommended, 2],
    ["a skip", skipped, 2],
  ])("gives %s one submit button per form", (_name, decision, forms) => {
    const html = render(decision as Decision);
    const submits = html.match(/<button type="submit"/g) ?? [];
    const openedForms = html.match(/<form /g) ?? [];

    expect(openedForms).toHaveLength(forms);
    expect(submits).toHaveLength(forms);
  });
});

describe("the words this side of the product uses", () => {
  /**
   * **"Draft" and "run" already mean other things in Koqentra.** A worker draft
   * is a proposal for settings; a run is one execution. Using either here would
   * make every sentence about those ambiguous — so the reader gets "post text"
   * and "analyze" instead. The column is still `draftBody`; that is the
   * database's business.
   */
  it.each([
    ["en", recommended],
    ["ja", recommended],
    ["en", skipped],
    ["ja", skipped],
  ])("says neither Draft nor Run in %s", (language, decision) => {
    const html = render(decision as Decision, language);
    const text = html.replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
    expect(text).not.toContain("下書き");
    expect(text).not.toContain("実行");
  });

  it("speaks Japanese when the account does", () => {
    const html = render(recommended, "ja");

    expect(html).toContain(t("ja", "creator.postText"));
    expect(html).toContain(t("ja", "creator.feedback.useAsIs"));
    expect(html).not.toContain(t("en", "creator.feedback.useAsIs"));
  });
});

describe("long-form on a small screen", () => {
  /**
   * A long piece is meant to be read before it is agreed to, so nothing is
   * cut — but one of them must not push every other card off the page, and an
   * unbroken URL must not widen it sideways on a phone.
   */
  it("keeps a long post scrollable rather than shortening it", () => {
    const long = "A sentence that goes on. ".repeat(400);
    const html = render({
      ...recommended,
      targetChannel: "longform",
      postText: long,
    });

    expect(html).toContain(long);
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("break-words");
    expect(html).toContain("whitespace-pre-wrap");
  });
});

describe("the edit box, when it is opened", () => {
  /**
   * It is closed on a first render, so this fixes the limit the component would
   * apply rather than the box itself — the value comes from the analyzer
   * contract instead of being written here twice.
   */
  it("would hold the same length the history can carry", () => {
    expect(creatorAnalysisLimits.feedbackEditedBody).toBe(20_000);
  });

  it("starts closed", () => {
    expect(render(recommended)).not.toContain('name="editedBody"');
  });
});
