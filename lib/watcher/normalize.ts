import { isHtmlContentType } from "@/lib/watcher/content-type";
import { WatcherError } from "@/lib/watcher/errors";
import { extractDocumentText } from "@/lib/watcher/extract";
import { contentHashOf } from "@/lib/watcher/hash";

/** A page reduced to what a comparison runs on, and the digest of it. */
export type NormalizedWebsiteContent = {
  normalizedContent: string;
  contentHash: string;
};

/**
 * Collapses every run of whitespace into one space and trims the ends.
 *
 * **Whitespace is the one difference that carries no meaning here.** Markup is
 * indented, minified, and re-indented by tools that never touched the words;
 * text nodes arrive carrying the newlines between tags; a block boundary is
 * emitted as a newline by the extraction above. All of it has to collapse to
 * the same thing or a reformatted template would read as a changed page.
 *
 * `\s` is the whole of what is collapsed, which covers the ordinary space
 * characters — tabs, newlines, the non-breaking space, the en and em spaces,
 * the ideographic space. **Zero-width characters are left alone**: they are not
 * spaces, and removing them would be editing the text rather than tidying it.
 *
 * Nothing else is touched. No case folding, no Unicode normalisation, no
 * punctuation smoothing — each of those would make two genuinely different
 * strings compare equal, and a watcher that misses a change is worse than one
 * that reports an extra.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Turns a fetched page into the text a change is measured on.
 *
 * ```
 * eligibility → parse → extract → collapse whitespace → digest
 * ```
 *
 * **Pure, and deliberately so.** It reads no database, writes none, calls no
 * model, and knows nothing about workers or schedules. The same markup always
 * produces the same pair, which is what lets "has this changed" be answered by
 * comparing two values rather than by asking anything.
 *
 * **What it will not do is guess.** A response that does not say it is HTML is
 * refused rather than sniffed, because parsing plain text as a document invents
 * a structure the server never sent.
 *
 * **The bytes were decoded as UTF-8 before this saw them** — the fetch returns
 * a string and keeps no bytes — so a page served in another encoding arrives
 * already mangled and there is nothing here that can tell. That is a limit of
 * the layer below rather than a decision taken here; see the sprint report.
 *
 * An empty result is a result. A page whose entire body is a script normalizes
 * to `""`, and that is a baseline like any other: it hashes, it stores, and
 * text appearing there later is a change. **Empty is not an error** — the
 * failure to fetch is, and the two must not be confused.
 */
export function normalizeWebsiteContent(
  html: string,
  contentType: string | undefined,
): NormalizedWebsiteContent {
  if (!isHtmlContentType(contentType)) {
    throw new WatcherError(
      "unsupported-content-type",
      "Only HTML pages can be watched for changes.",
    );
  }

  const normalizedContent = normalizeWhitespace(extractDocumentText(html));

  return { normalizedContent, contentHash: contentHashOf(normalizedContent) };
}
