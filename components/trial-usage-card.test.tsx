import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrialUsageCard } from "@/components/trial-usage-card";
import { en } from "@/lib/i18n/en";
import { ja } from "@/lib/i18n/ja";
import type { TrialUsageView } from "@/lib/usage/trial-view";

/**
 * What the card puts on the screen, in both languages.
 *
 * **The format is the property under test.** Every quantity reads
 * `used / limit` and never as a remainder, because a trial can legitimately
 * begin past its AI limit — the carry-in — and "47 remaining" has no honest
 * reading at 63 of 50. A single format that is always true is the whole reason
 * this is fixed rather than left to whoever writes the next screen.
 *
 * **And what is absent is fixed too**: no upgrade button, because there is
 * nowhere to send anybody yet, and no trial wording at all for an account that
 * is not on one.
 */

function activeView(overrides: Partial<Extract<TrialUsageView, { kind: "active" }>> = {}) {
  return {
    kind: "active" as const,
    daysRemaining: 14,
    lines: [
      { kind: "aiProcessing", used: 3, limit: 50, status: "normal" as const },
      { kind: "manualRun", used: 0, limit: 20, status: "normal" as const },
      { kind: "discovery", used: 0, limit: 14, status: "normal" as const },
    ],
    activeWorkers: 1,
    activeWorkerLimit: 3,
    activeWorkerStatus: "normal" as const,
    carriedInOverLimit: false,
    ...overrides,
  };
}

/** The markup the card produced, as the existing component tests read it. */
function renderedHtml(view: TrialUsageView, language = "en"): string {
  return renderToStaticMarkup(
    <TrialUsageCard view={view} language={language} />,
  );
}

/**
 * Everything the card rendered, as text.
 *
 * Tags are stripped and entities decoded so that a sentence split across
 * elements still reads as one — `&quot;` and `&#x27;` are what
 * `renderToStaticMarkup` writes for quotes in copy.
 */
