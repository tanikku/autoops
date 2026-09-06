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
  readCreatorProfile: vi.fn(),
  readRecentFeedbackContext: vi.fn(),
}));

/**
 * **The two reads the learning panel is built from, replaced at the boundary.**
 * They are the same functions the analyzer's context comes from — which is the
 * point of the panel — so what is checked here is that the page asks them for
 * the signed-in account and writes nothing while doing it.
 */
vi.mock("@/lib/creator/repository", () => ({
  readCreatorProfile: mocks.readCreatorProfile,
  readRecentFeedbackContext: mocks.readRecentFeedbackContext,
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
  analyzeCreatorUrlAction: vi.fn(),
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
  mocks.readCreatorProfile
    .mockReset()
    .mockResolvedValue({ audience: "", goals: "", voiceInstructions: "" });
  mocks.readRecentFeedbackContext.mockReset().mockResolvedValue([]);
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

  /**
   * **One trusted id, three reads.** A page that took an owner from anywhere
   * else — a prop, a search param — could show one account's preferences to
   * another; it takes no arguments at all, and every read is given the same id
   * the session boundary returned.
   */
  it("reads the profile and the history for that same account", async () => {
    mocks.requireUserId.mockResolvedValue("user-9");

    await render();

    expect(mocks.readCreatorProfile).toHaveBeenCalledWith("user-9");
    expect(mocks.readRecentFeedbackContext).toHaveBeenCalledWith("user-9");
  });

  it("takes no request input, so nobody can choose whose context is shown", () => {
    expect(CreatorNewPage.length).toBe(0);
  });

  /** Looking at what will be considered is not a reason to write anything. */
  it("reads each source once and writes nothing", async () => {
    await render();

    expect(mocks.readCreatorProfile).toHaveBeenCalledTimes(1);
    expect(mocks.readRecentFeedbackContext).toHaveBeenCalledTimes(1);
    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });
});

/**
 * **A preview, not an input.** What the panel shows is read again on the server
 * when the form is submitted; if any of it travelled through the browser, a
 * client could name the context its own analysis was judged against.
 */
describe("what the learning panel is and is not", () => {
  const profile = {
    audience: "PROFILE-AUDIENCE",
    goals: "PROFILE-GOALS",
    voiceInstructions: "PROFILE-VOICE",
  };

  const entry = {
    targetChannel: "x" as const,
    verdict: "recommend" as const,
    decisionReason: "SECRET-DECISION-REASON",
    draftBody: "SECRET-DRAFT",
    action: "edit" as const,
    editedBody: "SECRET-EDIT",
    feedbackReason: "SECRET-FEEDBACK-REASON",
    contentTitle: "AN EARLIER PIECE",
    contentExcerpt: "Its opening lines.",
  };

  it("renders the section", async () => {
    const html = await render();

    expect(html).toContain(t("en", "creator.learning.title"));
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
  });

  it("shows the stored preferences and the answers it was given", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile);
    mocks.readRecentFeedbackContext.mockResolvedValue([entry]);

    const html = await render();

    expect(html).toContain("PROFILE-AUDIENCE");
    expect(html).toContain("AN EARLIER PIECE");
  });

  /**
   * **Nothing about the context is submitted.** The form's contract stays two
   * fields; a hidden input carrying a profile or a history would be a claim the
   * server has to distrust anyway.
   */
  it("sends only a title and a body, whatever the panel is showing", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile);
    mocks.readRecentFeedbackContext.mockResolvedValue([entry]);

    const html = await render();
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);

    expect(names.sort()).toEqual(["body", "title"]);
    for (const field of ["audience", "goals", "voiceInstructions", "feedback"]) {
      expect(html).not.toContain(`name="${field}"`);
    }
  });

  /** The compact panel is deliberately not a transcript — see the component. */
  it.each([
    "SECRET-DECISION-REASON",
    "SECRET-DRAFT",
    "SECRET-EDIT",
    "SECRET-FEEDBACK-REASON",
  ])("does not render %s", async (secret) => {
    mocks.readCreatorProfile.mockResolvedValue(profile);
    mocks.readRecentFeedbackContext.mockResolvedValue([entry]);

    expect(await render()).not.toContain(secret);
  });

  /** Koqentra derives no preference, so no screen may imply one. */
  it("claims nothing was learned about the person", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile);
    mocks.readRecentFeedbackContext.mockResolvedValue([entry]);

    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/\bmemory\b/i);
    expect(text).not.toMatch(/\blearn(ed|s)?\b/i);
    expect(text).not.toContain("学習");
    expect(text).not.toContain("好み");
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

/**
 * Where somebody finds out that Creator preferences exist.
 *
 * **The problem it answers is a missing path, not a missing feature.** The
 * preferences form has existed since C1.7B; until this callout, the only sign
 * of it from anywhere in Creator was three lines reading "Not set" inside a
 * panel that starts collapsed.
 *
 * **Shown only when all three are empty.** That is the one state where
 * "nothing has been said yet" is unambiguous — somebody who filled in one has
 * told Koqentra what they wanted to, and calling that incomplete would be the
 * product disagreeing with them.
 */
