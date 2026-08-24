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
   * and translate nothing. The two language names are the exception, and are
   * the same on purpose — see `ja.ts`.
   */
  it("says something different in Japanese, apart from the language names", () => {
    const identical = keys.filter((key) => en[key] === ja[key]);

    expect(identical).toEqual(["settings.language.english"]);
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
