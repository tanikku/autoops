import { describe, expect, it } from "vitest";
import { en, type TranslationKey } from "@/lib/i18n/en";
import { ja } from "@/lib/i18n/ja";
import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  supportedLanguages,
  t,
} from "@/lib/i18n";

/**
 * What a dictionary has to hold, and what asking for a word cannot do.
 *
 * **Most of this is already the compiler's job.** `ja` is typed as
 * `Record<TranslationKey, string>`, so a missing line does not build and an
 * invented key does not either. These tests cover what a type cannot say —
 * that the strings are actually there, that they are not the English ones by
 * accident, and that a value nobody planned for still renders a page.
 */

const keys = Object.keys(en) as TranslationKey[];

describe("the dictionaries", () => {
  it("cover the same keys, in both directions", () => {
    expect(Object.keys(ja).sort()).toEqual(keys.slice().sort());
  });

  it.each(["en", "ja"] as const)("leaves nothing blank in %s", (language) => {
    const empty = keys.filter((key) => t(language, key).trim() === "");

    expect(empty).toEqual([]);
  });

  /**
   * A Japanese dictionary that copied English would pass a key-parity check
   * and translate nothing. The exceptions are listed rather than counted: each
   * one is a word that is the same in both languages on purpose.
   */
  it("says something different in Japanese, apart from the words that do not translate", () => {
    const identical = keys.filter((key) => en[key] === ja[key]);

    expect(identical).toEqual([
      // The product's own noun, on the execution page.
      "run.detail.worker",
      // A language's own name for itself.
      "settings.language.english",
    ]);
  });

  it("knows which languages exist", () => {
    expect(supportedLanguages).toEqual(["en", "ja"]);
    expect(DEFAULT_LANGUAGE).toBe("en");
  });
});

describe("recognising a language", () => {
  it.each(["en", "ja"])("accepts %s", (value) => {
    expect(isSupportedLanguage(value)).toBe(true);
  });

  it.each(["", "EN", "en-US", "ja-JP", "fr", "english", "日本語"])(
    "refuses %o",
    (value) => {
      expect(isSupportedLanguage(value)).toBe(false);
    },
  );
});

describe("asking for a word", () => {
  it("answers in the language asked for", () => {
    expect(t("en", "settings.language.saved")).toBe("Language saved.");
    expect(t("ja", "settings.language.saved")).toBe("言語を保存しました。");
  });

  /**
   * A stored value this version cannot read has to render *something*. English
   * is a confusing answer; a blank page is a worse one.
   */
  it.each(["", "fr", "en-GB", "ja-JP", "Mars/Olympus"])(
    "falls back to English for %o",
    (language) => {
      expect(t(language, "settings.language.saved")).toBe(
        en["settings.language.saved"],
      );
    },
  );

  it("never returns undefined, whatever it is handed", () => {
    for (const language of ["en", "ja", "fr", ""]) {
      for (const key of keys) {
        expect(typeof t(language, key)).toBe("string");
      }
    }
  });
});

/**
 * Sentences that carry a number.
 *
 * The count goes inside the string because the two languages put it in
 * different places — "3 runs" against「実行 3 回」— and a component that glued
 * a number to a word would be writing English word order into both.
 */