describe("finding the preferences that have not been set", () => {
  const profile = (overrides: Record<string, string> = {}) => ({
    audience: "",
    goals: "",
    voiceInstructions: "",
    ...overrides,
  });

  it("offers them when nothing at all has been stated", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile());

    const html = await render();

    expect(html).toContain(t("en", "creator.new.preferencesPrompt"));
    expect(html).toContain(t("en", "creator.new.preferencesAction"));
    expect(html).toContain(t("en", "creator.new.preferencesOptional"));
  });

  /** A link, because it goes somewhere — and it lands on the right section. */
  it("links straight to the section rather than to the page", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile());

    const html = await render();

    expect(html).toContain('href="/dashboard/settings#creator-preferences"');
    expect(html).toMatch(
      /<a[^>]*href="\/dashboard\/settings#creator-preferences"/,
    );
  });

  /** Whitespace is nothing said — the same reading the panel below uses. */
  it("offers them when all three hold only whitespace", async () => {
    mocks.readCreatorProfile.mockResolvedValue(
      profile({ audience: "   ", goals: "\n", voiceInstructions: "\t" }),
    );

    expect(await render()).toContain(
      t("en", "creator.new.preferencesPrompt"),
    );
  });

  /**
   * **One is enough.** Somebody who describes their audience and leaves the
   * rest alone has said what they wanted to say; a product that kept asking
   * would be telling them they are wrong about their own work.
   */
  it.each([
    ["an audience", { audience: "Local readers" }],
    ["a goal", { goals: "Be useful" }],
    ["a voice", { voiceInstructions: "Plain sentences" }],
  ])("says nothing more once %s has been stated", async (_name, stated) => {
    mocks.readCreatorProfile.mockResolvedValue(profile(stated));

    const html = await render();

    expect(html).not.toContain(t("en", "creator.new.preferencesPrompt"));
    expect(html).not.toContain(t("en", "creator.new.preferencesAction"));
    expect(html).not.toContain(
      'href="/dashboard/settings#creator-preferences"',
    );
  });

  it("says nothing when all three have been stated", async () => {
    mocks.readCreatorProfile.mockResolvedValue({
      audience: "Local readers",
      goals: "Be useful",
      voiceInstructions: "Plain sentences",
    });

    expect(await render()).not.toContain(
      t("en", "creator.new.preferencesPrompt"),
    );
  });

  /**
   * **It is an offer, not a gate.** The form is right there and works exactly
   * as well with none of this set.
   */
  it("leaves the form working while it is shown", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile());

    const html = await render();

    expect(html).toContain('name="title"');
    expect(html).toContain('name="body"');
    expect(html).toContain(t("en", "creator.new.submit"));
  });

  /**
   * **It says where the preferences are set; the panel says what the analysis
   * will be told.** Two different questions, and the first one comes first.
   */
  it("sits after the description and before the panel", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile());

    const html = await render();
    const callout = html.indexOf(t("en", "creator.new.preferencesPrompt"));

    expect(html.indexOf(t("en", "creator.new.description"))).toBeLessThan(
      callout,
    );
    expect(callout).toBeLessThan(html.indexOf(t("en", "creator.learning.title")));
  });

  /** Reading a page must not be what brings a profile row into being. */
  it("reads the same two things it always did, and writes nothing", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile());

    await render();

    expect(mocks.readCreatorProfile).toHaveBeenCalledTimes(1);
    expect(mocks.readRecentFeedbackContext).toHaveBeenCalledTimes(1);
    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });

  it("speaks Japanese when the account does", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.readCreatorProfile.mockResolvedValue(profile());

    const html = await render();

    expect(html).toContain(t("ja", "creator.new.preferencesPrompt"));
    expect(html).toContain(t("ja", "creator.new.preferencesAction"));
    expect(html).toContain(t("ja", "creator.new.preferencesOptional"));
    expect(html).not.toContain(t("en", "creator.new.preferencesPrompt"));
  });

  /**
   * **Koqentra derives nothing about anybody, and this must not say it does.**
   * There is no memory of a person being built up — `CreatorMemory` exists in
   * the schema and nothing reads or writes it — so a sentence claiming the
   * product learns or remembers would describe a feature that does not exist.
   *
   * Checked against the callout's own words rather than the whole page, so
   * that unrelated copy elsewhere cannot make this pass or fail by accident.
   */
  it.each(["en", "ja"] as const)("claims nothing is learned, in %s", (language) => {
    const callout = [
      t(language, "creator.new.preferencesPrompt"),
      t(language, "creator.new.preferencesAction"),
      t(language, "creator.new.preferencesOptional"),
    ].join(" ");

    expect(callout).not.toMatch(/\blearn(ed|s|ing)?\b/i);
    expect(callout).not.toMatch(/\bmemor(y|ies)\b/i);
    expect(callout).not.toMatch(/\bremember(s|ed|ing)?\b/i);
    expect(callout).not.toContain("学習");
    expect(callout).not.toContain("覚え");
    expect(callout).not.toContain("記憶");
    expect(callout).not.toContain("好み");
  });

  /**
   * Setting preferences is an offer. Wording that makes it sound compulsory —
   * or that frames a profile as something to be completed — would turn the
   * callout into the gate it deliberately is not.
   */
  it.each([
    ["en", ["required", "must ", "complete your", "onboarding"]],
    ["ja", ["必須", "完了してください", "オンボーディング", "完成"]],
  ] as const)("asks rather than demands, in %s", (language, phrases) => {
    const callout = [
      t(language, "creator.new.preferencesPrompt"),
      t(language, "creator.new.preferencesAction"),
      t(language, "creator.new.preferencesOptional"),
    ]
      .join(" ")
      .toLowerCase();

    for (const phrase of phrases) {
      expect(callout).not.toContain(phrase.toLowerCase());
    }
  });

  /** A long sentence on a phone wraps inside the column rather than widening it. */
  it("writes no fixed width", async () => {
    mocks.readCreatorProfile.mockResolvedValue(profile());

    const html = await render();

    expect(html).not.toMatch(/style="[^"]*width/);
    expect(html).not.toMatch(/w-\[\d/);
  });
});
