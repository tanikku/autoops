import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the panel is allowed to say, and what it must not.
 *
 * Two properties matter more than the rest. **It says only what happened** —
 * no sentence here is a conclusion drawn about somebody, because Koqentra
 * derives none, and a panel implying otherwise would be believed. And **it is
 * not a transcript**: the reasons, the proposed posts and the edits all reach
 * the model, but rendering twelve of them would bury the form underneath a
 * history nobody asked to re-read.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

const { CreatorLearningContext } = await import(
  "@/components/creator-learning-context"
);
const { t } = await import("@/lib/i18n");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");

type Props = Parameters<typeof CreatorLearningContext>[0];
type Entry = Props["feedback"][number];

const EMPTY_PROFILE: Props["profile"] = {
  audience: "",
  goals: "",
  voiceInstructions: "",
};

const PROFILE: Props["profile"] = {
  audience: "Solo founders shipping alone",
  goals: "Be useful, not loud",
  voiceInstructions: "Plain sentences. No exclamation marks.",
};

/** One past answer, with only what a test cares about spelled out. */
function answer(overrides: Partial<Entry> = {}): Entry {
  return {
    targetChannel: "x",
    verdict: "recommend",
    decisionReason: "SECRET-DECISION-REASON",
    draftBody: "SECRET-DRAFT",
    action: "approve",
    editedBody: null,
    feedbackReason: null,
    contentTitle: "An earlier piece",
    contentExcerpt: "The opening lines of an earlier piece.",
    ...overrides,
  };
}

function render(
  overrides: Partial<Props> = {},
  language = "en",
): string {
  return renderToStaticMarkup(
    <CreatorLearningContext
      profile={EMPTY_PROFILE}
      memory={null}
      feedback={[]}
      language={language}
      {...overrides}
    />,
  );
}

describe("how it sits on the page", () => {
  /** Collapsed natively: no state, no hydration, no client bundle. */
  it("collapses without JavaScript", () => {
    const html = render();

    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain(t("en", "creator.learning.title"));
  });

  it("says what it is showing", () => {
    expect(render()).toContain(t("en", "creator.learning.description"));
  });
});

describe("the stated preferences", () => {
  it("shows all three, as they were written", () => {
    const html = render({ profile: PROFILE });

    expect(html).toContain(t("en", "creator.learning.audience"));
    expect(html).toContain(t("en", "creator.learning.goals"));
    expect(html).toContain(t("en", "creator.learning.voice"));
    expect(html).toContain("Solo founders shipping alone");
    expect(html).toContain("Be useful, not loud");
    expect(html).toContain("Plain sentences. No exclamation marks.");
  });

  it("says so when nothing has been stated", () => {
    const html = render({ profile: EMPTY_PROFILE });
    const notSet = html.split(t("en", "creator.learning.notSet")).length - 1;

    expect(notSet).toBe(3);
  });

  /**
   * **Trimmed to decide, never to store.** Whitespace reads as nothing set;
   * what the analyzer receives is untouched by the display.
   */
  it("treats whitespace as nothing stated", () => {
    const html = render({
      profile: { audience: "   ", goals: "\n\t", voiceInstructions: "" },
    });

    expect(html.split(t("en", "creator.learning.notSet")).length - 1).toBe(3);
  });

  /** The column names are the database's business, not the reader's. */
  it("shows no database field names", () => {
    const text = render({ profile: PROFILE }).replace(/<[^>]*>/g, " ");

    expect(text).not.toContain("voiceInstructions");
    expect(text).not.toContain("audience");
    expect(text).not.toContain("goals");
  });
});

describe("how many answers it says are used", () => {
  it("counts nothing when there is nothing", () => {
    const html = render({ feedback: [] });

    expect(html).toContain(t("en", "creator.learning.noAnswers"));
  });

  /**
   * The ceiling is read from the analyzer contract rather than written here,
   * so the number shown is the number actually applied.
   */
  it("names the ceiling the analyzer applies, not a copy of it", () => {
    const html = render({ feedback: [answer(), answer()] });

    expect(html).toContain(
      t("en", "creator.learning.answerCount", {
        count: "2",
        limit: String(creatorAnalysisLimits.feedbackItems),
      }),
    );
    expect(html).toContain(String(creatorAnalysisLimits.feedbackItems));
  });
});