describe("filling in a sentence", () => {
  it("puts the count where each language wants it", () => {
    expect(t("en", "health.runs.other", { count: 3 })).toBe("3 runs");
    expect(t("ja", "health.runs.other", { count: 3 })).toBe("実行 3 回");
  });

  it("uses the singular only in the language that has one", () => {
    expect(t("en", "health.runs.one", { count: 1 })).toBe("1 run");
    expect(t("en", "health.failures.one", { count: 1 })).toBe("1 failure");
    // Japanese does not inflect for number: both forms are the same sentence.
    expect(t("ja", "health.runs.one", { count: 1 })).toBe(
      t("ja", "health.runs.other", { count: 1 }),
    );
  });

  it("takes several values in one sentence", () => {
    expect(
      t("en", "schedule.atTime", { cadence: "Every day", time: "09:00" }),
    ).toBe("Every day at 09:00");
    expect(t("ja", "schedule.atTime", { cadence: "毎日", time: "09:00" })).toBe(
      "毎日 09:00",
    );
  });

  /**
   * Each language takes the form it needs from the same call. "the 3rd" is an
   * English rule, and a Japanese sentence carrying it would read as a typo.
   */
  it("offers an ordinal and a plain number, and each language picks one", () => {
    const values = { ordinal: "3rd", day: 3 };

    expect(t("en", "schedule.onDay", values)).toBe("On the 3rd");
    expect(t("ja", "schedule.onDay", values)).toBe("毎月3日");
  });

  it("leaves a placeholder nobody filled visible rather than blank", () => {
    expect(t("en", "health.runs.other", {})).toBe("{count} runs");
  });

  it("changes nothing when a sentence has no placeholders", () => {
    expect(t("en", "nav.dashboard", { count: 5 })).toBe("Dashboard");
  });
});

/**
 * Words that belong to the product rather than to a language.
 */
describe("what is never translated", () => {
  it("keeps Worker as Worker in Japanese", () => {
    expect(ja["dashboard.hireWorker"]).toContain("Worker");
    expect(ja["dashboard.workers"]).toContain("Worker");
    expect(ja["overview.total"]).toContain("Worker");
  });

  it("keeps AutoOps as AutoOps in Japanese", () => {
    for (const key of keys) {
      if (en[key].includes("AutoOps")) {
        expect(ja[key]).toContain("AutoOps");
      }
    }
  });
});

/**
 * The stored values these labels describe.
 *
 * Every status a column can hold has a word in both languages, and none of the
 * words is the stored value — translating a badge must never be a way of
 * changing what is in the database.
 */
describe("labels for stored values", () => {
  it.each(["active", "paused", "draft"])("names the %o status", (status) => {
    const key = `common.status.${status}` as TranslationKey;

    expect(t("en", key)).not.toBe("");
    expect(t("ja", key)).not.toBe("");
    expect(t("ja", key)).not.toBe(status);
  });

  it.each(["running", "completed", "failed"])("names the %o run", (status) => {
    const key = `common.runStatus.${status}` as TranslationKey;

    expect(t("en", key)).not.toBe("");
    expect(t("ja", key)).not.toBe("");
    expect(t("ja", key)).not.toBe(status);
  });

  it("names every weekday in both languages", () => {
    const days = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];

    for (const day of days) {
      const key = `common.weekday.${day}` as TranslationKey;
      expect(t("en", key).length).toBeGreaterThan(0);
      expect(t("ja", key)).toContain("曜日");
    }
  });
});

/**
 * The screens Day 2B translated, checked at the dictionary rather than at the
 * markup: that every sentence they need exists in both languages, and that the
 * ones carrying a value carry it in a place each language chose.
 */
