import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// The note lives with the form that shows it, and that form reaches the edit
// action on the way in. Nothing here asks the auth module anything — this only
// keeps reading one string from pulling in a framework runtime.
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));

const { WorkerFields } = await import("@/components/worker-fields");
const { t } = await import("@/lib/i18n");

/**
 * The note as each language writes it.
 *
 * It moved into the dictionary in Day 2B, so what used to be one exported
 * constant is now two strings held to the same three promises.
 */
const BASELINE_RESET_NOTE = t("en", "worker.edit.baselineReset");
const BASELINE_RESET_NOTE_JA = t("ja", "worker.edit.baselineReset");

/**
 * Which fields a worker is asked for, and what they are called.
 *
 * The same component serves both kinds and both forms, so what separates them
 * is a prop rather than a copy of the markup — which is exactly the sort of
 * thing that drifts silently. Rendering it to a string is the smallest way to
 * ask: no DOM, no renderer beyond the one React already ships for the server,
 * and no new dependency.
 */

/**
 * The zone and the language every worker form now has to be told, both
 * defaulted so each test names only what it is about.
 *
 * English by default, which is what keeps the assertions below about which
 * fields are asked for rather than about which words are used for them.
 */
function render(
  props: Omit<Parameters<typeof WorkerFields>[0], "timezone" | "language"> & {
    timezone?: string;
    language?: string;
  },
) {
  return renderToStaticMarkup(
    <WorkerFields timezone="UTC" language="en" {...props} />,
  );
}

describe("a prompt worker's fields", () => {
  const html = render({ values: {} });

  it("asks for a prompt, in those words", () => {
    expect(html).toContain(">Prompt<");
    expect(html).toContain("Instructions sent to the AI on every run.");
  });

  it("does not ask what to do when a page changes", () => {
    expect(html).not.toContain("When the page changes");
    expect(html).not.toContain("What should the AI do when this page changes?");
  });

  /**
   * The address input stays in the page so that switching kind on the hire form
   * does not empty a box that was already filled in — but inside a container
   * `display: none` removes from the screen and from the accessibility tree
   * with it. Present in the markup is not the same as asked for.
   */
  it("keeps the address input out of sight rather than out of the page", () => {
    const hidden = html.slice(html.indexOf('<div class="hidden">'));

    expect(html).toContain('<div class="hidden">');
    expect(hidden).toContain('name="websiteUrl"');
    expect(hidden).toContain("Website address");
  });

  it("says nothing about a baseline, even when a note is supplied", () => {
    const withNote = render({ values: {}, websiteUrlNote: BASELINE_RESET_NOTE });

    // Not the bare word: `items-baseline` is a layout class on this very form.
    expect(withNote).not.toContain("comparison baseline");
  });
});

describe("a website worker's fields", () => {
  const html = render({
    kind: "website",
    values: {
      websiteUrl: "https://example.com/news",
      prompt: "Tell me what changed.",
    },
  });

  it("asks for the address, and fills in the one already stored", () => {
    expect(html).toContain("Website address");
    expect(html).toContain('value="https://example.com/news"');
  });

  it("asks what to do about a change, rather than for a prompt", () => {
    expect(html).toContain("When the page changes");
    expect(html).toContain("What should the AI do when this page changes?");
    expect(html).not.toContain("Instructions sent to the AI on every run.");
  });

  it("keeps the schedule and status fields every worker has", () => {
    expect(html).toContain('name="frequency"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="description"');
  });

  it("shows a note about the address when one is given", () => {
    const withNote = render({
      kind: "website",
      values: {},
      websiteUrlNote: BASELINE_RESET_NOTE,
    });

    expect(withNote).toContain(
      "Changing the address resets the comparison baseline.",
    );
  });
});

/**
 * What the note is allowed to promise.
 *
 * The mechanism it describes is invisible — a row disappears and a later run
 * behaves differently — so the sentence is the only account of it anyone gets,
 * and each clause has to survive the cases it does not mention. A check that
 * fails writes no baseline. Saving the form fetches nothing. Nothing is
 * deleted except the comparison point.
 */
