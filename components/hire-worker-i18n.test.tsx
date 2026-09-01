import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the hire form says, in each language.
 *
 * **Rendered to a string, which is as far as this project's component tests
 * reach**: no DOM, no renderer beyond the one React ships for the server, and
 * no new dependency. That covers the form as it first appears — every heading,
 * label, placeholder and button somebody reads before touching anything.
 *
 * **What it cannot reach is the draft result card.** That state starts as
 * `null` and only exists after an action has returned, so a static render never
 * produces it. What the card must do — show the model's own words untouched
 * while translating the sentence around them — is fixed by the dictionary tests
 * in `lib/i18n/index.test.ts` and confirmed in the browser.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
// The form reaches its two server actions on the way in. Nothing here calls
// either: this only keeps rendering a form from pulling a database driver into
// a test about words.
vi.mock("@/app/dashboard/new/actions", () => ({
  createRoutineAction: vi.fn(),
  generateWorkerDraftAction: vi.fn(),
}));
// Filling in the form raises no toast, and this file never submits it.
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: () => {},
}));

const { RoutineForm } = await import("@/components/routine-form");
const { frequencyKeys } = await import("@/components/worker-fields");
const { t } = await import("@/lib/i18n");

const form = (language: string) =>
  renderToStaticMarkup(<RoutineForm timezone="Asia/Tokyo" language={language} />);

describe("the hire form in English", () => {
  const html = form("en");

  it("asks what the work is before asking how to describe it", () => {
    expect(html).toContain("What would you like AutoOps to handle?");
    expect(html).toContain("Create draft");
  });

  it("offers the two kinds in the words of the decision", () => {
    expect(html).toContain("Run a prompt");
    expect(html).toContain("Watch a page");
    expect(html).toContain("Sends your instructions to the AI on a schedule.");
    expect(html).toContain(
      "Checks a page and only involves the AI when it changes.",
    );
  });

  it("offers templates and the fields below them", () => {
    expect(html).toContain("Choose a Template");
    expect(html).toContain("Start from a template");
    expect(html).toContain("Have a page watched for you");
    expect(html).toContain("Have AI do a job regularly");
    expect(html).toContain(">Name<");
    expect(html).toContain(">Save<");
    expect(html).toContain(">Cancel<");
  });
});

describe("the hire form in Japanese", () => {
  const html = form("ja");

  it("asks what the work is, in Japanese", () => {
    expect(html).toContain("AutoOps に何を任せますか?");
    expect(html).toContain("下書きを作成");
    expect(html).not.toContain("Create draft");
  });

  it("offers the two kinds in the words of the decision", () => {
    expect(html).toContain("AI に依頼する");
    expect(html).toContain("Web ページを監視する");
    expect(html).not.toContain("Run a prompt");
  });

  it("offers templates and the fields below them", () => {
    expect(html).toContain("テンプレートを選ぶ");
    expect(html).toContain("Web を見ておいてもらう");
    expect(html).toContain("AI に定期的に仕事をしてもらう");
    expect(html).toContain("名前");
    expect(html).toContain("保存");
    expect(html).toContain("キャンセル");
  });
});

/**
 * The parts a language must not reach.
 *
 * A form that renamed its own inputs, or offered different values depending on
 * who was reading it, would save something different per language.
 */
describe("what the language does not change", () => {
  it("submits the same fields under the same names", () => {
    for (const language of ["en", "ja"]) {
      const html = form(language);

      expect(html).toContain('name="name"');
      expect(html).toContain('name="description"');
      expect(html).toContain('name="prompt"');
      expect(html).toContain('name="kind"');
      expect(html).toContain('name="frequency"');
      expect(html).toContain('name="status"');
    }
  });

  it("offers the same stored values for the kind", () => {
    for (const language of ["en", "ja"]) {
      const html = form(language);

      expect(html).toContain('value="prompt"');
      expect(html).toContain('value="website"');
    }
  });

  /**
   * **The examples themselves are translated, and that reverses an earlier
   * decision.** It used to be that a template's title and prompt stayed as
   * written, on the grounds that both become the worker once one is applied.
   * They do — but until then they are AutoOps offering an example, and an
   * example nobody can read is not one.
   *
   * **What the language still does not reach is anything typed afterwards.**
   * The field names, the stored kinds and the cadence values above are the same
   * in both, and nothing translates a name or a prompt once it is in the form.
   */
  it("offers the examples in the language being read", () => {
    expect(form("en")).toContain("Watch a local government page");
    expect(form("ja")).toContain("自治体のお知らせをチェック");

    expect(form("ja")).not.toContain("Watch a local government page");
    expect(form("en")).not.toContain("自治体のお知らせをチェック");
  });
});

/**
 * What a drafted cadence is called, and what it stays.
 *
 * **The card showed the stored value itself** — a Japanese screen reading
 * "指示を AI に送信します・weekly" — which is what this fixes. The value is the
 * contract: `weekly` is what the model returns, what the form receives, and
 * what the column holds. Only the word for it moves.
 *
 * Checked through the same map the card and the frequency select both read,
 * because a draft card only exists after an action has returned and a static
 * render never produces one.
 */
describe("a drafted cadence", () => {
  it.each([
    ["manual", "Manual", "手動"],
    ["daily", "Daily", "毎日"],
    ["weekly", "Weekly", "毎週"],
    ["monthly", "Monthly", "毎月"],
  ] as const)("names %o in both languages", (frequency, english, japanese) => {
    expect(t("en", frequencyKeys[frequency])).toBe(english);
    expect(t("ja", frequencyKeys[frequency])).toBe(japanese);
  });

  it.each(["manual", "daily", "weekly", "monthly"] as const)(
    "never puts the stored value %o on screen",
    (frequency) => {
      for (const language of ["en", "ja"]) {
        expect(t(language, frequencyKeys[frequency])).not.toBe(frequency);
      }
    },
  );

  /**
   * The map the draft card reads is the one the select reads. Two lists would
   * let a cadence be called one thing where it is proposed and another where
   * it is chosen.
   */
  it("uses the same words the frequency select offers", () => {
    const html = form("ja");

    for (const frequency of ["daily", "weekly", "monthly"] as const) {
      expect(html).toContain(`>${t("ja", frequencyKeys[frequency])}<`);
    }
  });
});