function renderedText(view: TrialUsageView, language = "en"): string {
  return renderedHtml(view, language)
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("a trial in its ordinary state", () => {
  it("shows how many days are left", () => {
    expect(renderedText(activeView())).toContain("14 days left");
  });

  it("writes every allowance as used over limit", () => {
    const text = renderedText(activeView());

    expect(text).toContain("3 / 50");
    expect(text).toContain("0 / 20");
    expect(text).toContain("0 / 14");
    expect(text).toContain("1 / 3");
  });

  /**
   * **No remainder anywhere.** This is the line that would fail if somebody
   * later added "47 left" beside the number, which cannot be written truthfully
   * for a trial that began at 63 of 50.
   */
  it("never states a remaining quantity", () => {
    const text = renderedText(activeView());

    expect(text).not.toMatch(/remaining/i);
    expect(text).not.toMatch(/\b47\b/);
    expect(text).not.toMatch(/-\d/);
  });

  it("names the allowances in the reader's language", () => {
    expect(renderedText(activeView())).toContain("AI processing");
    expect(renderedText(activeView(), "ja")).toContain("AI処理");
  });

  it("warns about nothing while everything is well under its limit", () => {
    const text = renderedText(activeView());

    expect(text).not.toContain("Approaching the limit");
    expect(text).not.toContain("Limit reached");
    expect(text).not.toContain("Over the limit");
  });
});

describe("a trial close to or past a limit", () => {
  function withAi(used: number, status: "approaching" | "reached" | "over") {
    return activeView({
      lines: [
        { kind: "aiProcessing", used, limit: 50, status },
        { kind: "manualRun", used: 0, limit: 20, status: "normal" },
        { kind: "discovery", used: 0, limit: 14, status: "normal" },
      ],
      carriedInOverLimit: status === "over",
    });
  }

  it("says it is approaching at four fifths", () => {
    const text = renderedText(withAi(40, "approaching"));

    expect(text).toContain("40 / 50");
    expect(text).toContain("Approaching the limit");
  });

  it("says the limit is reached at exactly the allowance", () => {
    const text = renderedText(withAi(50, "reached"));

    expect(text).toContain("50 / 50");
    expect(text).toContain("Limit reached");
  });

  /**
   * The case the format exists for: a trial that began past its AI limit
   * because of what the account spent before starting.
   */
  it("says it is over the limit, and why, at sixty-three of fifty", () => {
    const text = renderedText(withAi(63, "over"));

    expect(text).toContain("63 / 50");
    expect(text).toContain("Over the limit");
    expect(text).toContain(
      "AI processing used before your trial started has been carried over",
    );
  });

  it("explains the carry-in in Japanese too", () => {
    const text = renderedText(withAi(63, "over"), "ja");

    expect(text).toContain("63 / 50");
    expect(text).toContain("上限を超えています");
    expect(text).toContain("トライアル開始前に使った AI処理");
  });

  it("does not explain a carry-in when there was none", () => {
    const text = renderedText(withAi(50, "reached"));

    expect(text).not.toContain("carried over");
  });

  /**
   * **More workers than the trial allows is shown, not acted on.** Nothing was
   * paused, so nothing may say it was.
   */
  it("shows more workers than the limit without threatening to pause any", () => {
    const text = renderedText(
      activeView({ activeWorkers: 5, activeWorkerStatus: "over" }),
    );

    expect(text).toContain("5 / 3");
    expect(text).toContain("Over the limit");
    expect(text).not.toMatch(/pause/i);
    expect(text).not.toMatch(/disabled|stopped|suspend/i);
  });

  it("shows a full worker allowance as reached", () => {
    const text = renderedText(
      activeView({ activeWorkers: 3, activeWorkerStatus: "reached" }),
    );

    expect(text).toContain("3 / 3");
    expect(text).toContain("Limit reached");
  });
});

describe("a trial that has ended", () => {
  const expired = { kind: "expired" } as const;

  it("says so", () => {
    expect(renderedText(expired)).toContain("Your trial has ended");
  });

  /** The two things somebody is afraid of, answered on the card. */
  it("says the work is kept and nothing was charged", () => {
    const text = renderedText(expired);

    expect(text).toContain("still saved");
    expect(text).toContain("Nothing was deleted");
    expect(text).toContain("have not been charged");
  });

  it("says the same in Japanese", () => {
    const text = renderedText(expired, "ja");

    expect(text).toContain("トライアルが終了しました");
    expect(text).toContain("削除されたものはありません");
    expect(text).toContain("料金は発生していません");
  });

  /**
   * **No upgrade button, because there is nowhere to send anybody.** Paid plan
   * selection does not exist; a call to action leading to a page that is not
   * there is worse than none at all.
   */
  it("offers no upgrade call to action", () => {
    const html = renderedHtml(expired);

    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button");
    expect(renderedText(expired)).not.toMatch(
      /upgrade|choose a plan|pricing/i,
    );
  });

  it("offers no upgrade call to action in Japanese either", () => {
    expect(renderedHtml(expired, "ja")).not.toContain("<a");
    expect(renderedText(expired, "ja")).not.toContain("プランを選ぶ");
  });
});

describe("an account that is not on a trial", () => {
  it.each([
    ["the granted beta cohort and every bought plan", { kind: "hidden" } as const],
    [
      "somebody who has not started one yet",
      { kind: "pre-trial", aiUsed: 3, aiLimit: 50 } as const,
    ],
  ])("renders nothing at all for %s", (_label, view) => {
    expect(renderedHtml(view)).toBe("");
  });
});

/**
 * **Plan limits are not rate limits, and never borrow their words.** An hourly
 * allowance comes back by waiting; a trial's does not, so "try again later"
 * would be advice that never works.
 */
describe("the words it does not borrow", () => {
  it("never tells somebody to try again later", () => {
    for (const view of [
      activeView({ activeWorkers: 5, activeWorkerStatus: "over" }),
      { kind: "expired" } as const,
    ]) {
      const text = renderedText(view);

      expect(text).not.toMatch(/try again later/i);
    }

    expect(renderedText({ kind: "expired" }, "ja")).not.toContain(
      "しばらくしてから",
    );
  });

  it("uses none of the hourly rate-limit copy", () => {
    const rateLimited = [
      en["run.action.rateLimited"],
      en["run.action.discoveryRateLimited"],
      en["worker.draft.limitReached"],
    ];

    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (!key.startsWith("trial.")) {
        continue;
      }

      expect(rateLimited).not.toContain(en[key]);
    }
  });

  /** Both dictionaries carry every trial key, which the type already forces. */
  it("says all of it in both languages", () => {
    const trialKeys = (Object.keys(en) as (keyof typeof en)[]).filter((key) =>
      key.startsWith("trial."),
    );

    expect(trialKeys.length).toBeGreaterThan(10);

    for (const key of trialKeys) {
      expect(ja[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });

  /** The internal vocabulary stays internal. */
  it("exposes none of the internal names", () => {
    const trialCopy = (Object.keys(en) as (keyof typeof en)[])
      .filter((key) => key.startsWith("trial."))
      .flatMap((key) => [en[key], ja[key]])
      .join(" ");

    for (const internal of [
      "aiProcessing",
      "UsageCounter",
      "UsagePeriod",
      "ProviderUsageEvent",
      "entitlement",
      "trialing",
      "trial_expired",
    ]) {
      expect(trialCopy).not.toContain(internal);
    }
  });
});
