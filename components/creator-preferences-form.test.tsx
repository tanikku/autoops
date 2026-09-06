import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The three lines somebody states about their own writing.
 *
 * **Rendered to a string, the boundary the rest of this project's component
 * tests work at**: no DOM and no new dependency. What that reaches is what
 * somebody reads and what the form would submit, which is the whole of what
 * this section is.
 *
 * **The form must not be able to name an owner.** The account is the session's
 * to know, so a hidden field carrying a user or a profile id would be a claim
 * the server would have to distrust anyway — and the absence of one is worth
 * fixing here rather than only in the action.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/app/dashboard/settings/actions", () => ({
  updateCreatorPreferencesAction: vi.fn(),
}));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: () => {},
}));

const { CreatorPreferencesForm } = await import(
  "@/components/creator-preferences-form"
);
const { t } = await import("@/lib/i18n");
const { creatorAnalysisLimits } = await import("@/lib/creator/analyzer");

const EMPTY = { audience: "", goals: "", voiceInstructions: "" };

const STORED = {
  audience: "Solo founders shipping alone",
  goals: "Be useful, not loud",
  voiceInstructions: "Plain sentences. No exclamation marks.",
};

function render(profile = EMPTY, language = "en"): string {
  return renderToStaticMarkup(
    <CreatorPreferencesForm profile={profile} language={language} />,
  );
}

describe("the three fields", () => {
  it("renders one box per stated preference", () => {
    const html = render();

    expect(html.split("<textarea").length - 1).toBe(3);
  });

  it.each(["audience", "goals", "voiceInstructions"])(
    "submits %s under exactly that name",
    (name) => {
      expect(render()).toContain(`name="${name}"`);
    },
  );

  /** Three, and no fourth. The owner is the session's to know. */
  it("carries no other field", () => {
    const names = [...render().matchAll(/name="([^"]*)"/g)].map((m) => m[1]);

    expect(names.sort()).toEqual(["audience", "goals", "voiceInstructions"]);
  });

  it.each(["userId", "creatorProfileId", "id", "ownerId"])(
    "has no %s input",
    (name) => {
      expect(render()).not.toContain(`name="${name}"`);
    },
  );

  it("has no hidden input at all", () => {
    expect(render()).not.toContain('type="hidden"');
  });
});

describe("what is already stored", () => {
  it("shows each value back in its own box", () => {
    const html = render(STORED);

    expect(html).toContain("Solo founders shipping alone");
    expect(html).toContain("Be useful, not loud");
    expect(html).toContain("Plain sentences. No exclamation marks.");
  });

  /**
   * An empty profile renders an empty form rather than the example text —
   * a placeholder is an illustration, never a saved value.
   */
  it("shows the examples as placeholders, not as content", () => {
    const html = render();

    expect(html).toContain(t("en", "settings.creator.audiencePlaceholder"));
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
  });
});

/**
 * **The ceilings come from the analyzer contract**, so a box stops accepting
 * text at the point an analysis request would be refused. Written here as a
 * second copy, they would be a number that drifts.
 */
describe("how much may be written", () => {
  it.each([
    ["audience", creatorAnalysisLimits.profileAudience],
    ["goals", creatorAnalysisLimits.profileGoals],
    ["voiceInstructions", creatorAnalysisLimits.profileVoiceInstructions],
  ] as const)("stops %s at the analyzer's limit", (name, limit) => {
    const field = render().match(
      new RegExp(`<textarea[^>]*name="${name}"[^>]*>`),
    )?.[0];

    expect(field).toBeDefined();
    expect(field).toContain(`maxLength="${limit}"`);
  });
});

describe("what it says these preferences do", () => {
  it.each(["en", "ja"])("states the priority in %s", (language) => {
    expect(render(STORED, language)).toContain(
      t(language, "settings.creator.priorityNote"),
    );
  });

  /**
   * The analyzer reads stated preferences above patterns in past answers, and
   * that is all this may claim. **Obedience and results are not things a model
   * call can be held to**, so no wording here promises either.
   */
  it.each([
    ["en", ["always", "guarantee", "will follow", "ensure"]],
    ["ja", ["必ず", "保証", "従います", "確実"]],
  ] as const)("promises none of the forbidden things in %s", (language, phrases) => {
    for (const phrase of phrases) {
      expect(t(language, "settings.creator.priorityNote")).not.toContain(phrase);
    }
  });
});

describe("labelling", () => {
  it.each(["en", "ja"])("names all three fields in %s", (language) => {
    const html = render(EMPTY, language);

    for (const key of [
      "settings.creator.audience",
      "settings.creator.goals",
      "settings.creator.voice",
    ] as const) {
      expect(html).toContain(t(language, key));
    }
  });

  it("speaks Japanese throughout", () => {
    const html = render(EMPTY, "ja");

    expect(html).toContain("届けたい相手");
    expect(html).toContain(">保存<");
    expect(html).not.toContain(">Save<");
  });

  /** The column names are the database's business, not the reader's. */
  it("shows no database field names", () => {
    const text = render(STORED).replace(/<[^>]*>/g, " ");

    expect(text).not.toContain("voiceInstructions");
    expect(text).not.toContain("audience");
    expect(text).not.toContain("goals");
  });

  /** Worker vocabulary belongs to the other half of the product. */
  it.each(["en", "ja"])("says neither Draft nor Run in %s", (language) => {
    const text = render(STORED, language).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bdrafts?\b/i);
    expect(text).not.toMatch(/\bruns?\b/i);
  });
});

describe("saving", () => {
  it.each(["en", "ja"])("offers the shared Save word in %s", (language) => {
    expect(render(EMPTY, language)).toContain(`>${t(language, "common.save")}<`);
  });
});

/**
 * On a 375px screen the boxes are the width of the column and the text wraps
 * inside them. Nothing here is measured — what is fixed is that no fixed width
 * is written into the markup, which is how a form starts overflowing.
 */
describe("on a narrow screen", () => {
  it("lets the boxes take the width they are given", () => {
    expect(render()).toContain("w-full");
  });

  it("bounds the column rather than the fields", () => {
    expect(render()).toContain("max-w-2xl");
  });

  it("writes no fixed width anywhere", () => {
    expect(render()).not.toMatch(/style="[^"]*width/);
    expect(render()).not.toMatch(/\bw-\[\d/);
  });
});
