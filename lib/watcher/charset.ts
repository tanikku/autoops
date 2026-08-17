/**
 * The encodings Website Watcher decodes, named as the platform names them.
 *
 * **These are the labels `TextDecoder` itself accepts**, which is why they are
 * spelled this way rather than the way a specification table might. `shift_jis`
 * is the canonical name for what is in practice Windows-31J: the index the
 * platform decodes with covers the CP932 extensions, so `①` at `0x87 0x40`
 * comes back as `①` rather than as an error.
 *
 * Deliberately short. Every encoding here is one somebody has a real page in;
 * the rest are refused by name rather than attempted, because a wrong decode is
 * stored as though it were right.
 */
export const supportedCharsets = [
  "utf-8",
  "shift_jis",
  "euc-jp",
  "utf-16le",
  "utf-16be",
] as const;

export type SupportedWebsiteCharset = (typeof supportedCharsets)[number];

/**
 * Every spelling of a supported encoding that a page might actually use.
 *
 * **Wider than what `TextDecoder` accepts, and that is the reason it exists.**
 * `cp932`, `windows-932` and `euc_jp` are all in the wild and all rejected by
 * the platform's own label table; mapping them here is the difference between
 * reading such a page and refusing it. What the table must never do is invent a
 * mapping — every value on the right was checked against the decoder.
 */
const CHARSET_ALIASES = new Map<string, SupportedWebsiteCharset>([
  // UTF-8
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["unicode-1-1-utf-8", "utf-8"],
  ["csutf8", "utf-8"],
  // Shift_JIS, which is Windows-31J in everything but name
  ["shift_jis", "shift_jis"],
  ["shift-jis", "shift_jis"],
  ["sjis", "shift_jis"],
  ["x-sjis", "shift_jis"],
  ["ms_kanji", "shift_jis"],
  ["csshiftjis", "shift_jis"],
  ["windows-31j", "shift_jis"],
  ["cp932", "shift_jis"],
  ["ms932", "shift_jis"],
  ["windows-932", "shift_jis"],
  // EUC-JP
  ["euc-jp", "euc-jp"],
  ["euc_jp", "euc-jp"],
  ["eucjp", "euc-jp"],
  ["x-euc-jp", "euc-jp"],
  ["cseucpkdfmtjapanese", "euc-jp"],
  // UTF-16. Bare `utf-16` means little-endian, as it does everywhere else.
  ["utf-16le", "utf-16le"],
  ["utf-16", "utf-16le"],
  ["utf-16be", "utf-16be"],
]);

/**
 * The encoding a label names, or null if it is not one of the supported ones.
 *
 * Case-insensitive and untroubled by the quoting and padding a header brings
 * with it, because `Charset="Windows-31J"` and `charset=windows-31j` are the
 * same claim written twice.
 *
 * **Null is a refusal, not a fallback.** A label this does not know is an
 * encoding this cannot read, and the caller says so rather than guessing.
 */
export function resolveSupportedCharset(
  label: string | null | undefined,
): SupportedWebsiteCharset | null {
  if (label === null || label === undefined) {
    return null;
  }

  const normalized = label.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();

  return CHARSET_ALIASES.get(normalized) ?? null;
}
