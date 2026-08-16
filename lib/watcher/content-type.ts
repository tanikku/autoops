/** The media types normalization knows how to turn into text. */
const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Whether a response is markup this can extract a document from.
 *
 * **A narrower gate than the one the fetch applies, and a different question.**
 * `parseContentType` in `lib/watcher/body.ts` decides what may be *read* —
 * HTML and plain text both, because both are text. This decides what may be
 * *parsed as a document*, and plain text is not: running it through an HTML
 * parser would invent a document structure that the server never sent.
 *
 * **A missing header is refused**, matching what the fetch already does with
 * one. Guessing from the bytes is content sniffing, and the point of asking is
 * that the server said so.
 *
 * Parameters are dropped before comparing, so `text/html; charset=utf-8` is
 * `text/html`. The charset itself is not read here — see the note on decoding
 * in `lib/watcher/normalize.ts`.
 */
export function isHtmlContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }

  return HTML_MEDIA_TYPES.has(header.split(";")[0].trim().toLowerCase());
}