describe("what the note about changing an address says", () => {
  it("promises a baseline only once a check has succeeded", () => {
    expect(BASELINE_RESET_NOTE).toContain("next successful check");
  });

  it("names establishing a baseline as the alternative to reporting a change", () => {
    expect(BASELINE_RESET_NOTE).toContain(
      "establishes a new baseline instead of treating the new page as a detected change",
    );
  });

  it("says the runs already recorded stay", () => {
    expect(BASELINE_RESET_NOTE).toContain("Past runs are kept");
  });

  /**
   * The claims it must not make: a check that always works, history being
   * removed, a fetch or a model call caused by saving.
   */
  it.each([
    "The next check",
    "deleted",
    "removed",
    "immediately",
    "right away",
    "AI",
  ])("does not claim %o", (phrase) => {
    expect(BASELINE_RESET_NOTE).not.toContain(phrase);
  });
});

/**
 * What the schedule fields say about the clock they are read on.
 *
 * "In your timezone" was already here and did not prevent the thing it was
 * meant to prevent: an account starts on UTC, nothing on this form said so, and
 * a daily worker created by someone reading their own wall clock was scheduled
 * nine hours away from where they meant. The zone has to appear as a value, not
 * as a pronoun.
 */
describe("what the schedule says about the timezone", () => {
  it("names the account's zone next to the time field", () => {
    const html = render({ timezone: "Asia/Tokyo", values: { frequency: "daily" } });

    expect(html).toContain("Times use your account timezone: Asia/Tokyo.");
  });

  it("names UTC when that is what the account is on", () => {
    const html = render({ timezone: "UTC", values: { frequency: "daily" } });

    expect(html).toContain("Times use your account timezone: UTC.");
  });

  /** The blank-Run-at rule is unchanged; only the sentence around it grew. */
  it("still explains what leaving the time empty does", () => {
    const html = render({ timezone: "UTC", values: { frequency: "weekly" } });

    expect(html).toContain(
      "Leave empty to run at whatever time the worker was saved.",
    );
  });

  it.each(["prompt", "website"] as const)(
    "says the same thing for a %s worker",
    (kind) => {
      const html = render({
        kind,
        timezone: "Europe/Paris",
        values: { frequency: "daily", prompt: "x", websiteUrl: "https://e.com/" },
      });

      expect(html).toContain("Times use your account timezone: Europe/Paris.");
    },
  );

  /** A manual worker has no slot, so there is no time field to explain. */
  it("says nothing about times on a manual worker", () => {
    const html = render({ timezone: "UTC", values: { frequency: "manual" } });

    expect(html).not.toContain("Times use your account timezone");
  });
});

/**
 * The same fields, asked for in Japanese.
 *
 * **What changes is the label, and nothing on either side of it.** The names
 * the form submits, the values already in it and the shape of the markup are
 * the parts a language must not reach — a form that renamed its own inputs
 * would save something different depending on who was looking at it.
 */
describe("a form in Japanese", () => {
  const html = render({
    language: "ja",
    values: { name: "宝塚市 パブリック・コメント", frequency: "weekly" },
  });

  it("labels each field", () => {
    expect(html).toContain("名前");
    expect(html).toContain("説明");
    expect(html).toContain("プロンプト");
    expect(html).toContain("実行頻度");
    expect(html).toContain("ステータス");
  });

  it("names the cadences and the statuses", () => {
    expect(html).toContain("毎日");
    expect(html).toContain("毎週");
    expect(html).toContain("毎月");
    expect(html).toContain("手動");
    expect(html).toContain("稼働中");
    expect(html).toContain("一時停止");
    expect(html).toContain("下書き");
  });

  it("asks for a weekday in the word for weekdays", () => {
    expect(html).toContain("曜日");
    expect(html).toContain("保存した曜日と同じ");
    expect(html).toContain("月曜日");
  });

  it("asks for a date in the word for dates, without an English ordinal", () => {
    const monthly = render({ language: "ja", values: { frequency: "monthly" } });

    expect(monthly).toContain("日付");
    expect(monthly).toContain("保存した日と同じ");
    expect(monthly).toContain(">3日<");
    expect(monthly).not.toContain("3rd");
  });

  it("submits the same fields under the same names", () => {
    expect(html).toContain('name="name"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="prompt"');
    expect(html).toContain('name="frequency"');
    expect(html).toContain('name="status"');
    expect(html).toContain('value="active"');
    expect(html).toContain('value="weekly"');
  });

  it("leaves what was already typed exactly as it was", () => {
    expect(html).toContain("宝塚市 パブリック・コメント");
  });

  it("asks a website worker what to do about a change", () => {
    const website = render({ language: "ja", kind: "website", values: {} });

    expect(website).toContain("ページが変わったとき");
    expect(website).toContain("Web ページのアドレス");
    // A URL is not language: the example address is the same either way.
    expect(website).toContain("https://example.com/news");
  });

  it("names the account's zone in the note about times", () => {
    const scheduled = render({
      language: "ja",
      timezone: "Asia/Tokyo",
      values: { frequency: "daily" },
    });

    expect(scheduled).toContain("Asia/Tokyo");
    expect(scheduled).not.toContain("Times use your account timezone");
  });
});

