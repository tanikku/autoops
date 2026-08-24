import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Settings forms say, in each language.
 *
 * **Rendered to a string, the same boundary the rest of this project's
 * component tests work at**: no DOM, no renderer beyond the one React ships
 * for the server, and no new dependency. What that reaches is what somebody
 * reads before touching anything — which is the whole of what Day 2C changed
 * on this page.
 *
 * **The zones themselves are the part a language must not reach.** An IANA
 * identifier is what the column holds and what the scheduler reads; a list
 * that differed by language would be offering different settings to different
 * readers.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
// Both forms reach their server actions on the way in, and one of them raises
// a toast. Neither is submitted here.
vi.mock("@/app/dashboard/settings/actions", () => ({
  updateTimezoneAction: vi.fn(),
  updateLanguageAction: vi.fn(),
}));
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: () => {},
}));

const { TimezoneForm } = await import("@/components/timezone-form");
const { t } = await import("@/lib/i18n");

const form = (language: string) =>
  renderToStaticMarkup(
    <TimezoneForm timezone="Asia/Tokyo" language={language} />,
  );

describe("the timezone form in English", () => {
  const html = form("en");

  it("names the setting and the button", () => {
    expect(html).toContain("Timezone");
    expect(html).toContain(">Save<");
  });

  it("says what saving does", () => {
    expect(html).toContain("Timestamps are shown in this zone");
  });
});

describe("the timezone form in Japanese", () => {
  const html = form("ja");

  it("names the setting and the button", () => {
    expect(html).toContain("タイムゾーン");
    expect(html).toContain(">保存<");
    expect(html).not.toContain(">Save<");
  });

  it("says what saving does, in Japanese", () => {
    expect(html).toContain("タイムスタンプはこのタイムゾーンで表示され");
  });
});

/**
 * What the note is allowed to promise, in either language.
 *
 * Saving writes one column. Nothing reads or rewrites a worker's pending slot
 * on the way, so the run already scheduled stays exactly where it was — and
 * what happens to the runs *after* that one is deliberately not described,
 * because it is not one rule.
 */
describe("what the note about changing the zone says", () => {
  it("says the next run already scheduled does not move", () => {
    expect(t("en", "settings.timezone.note")).toContain(
      "does not change any worker’s already-scheduled next run",
    );
    expect(t("ja", "settings.timezone.note")).toContain(
      "すでに予定されている次回実行は変わりません",
    );
  });

  it("says a worker set to run at 09:00 runs at 09:00 here", () => {
    expect(t("en", "settings.timezone.note")).toContain("09:00");
    expect(t("ja", "settings.timezone.note")).toContain("09:00");
  });

  /**
   * The claims it must not make: that later runs move as one, that editing is
   * needed to move them, or that anything is rescheduled by saving.
   */
  it.each([
    ["en", ["reschedul", "all future", "every future", "edit each"]],
    ["ja", ["再計算", "すべての実行", "以降の実行はすべて", "編集し直"]],
  ] as const)("claims none of the forbidden things in %s", (language, phrases) => {
    for (const phrase of phrases) {
      expect(t(language, "settings.timezone.note")).not.toContain(phrase);
    }
  });
});

/**
 * The parts a language does not decide.
 */
describe("what the language does not change", () => {
  it("submits the same field under the same name", () => {
    for (const language of ["en", "ja"]) {
      expect(form(language)).toContain('name="timezone"');
    }
  });

  /**
   * The list itself only exists once the select is opened, which a static
   * render never does. What it does reach is the value that would be
   * submitted and the label standing in for it — and neither moves.
   */
  it("carries the identifier itself, in both", () => {
    for (const language of ["en", "ja"]) {
      expect(form(language)).toContain('value="Asia/Tokyo"');
    }
  });

  it("names the chosen zone the same way either way", () => {
    const shown = (html: string) =>
      html.match(/data-slot="select-value"[^>]*>([^<]*)</)?.[1];

    expect(shown(form("ja"))).toBe(shown(form("en")));
  });
});