/**
 * **The stored value is not the sentence.** `approve` means "post this" on a
 * recommendation and "yes, leave it" on a skip; printing the column would make
 * somebody translate a database value to recognise their own decision.
 *
 * `skip` + `edit` is absent because the repository refuses a history holding
 * one — there is nothing to render for it.
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
      feedback: [
        answer({
          verdict,
          action,
          draftBody: verdict === "recommend" ? "SECRET-DRAFT" : null,
          editedBody: action === "edit" ? "SECRET-EDIT" : null,
        }),
      ],
    });

    expect(html).toContain(t("en", key));
  });

  /**
   * **Checked in Japanese, where an internal value would be unmistakable.**
   * English cannot carry this assertion: "Rejected" legitimately contains
   * "reject" and "Recommended" contains "recommend", so a substring check
   * there would fail on correct wording. A Japanese page rendering a bare
   * `approve` is the shape of the mistake worth catching.
   */
  it("never prints a stored value on a Japanese page", () => {
    const text = render(
      {
        feedback: [
          answer({ verdict: "recommend", action: "approve" }),
          answer({ verdict: "skip", action: "reject", draftBody: null }),
        ],
      },
      "ja",
    ).replace(/<[^>]*>/g, " ");

    for (const stored of ["approve", "reject", "recommend", "skip"]) {
      expect(text.toLowerCase()).not.toContain(stored);
    }
  });

  it("shows the channel and what Koqentra decided", () => {
    const html = render({
      feedback: [answer({ targetChannel: "reddit", verdict: "skip", draftBody: null, action: "reject" })],
    });

    expect(html).toContain(t("en", "creator.channel.reddit"));
    expect(html).toContain(t("en", "creator.verdict.skip"));
    expect(html).toContain(t("en", "creator.learning.youLabel"));
  });

  /**
   * **The name is written; the verdict is translated.** A brand is the same
   * word in every language, so a dictionary entry for it would be two identical
   * strings and an exception in the parity check. The judgement beside it is a
   * sentence, and does change.
   */
  it.each(["en", "ja"])("names Koqentra as itself in %s", (language) => {
    const html = render(
      { feedback: [answer({ verdict: "skip", draftBody: null, action: "reject" })] },
      language,
    );

    expect(html).toContain("Koqentra:");
    expect(html).toContain(t(language, "creator.verdict.skip"));
    expect(html).toContain(t(language, "creator.learning.youLabel"));
  });
});

describe("which piece each answer was about", () => {
  it("prefers the title", () => {
    const html = render({
      feedback: [answer({ contentTitle: "THE TITLE", contentExcerpt: "THE EXCERPT" })],
    });

    expect(html).toContain("THE TITLE");
    expect(html).not.toContain("THE EXCERPT");
  });

  it("falls back to the excerpt when there was no title", () => {
    const html = render({
      feedback: [answer({ contentTitle: null, contentExcerpt: "THE EXCERPT" })],
    });

    expect(html).toContain("THE EXCERPT");
  });

  it("names an untitled piece rather than showing a blank", () => {
    const html = render({
      feedback: [answer({ contentTitle: null, contentExcerpt: "   " })],
    });

    expect(html).toContain(t("en", "creator.learning.untitled"));
  });

  /** Already bounded by the repository — nothing is cut a second time here. */
  it("wraps long text instead of widening the page", () => {
    const html = render({
      feedback: [answer({ contentTitle: null, contentExcerpt: "x".repeat(2_000) })],
    });

    expect(html).toContain("break-words");
    expect(html).toContain("line-clamp-2");
  });
});

/**
 * **Order is the contract.** Position carries recency — no dates are sent to
 * the model and none are shown — so a panel that sorted would be describing a
 * different history from the one used.
 */
