/**
 * The English copy, and the shape every other language is held to.
 *
 * **This file is the source of truth twice over.** It carries the words English
 * readers see, and — because `TranslationKey` is derived from its keys — it also
 * decides what a translation is allowed to contain. A key added here without a
 * Japanese counterpart is a type error in `ja.ts`, and a key only Japanese has
 * cannot be written at all.
 *
 * **Keys are flat and dotted rather than nested objects.** A nested shape reads
 * better in a file and worse everywhere else: `t()` would need a path walker,
 * missing keys would surface as `undefined` at runtime instead of at the type
 * level, and the parity check above would have to recurse. Flat keys make
 * `keyof typeof en` the whole contract.
 *
 * **Named by what the words are for, not where they sit.** `settings.language.*`
 * survives the section moving to another page; `settingsPage.thirdCard.label`
 * does not.
 */
export const en = {
  "settings.language.title": "Language",
  "settings.language.description":
    "The language AutoOps uses for its own screens. Your workers and what they produce are unaffected.",
  "settings.language.label": "Language",
  "settings.language.english": "English",
  "settings.language.japanese": "Japanese",
  "settings.language.save": "Save",
  "settings.language.saving": "Saving…",
  "settings.language.saved": "Language saved.",
  "settings.language.invalid": "Select a language from the list.",
  "settings.language.failed": "Could not save your language.",
} as const;

/**
 * Every key a translation may hold, and every key it must.
 *
 * Derived rather than declared, so the list cannot drift from the English copy
 * it describes.
 */
export type TranslationKey = keyof typeof en;
