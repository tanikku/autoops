import { en, type TranslationKey } from "@/lib/i18n/en";
import { ja } from "@/lib/i18n/ja";

/**
 * Which language AutoOps speaks to a person in.
 *
 * **This is about the product's own words, and nothing else.** A worker's
 * instructions, the pages it watches, and whatever a model writes back are the
 * person's own material: setting the interface to Japanese does not translate
 * them, and must not. Somebody reading a Japanese dashboard while running a
 * worker that summarises English news is doing exactly what this separation is
 * for.
 *
 * **A closed set narrowed from a plain string column**, the same shape as
 * `RoutineStatus` and `SupportedTimezone`. Adding a language is a line here and
 * a file beside it — not a migration, which is why the column is `String`
 * rather than a database enum.
 */
export const supportedLanguages = ["en", "ja"] as const;

export type Language = (typeof supportedLanguages)[number];

/**
 * What a person gets before they have said otherwise, and what an unreadable
 * value falls back to.
 *
 * English rather than a guess. A timezone of `Asia/Tokyo` says where somebody's
 * clock is, not which language they read — and a product that decided otherwise
 * would be wrong about every English speaker in Japan.
 */
export const DEFAULT_LANGUAGE: Language = "en";

export function isSupportedLanguage(value: string): value is Language {
  return (supportedLanguages as readonly string[]).includes(value);
}

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  en,
  ja,
};

export type { TranslationKey };

/**
 * The words for a key, in the language asked for.
 *
 * **Falls back rather than throwing, twice.** A stored language this version
 * does not know answers in English, and a key with nothing behind it answers
 * with the key itself. Neither should ever happen — the column is validated on
 * the way in and the keys are checked by the compiler — but the alternative to
 * falling back is a screen that will not render, and an untranslated label is a
 * smaller failure than a blank page.
 *
 * **Takes the language rather than reading it.** Where it comes from is the
 * caller's business: a server component reads the account row, and a client
 * component is handed the string as a prop. Nothing here touches a request, a
 * cookie, or the browser — which is also why the same function works on both
 * sides of that boundary without a provider.
 */
export function t(
  language: string,
  key: TranslationKey,
  values?: Record<string, string | number>,
): string {
  const dictionary = isSupportedLanguage(language)
    ? dictionaries[language]
    : dictionaries[DEFAULT_LANGUAGE];

  const text = dictionary[key] ?? en[key] ?? key;

  return values ? fill(text, values) : text;
}

/**
 * Puts the values into their places.
 *
 * **Why a sentence holds its own number instead of being glued to one.**
 * "3 runs" and「実行 3 回」put the count in different places and wrap it in
 * different words; a component that concatenated the parts would be writing
 * English word order into every language. The dictionary decides where the
 * number goes because that is a property of the sentence.
 *
 * A placeholder with nothing supplied for it is left as written. It is a
 * mistake either way, and a visible `{count}` says which key to look at —
 * where an empty gap would only look like a missing word.
 */
function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in values ? String(values[name]) : placeholder,
  );
}
