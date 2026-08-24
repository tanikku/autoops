import type { TranslationKey } from "@/lib/i18n/en";

/**
 * The Japanese copy.
 *
 * **`Record<TranslationKey, string>` is what keeps the two in step.** Leaving a
 * key out fails to compile, and inventing one that English does not have fails
 * too — so "the Japanese file is missing a line" cannot reach a screen, and
 * cannot reach a test either. It is caught where it is cheapest.
 *
 * **The language names are not both translated.** English readers choosing
 * between languages read "Japanese"; Japanese readers read「日本語」, because
 * that is what the language calls itself and what somebody looking for it will
 * scan for. A menu that renders「英語」and「日本語」to one reader and "English"
 * and "Japanese" to the other is symmetric and less useful than one where each
 * option is legible to the person who needs it.
 */
export const ja: Record<TranslationKey, string> = {
  "settings.language.title": "言語",
  "settings.language.description":
    "AutoOps の画面に使う言語です。Worker と、その出力には影響しません。",
  "settings.language.label": "言語",
  "settings.language.english": "English",
  "settings.language.japanese": "日本語",
  "settings.language.save": "保存",
  "settings.language.saving": "保存中…",
  "settings.language.saved": "言語を保存しました。",
  "settings.language.invalid": "一覧から言語を選んでください。",
  "settings.language.failed": "言語を保存できませんでした。",
};
