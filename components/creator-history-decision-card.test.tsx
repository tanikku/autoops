import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What a record of an answer is allowed to show, and what it must not offer.
 *
 * Two properties matter more than the rest. **It changes nothing** — feedback
 * is append-only, so there is no button, no form and no action here; a screen
 * offering to rewrite an answer would be offering something the rest of the
 * product refuses. And **it says what somebody chose in their own words**,
 * never the stored value: `approve` means "post this" against a recommendation
 * and "yes, leave it" against a skip.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

const { CreatorHistoryDecisionCard } = await import(
  "@/components/creator-history-decision-card"
);
const { t } = await import("@/lib/i18n");

type Decision = Parameters<typeof CreatorHistoryDecisionCard>[0]["decision"];

const ANSWERED_AT = new Date("2026-09-06T03:45:00.000Z");

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision-1",
    targetChannel: "x",
    verdict: "recommend",
    reason: "It stands on its own.",
    postText: "A short post worth reading.",
    action: "approve",
    editedPostText: null,
    answeredAt: ANSWERED_AT,
    ...overrides,
  };
}

function render(
  overrides: Partial<Decision> = {},
  language = "en",
  timezone = "Asia/Tokyo",
): string {
  return renderToStaticMarkup(
    <CreatorHistoryDecisionCard
      decision={decision(overrides)}
      language={language}
      timezone={timezone}
    />,
  );
}

describe("what the judgement was", () => {
  it("names the channel, the verdict and the reason", () => {
    const html = render();

    expect(html).toContain(t("en", "creator.channel.x"));
    expect(html).toContain(t("en", "creator.verdict.recommend"));
    expect(html).toContain("It stands on its own.");
  });

  it("names a skip as a skip", () => {
    const html = render({ verdict: "skip", postText: null, action: "approve" });

    expect(html).toContain(t("en", "creator.verdict.skip"));
    expect(html).not.toContain(t("en", "creator.verdict.recommend"));
  });
});

describe("the two texts", () => {
  it("shows what Koqentra proposed", () => {
    const html = render();

    expect(html).toContain(t("en", "creator.postText"));
    expect(html).toContain("A short post worth reading.");
  });

  /**
   * **Both halves, side by side.** The proposal is not overwritten by the
   * rewrite, and seeing the pair is the whole reason to look one of these up.
   */
  it("shows the rewrite alongside the proposal on an edit", () => {
    const html = render({
      action: "edit",
      editedPostText: "What I actually posted.",
    });

    expect(html).toContain("A short post worth reading.");
    expect(html).toContain("What I actually posted.");
    expect(html).toContain(t("en", "creator.history.yourPostText"));
  });

  it("shows no rewrite when there was none", () => {
    const html = render();

    expect(html).not.toContain(t("en", "creator.history.yourPostText"));
  });

  /** There was never a post, so there is nothing to show and no empty slot. */
  it("shows no post text for a skip", () => {
    const html = render({ verdict: "skip", postText: null });

    expect(html).not.toContain(t("en", "creator.postText"));
    expect(html).not.toContain(t("en", "creator.history.yourPostText"));
  });
});

/**
 * **The stored value is not the sentence.** These are the same five phrases the
 * learning panel uses, and none of them is "copied and used": answers recorded
 * before the clipboard handoff existed are stored as `approve` too, and calling
 * those copied would put an event in the record that never happened.
 */
describe("what somebody chose, in their words", () => {
  it.each([
    ["recommend", "approve", "creator.learning.action.usedAsIs"],
    ["recommend", "edit", "creator.learning.action.editedAndUsed"],
    ["recommend", "reject", "creator.learning.action.rejected"],
    ["skip", "approve", "creator.learning.action.agreedWithSkip"],
    ["skip", "reject", "creator.learning.action.wouldPost"],
  ] as const)("reads %s + %s as its own answer", (verdict, action, key) => {
    const html = render({
      verdict,
      action,
      postText: verdict === "recommend" ? "A short post worth reading." : null,
      editedPostText: action === "edit" ? "What I actually posted." : null,
    });

    expect(html).toContain(t("en", key));
    expect(html).toContain(t("en", "creator.learning.youLabel"));
  });

  /**
   * **Checked in Japanese, where an internal value would be unmistakable.**
   * English cannot carry this: "Rejected" legitimately contains "reject".
   */
  it("never prints a stored value on a Japanese page", () => {
    const text = render(
      { action: "edit", editedPostText: "編集後の文章" },
      "ja",
    ).replace(/<[^>]*>/g, " ");

    for (const stored of ["approve", "edit", "reject", "recommend", "skip"]) {
      expect(text.toLowerCase()).not.toContain(stored);
    }
  });

  it.each(["en", "ja"])("never calls an old approval a copy in %s", (language) => {
    const text = render({}, language).replace(/<[^>]*>/g, " ");

    expect(text).not.toContain(t(language, "creator.feedback.copyAndUse"));
  });
});

describe("when it was answered", () => {
  it("says so, in the account's zone", () => {
    const html = render({}, "en", "Asia/Tokyo");

    expect(html).toContain("2026-09-06 12:45 Asia/Tokyo");
  });

  it("reads the same instant differently in another zone", () => {
    expect(render({}, "en", "UTC")).toContain("2026-09-06 03:45 UTC");
  });

  /** Absolute, because the point is telling two analyses apart. */
  it.each(["en", "ja"])("uses no relative wording in %s", (language) => {
    const text = render({}, language).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bago\b/i);
    expect(text).not.toContain("前");
  });
});

describe("what it does not offer", () => {
  /** Feedback is append-only: there is nothing here to undo, redo or delete. */
  it("has no button and no form", () => {
    const html = render({ action: "edit", editedPostText: "Something." });

    expect(html.match(/<button/g) ?? []).toHaveLength(0);
    expect(html.match(/<form/g) ?? []).toHaveLength(0);
    expect(html).not.toContain("<input");
  });

  it("names no owner", () => {
    const html = render();

    expect(html).not.toContain("userId");
    expect(html).not.toContain("ownerId");
    expect(html).not.toContain("creatorProfileId");
  });
});

describe("long text on a small screen", () => {
  it("keeps a long post scrollable rather than shortening it", () => {
    const long = "A sentence that goes on. ".repeat(400);
    const html = render({ postText: long });

    expect(html).toContain(long);
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("break-words");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("writes no fixed width anywhere", () => {
    const html = render();

    expect(html).not.toMatch(/style="[^"]*width/);
    expect(html).not.toMatch(/w-\[\d/);
  });

  it("lets the answer line wrap", () => {
    expect(render()).toContain("flex-wrap");
  });
});
