/** The media types Website Watcher reads as a document. */
export type WebsiteMediaType = "text/html" | "application/xhtml+xml";

const HTML_MEDIA_TYPES = new Set<string>([
  "text/html",
  "application/xhtml+xml",
]);

/** What a `Content-Type` header said, taken apart. */
export type ContentTypeInfo = {
  /** Lower-cased, parameters removed. Empty when the header said nothing. */
  mediaType: string;
  /** The `charset` parameter as written, or null when there was none. */
  charset: string | null;
};

/**
 * Reads a `Content-Type` header into the two things that are acted on.
 *
 * **Both halves matter and they are used by different layers**, which is why
 * this returns them together rather than answering a yes-or-no question: the
 * media type decides whether there is a document here at all, and the charset
 * decides how to turn the bytes into text. Narrowing to the first and throwing
 * the second away is what made the fetch decode everything as UTF-8.
 *
 * Written to survive what headers really look like — any parameter order,
 * any casing, quoted or bare values, extra parameters nobody asked for:
 *
 * ```
 * text/html
 * text/html; charset=utf-8
 * text/html;charset=Shift_JIS
 * TEXT/HTML; Charset="windows-31j"
 * application/xhtml+xml; charset=UTF-8; boundary=x
 * ```
 *
 * The charset comes back as it was written. Deciding whether it names something
 * that can be decoded is `resolveSupportedCharset`'s job, and keeping the two
 * apart means an unknown label is reported as unknown rather than disappearing
 * here.
 */
export function parseContentTypeHeader(
  header: string | undefined,
): ContentTypeInfo {
  if (header === undefined) {
    return { mediaType: "", charset: null };
  }

  const [essence, ...parameters] = header.split(";");
  let charset: string | null = null;

  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== "charset") {
      continue;
    }

    const value = parameter.slice(separator + 1).trim();
    // The first `charset` wins. A header carrying two is malformed, and
    // preferring the last one would make the answer depend on how it was
    // malformed.
    charset = value === "" ? null : value;
    break;
  }

  return { mediaType: essence.trim().toLowerCase(), charset };
}

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
 */
export function isHtmlContentType(header: string | undefined): boolean {
  return HTML_MEDIA_TYPES.has(parseContentTypeHeader(header).mediaType);
}

/** Whether a media type, already parsed, is one this reads as a document. */
export function isHtmlMediaType(
  mediaType: string,
): mediaType is WebsiteMediaType {
  return HTML_MEDIA_TYPES.has(mediaType);
}