describe("the worker and run screens", () => {
  it("has every key those screens ask for, in both languages", () => {
    const used: TranslationKey[] = [
      "worker.kind.prompt",
      "worker.kind.website",
      "worker.kind.promptOption",
      "worker.kind.websiteOption",
      "worker.prompt",
      "worker.changeInstructions",
      "worker.field.name",
      "worker.field.websiteUrl",
      "worker.field.changePrompt",
      "worker.field.frequency",
      "worker.field.weekday",
      "worker.field.monthDay",
      "worker.field.runAt",
      "worker.create.draftHeading",
      "worker.create.createDraft",
      "worker.create.applyToForm",
      "worker.create.templatesHeading",
      "worker.detail.workerType",
      "worker.detail.unrecognised",
      "worker.detail.watchedPage",
      "worker.edit.title",
      "worker.edit.baselineReset",
      "run.detail.title",
      "run.detail.output",
      "run.detail.error",
      "run.detail.renderedPrompt",
    ];

    for (const key of used) {
      for (const language of ["en", "ja"]) {
        expect(t(language, key).trim().length).toBeGreaterThan(0);
        // A key rendered as itself is the fallback, not a translation.
        expect(t(language, key)).not.toBe(key);
      }
    }
  });

  /**
   * The two vocabularies for the same two stored values. Choosing what a
   * worker should do and reading what one is are different questions, and the
   * hire form is allowed to answer in different words.
   */
  it("names a kind differently where it is chosen and where it is reported", () => {
    expect(t("en", "worker.kind.promptOption")).not.toBe(
      t("en", "worker.kind.prompt"),
    );
    expect(t("ja", "worker.kind.websiteOption")).not.toBe(
      t("ja", "worker.kind.website"),
    );
  });

  it("never puts a stored value on screen as its own label", () => {
    for (const language of ["en", "ja"]) {
      expect(t(language, "worker.kind.prompt")).not.toBe("prompt");
      expect(t(language, "worker.kind.website")).not.toBe("website");
      expect(t(language, "worker.frequency.daily")).not.toBe("daily");
    }
  });

  it("places the worker's name inside the question rather than beside it", () => {
    const name = "宝塚市 パブリック・コメント";

    expect(t("en", "worker.delete.confirmTitle", { name })).toContain(name);
    expect(t("ja", "worker.delete.confirmTitle", { name })).toContain(name);
    // Two different sentences, and the same name in both.
    expect(t("en", "worker.delete.confirmTitle", { name })).not.toBe(
      t("ja", "worker.delete.confirmTitle", { name }),
    );
  });

  it("puts the account's zone into the note about times", () => {
    for (const language of ["en", "ja"]) {
      expect(
        t(language, "worker.field.timezoneNote", { timezone: "Asia/Tokyo" }),
      ).toContain("Asia/Tokyo");
    }
  });

  it("offers a date as an ordinal and as a number, and each language picks one", () => {
    const values = { ordinal: "3rd", day: 3 };

    expect(t("en", "worker.field.monthDayOption", values)).toBe("3rd");
    expect(t("ja", "worker.field.monthDayOption", values)).toBe("3日");
  });

  it("keeps the drafted worker's own words out of the sentence around them", () => {
    const url = "https://example.com/news";

    for (const language of ["en", "ja"]) {
      expect(t(language, "worker.create.draftWatches", { url })).toContain(url);
    }
  });

  it("names the character limit rather than hard-coding it", () => {
    for (const language of ["en", "ja"]) {
      expect(t(language, "worker.draft.tooLong", { limit: "2,000" })).toContain(
        "2,000",
      );
    }
  });
});

/**
 * The sentence about changing a watched address, in both languages.
 *
 * Every clause describes a mechanism nobody can see, so the words are the only
 * account of it anyone gets. The English version has been held to these since
 * B4.3; a translation is where they are most likely to weaken quietly.
 */
describe("what changing an address is said to cost", () => {
  it("promises a baseline only once a check has succeeded", () => {
    expect(t("en", "worker.edit.baselineReset")).toContain(
      "next successful check",
    );
    expect(t("ja", "worker.edit.baselineReset")).toContain(
      "次にチェックが成功した",
    );
  });

  it("names establishing a baseline as the alternative to reporting a change", () => {
    expect(t("en", "worker.edit.baselineReset")).toContain(
      "establishes a new baseline instead of treating the new page as a detected change",
    );
    expect(t("ja", "worker.edit.baselineReset")).toContain(
      "「変更が検出された」として扱わず",
    );
  });

  it("says the runs already recorded stay", () => {
    expect(t("en", "worker.edit.baselineReset")).toContain("Past runs are kept");
    expect(t("ja", "worker.edit.baselineReset")).toContain(
      "過去の実行履歴はそのまま残ります",
    );
  });

  it.each([
    ["en", ["The next check", "deleted", "removed", "immediately", "AI"]],
    ["ja", ["次回のチェック", "削除", "すぐに", "直ちに", "AI", "変更なし"]],
  ] as const)("claims none of the forbidden things in %s", (language, phrases) => {
    for (const phrase of phrases) {
      expect(t(language, "worker.edit.baselineReset")).not.toContain(phrase);
    }
  });
});