describe("the order the analyzer sees", () => {
  it("renders oldest first, exactly as given", () => {
    const html = render({
      feedback: [
        answer({ contentTitle: "FIRST-CONTENT" }),
        answer({ contentTitle: "SECOND-CONTENT" }),
        answer({ contentTitle: "THIRD-CONTENT" }),
      ],
    });

    expect(html.indexOf("FIRST-CONTENT")).toBeLessThan(
      html.indexOf("SECOND-CONTENT"),
    );
    expect(html.indexOf("SECOND-CONTENT")).toBeLessThan(
      html.indexOf("THIRD-CONTENT"),
    );
  });

  it("shows no dates, because none are sent", () => {
    const text = render({ feedback: [answer()] }).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

/**
 * **Not a transcript.** All of these reach the model, and rendering twelve of
 * them would put a history in front of somebody who came to submit something.
 * The panel says so in words instead — see `creator.learning.detailNote`.
 */
describe("what it deliberately does not show", () => {
  const loaded = {
    feedback: [
      answer({
        action: "edit",
        editedBody: "SECRET-EDIT",
        feedbackReason: "SECRET-FEEDBACK-REASON",
      }),
    ],
  };

  it.each([
    "SECRET-DECISION-REASON",
    "SECRET-DRAFT",
    "SECRET-EDIT",
    "SECRET-FEEDBACK-REASON",
  ])("keeps %s out of the markup", (secret) => {
    expect(render(loaded)).not.toContain(secret);
  });

  it("says the analysis uses more than this, and links the notice", () => {
    const html = render(loaded);

    expect(html).toContain(t("en", "creator.learning.detailNote"));
    expect(html).toContain('href="/privacy"');
  });
});

describe("what it must never claim", () => {
  /**
   * Koqentra stores what somebody said and what they did. It derives no
   * preference, so no screen may imply that it has.
   */
  it.each(["en", "ja"])("claims nothing was learned, in %s", (language) => {
    const text = render(
      { profile: PROFILE, feedback: [answer()] },
      language,
    ).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bmemory\b/i);
    expect(text).not.toMatch(/\blearn(ed|s|ing)?\b/i);
    expect(text).not.toMatch(/\bprefers?\b/i);
    expect(text).not.toContain("学習");
    expect(text).not.toContain("好み");
  });

  it("says neither Draft nor Run", () => {
    const text = render({ profile: PROFILE, feedback: [answer()] }).replace(
      /<[^>]*>/g,
      " ",
    );

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
  });
});

describe("in Japanese", () => {
  it("speaks Japanese throughout", () => {
    const html = render(
      { profile: PROFILE, feedback: [answer({ action: "edit", editedBody: "e" })] },
      "ja",
    );

    expect(html).toContain(t("ja", "creator.learning.title"));
    expect(html).toContain(t("ja", "creator.learning.profileHeading"));
    expect(html).toContain(t("ja", "creator.learning.action.editedAndUsed"));
    expect(html).not.toContain(t("en", "creator.learning.title"));
  });

  it("says nothing is set in Japanese too", () => {
    const html = render({ profile: EMPTY_PROFILE }, "ja");

    expect(html).toContain(t("ja", "creator.learning.notSet"));
  });
});

/**
 * What Koqentra concluded from answers it no longer lists one by one.
 *
 * **Shown as a derivation, never as a fact about somebody.** Koqentra does not
 * know what this person prefers; a model wrote a summary from answers that
 * scrolled out of the list, and that summary can be wrong. The panel says so,
 * and says which evidence outranks it — which is the order the analyzer
 * actually applies.
 *
 * **The count is what the summary was built from**, not how many old answers
 * exist. Catching up happens a batch at a time, so the two differ while it is
 * in progress; "based on N" is accurate at every step and "all of them" would
 * not be.
 */
describe("the summary of older answers", () => {
  const MEMORY = {
    summary: "Has usually turned down promotional posts.",
    derivedFromCount: 8,
  };

  it("says nothing at all when there is none", () => {
    const html = render({ memory: null, feedback: [answer()] });

    expect(html).not.toContain(t("en", "creator.learning.memoryHeading"));
    expect(html).not.toContain(t("en", "creator.learning.memoryNote"));
  });

  it("shows the summary, what it was built from, and its standing", () => {
    const html = render({ memory: MEMORY });

    expect(html).toContain(t("en", "creator.learning.memoryHeading"));
    expect(html).toContain("Has usually turned down promotional posts.");
    expect(html).toContain(
      t("en", "creator.learning.memoryCount", { count: "8" }),
    );
    expect(html).toContain(t("en", "creator.learning.memoryNote"));
  });

  /**
   * **Between the two things it is ranked against.** Above it is what the
   * person stated; below it is what they did recently. Both outrank it, and the
   * order on screen is the order the analyzer applies.
   */
  it("sits below the stated preferences and above the recent answers", () => {
    const html = render({ profile: PROFILE, memory: MEMORY, feedback: [answer()] });

    const preferences = html.indexOf(t("en", "creator.learning.profileHeading"));
    const memory = html.indexOf(t("en", "creator.learning.memoryHeading"));
    const answers = html.indexOf(t("en", "creator.learning.answersHeading"));

    expect(preferences).toBeGreaterThan(-1);
    expect(memory).toBeGreaterThan(preferences);
    expect(answers).toBeGreaterThan(memory);
  });

  it("leaves the recent answers exactly where they were", () => {
    const html = render({ memory: MEMORY, feedback: [answer(), answer()] });

    expect(html).toContain(
      t("en", "creator.learning.answerCount", {
        count: "2",
        limit: String(creatorAnalysisLimits.feedbackItems),
      }),
    );
  });

  /**
   * **Nothing to act on.** The stated preferences above are where somebody says
   * what they want; a second editable place would blur which of the two the
   * analyzer treats as a statement.
   */
  it("offers no way to change it", () => {
    const html = render({ memory: MEMORY });

    expect(html.match(/<button/g) ?? []).toHaveLength(0);
    expect(html.match(/<form/g) ?? []).toHaveLength(0);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('href="/dashboard/settings');
  });

  /** Still one collapsed panel, and still bounded by the column it sits in. */
  it("stays inside the collapsed panel", () => {
    const html = render({ memory: MEMORY });

    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).not.toMatch(/style="[^"]*width/);
    expect(html).not.toMatch(/w-\[\d/);
    expect(html).toContain("break-words");
  });

  it("speaks Japanese when the account does", () => {
    const html = render({ memory: MEMORY }, "ja");

    expect(html).toContain(t("ja", "creator.learning.memoryHeading"));
    expect(html).toContain(
      t("ja", "creator.learning.memoryCount", { count: "8" }),
    );
    expect(html).not.toContain(t("en", "creator.learning.memoryHeading"));
  });

  /**
   * **It may not be stated as knowledge.** Koqentra derives this; it does not
   * know it. The wording has to keep saying so in both languages, because the
   * panel is the only place the difference is visible.
   */
  it.each(["en", "ja"] as const)("says it is derived and may be wrong, in %s", (language) => {
    const note = t(language, "creator.learning.memoryNote");

    expect(note).toContain(language === "ja" ? "AI" : "AI-generated");
    expect(note).toContain(language === "ja" ? "正確でない場合があります" : "may be imperfect");
    expect(note).toContain(language === "ja" ? "優先" : "take priority");
  });

  it.each([
    ["en", ["Koqentra knows", "Koqentra remembers", "You prefer", "we learned"]],
    ["ja", ["あなたは", "覚えて", "把握して"]],
  ] as const)("claims nothing it cannot, in %s", (language, phrases) => {
    const copy = [
      t(language, "creator.learning.memoryHeading"),
      t(language, "creator.learning.memoryNote"),
      t(language, "creator.learning.memoryCount", { count: "8" }),
    ].join(" ");

    for (const phrase of phrases) {
      expect(copy).not.toContain(phrase);
    }
  });
});