/**
 * The same three promises, in Japanese.
 *
 * A translation is where this sentence is most likely to quietly weaken: every
 * clause describes a mechanism nobody can see, so a reader has only the words.
 */
describe("what the Japanese note about changing an address says", () => {
  it("promises a baseline only once a check has succeeded", () => {
    expect(BASELINE_RESET_NOTE_JA).toContain("次にチェックが成功した");
  });

  it("names establishing a baseline as the alternative to reporting a change", () => {
    expect(BASELINE_RESET_NOTE_JA).toContain(
      "「変更が検出された」として扱わず",
    );
    expect(BASELINE_RESET_NOTE_JA).toContain("新しい");
    expect(BASELINE_RESET_NOTE_JA).toContain("基準を作り直します");
  });

  it("says the runs already recorded stay", () => {
    expect(BASELINE_RESET_NOTE_JA).toContain("過去の実行履歴はそのまま残ります");
  });

  /**
   * The claims it must not make, in the words a Japanese reader would take
   * them from: a check that always works, history being removed, a fetch or a
   * model call caused by saving, or nothing happening at all.
   */
  it.each([
    "次回のチェック",
    "削除",
    "すぐに",
    "直ちに",
    "AI",
    "変更なし",
  ])("does not claim %o", (phrase) => {
    expect(BASELINE_RESET_NOTE_JA).not.toContain(phrase);
  });

  it("is shown on a Japanese website form, and only there", () => {
    const website = render({
      language: "ja",
      kind: "website",
      values: {},
      websiteUrlNote: BASELINE_RESET_NOTE_JA,
    });
    const prompt = render({
      language: "ja",
      values: {},
      websiteUrlNote: BASELINE_RESET_NOTE_JA,
    });

    expect(website).toContain("比較の基準はリセットされます");
    expect(prompt).not.toContain("比較の基準");
  });
});

/**
 * The one control on this form that reaches outside AutoOps.
 *
 * **What it says depends on the kind, because the event does.** A website
 * worker emails when the page moves — not on every check — and a prompt worker
 * emails when its run finishes; the shared failure line is what makes the
 * checkbox mean the same thing about a failure either way.
 *
 * **It is a checkbox, so it submits nothing when it is not ticked**, which is
 * what "off by default" looks like on the wire — see `readWorkerForm`.
 */
describe("the email notification setting", () => {
  it("is offered on both kinds, unticked unless the worker asked for it", () => {
    const prompt = render({ values: {} });
    const website = render({ kind: "website", values: {} });

    for (const html of [prompt, website]) {
      expect(html).toContain('name="emailNotificationsEnabled"');
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("Email notifications");
      expect(html).not.toContain("checked");
    }
  });

  it("is ticked for a worker that has it on", () => {
    const html = render({ values: { emailNotificationsEnabled: true } });

    expect(html).toContain("checked");
  });

  it("says what a website worker sends about", () => {
    const html = render({ kind: "website", values: {} });

    expect(html).toContain("Email me when this page changes.");
    expect(html).toContain("You will also be notified if the run fails.");
    expect(html).not.toContain("Email me when this worker finishes.");
  });

  it("says what a prompt worker sends about", () => {
    const html = render({ values: {} });

    expect(html).toContain("Email me when this worker finishes.");
    expect(html).toContain("You will also be notified if the run fails.");
    expect(html).not.toContain("Email me when this page changes.");
  });

  it("says both in Japanese", () => {
    const website = render({ language: "ja", kind: "website", values: {} });
    const prompt = render({ language: "ja", values: {} });

    expect(website).toContain("メール通知");
    expect(website).toContain(
      "このページの変更を検出したときにメールで通知します。",
    );
    expect(prompt).toContain(
      "この Worker の実行が完了したときにメールで通知します。",
    );
    expect(prompt).toContain("実行に失敗した場合も通知します。");
  });

  /** There is no address on this form, and adding one would change nothing. */
  it("asks for no recipient", () => {
    const html = render({ values: {} });

    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('name="notificationEmail"');
    expect(html).not.toContain('type="email"');
  });
});
