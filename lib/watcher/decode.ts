import {
  resolveSupportedCharset,
  type SupportedWebsiteCharset,
} from "@/lib/watcher/charset";
import {
  isHtmlMediaType,
  parseContentTypeHeader,
  type WebsiteMediaType,
} from "@/lib/watcher/content-type";
import { WatcherError } from "@/lib/watcher/errors";

/** A response turned into text, and the two decisions that produced it. */
export type DecodedWebsiteContent = {
  content: string;
  mediaType: WebsiteMediaType;
  charset: SupportedWebsiteCharset;
};

/**
 * How far into the body a declared encoding is looked for.
 *
 * **The whole body is never decoded to find out how to decode it.** Only this
 * many bytes are examined, and only as ASCII, which is all a `charset` label
 * can be written in.
 *
 * The HTML standard's own prescan stops at 1,024 bytes, and a browser that
 * finds nothing by then falls back on detection. **This has no detection to
 * fall back on** — guessing an encoding from the bytes is the one thing
 * forbidden here — so it reads further before giving up: a declaration at byte
 * 2,000 is a fact about the page, and using it beats defaulting to UTF-8 and
 * failing. Eight kibibytes is a fixed cost against a body that may be two
 * megabytes, and it is a constant so that what was scanned is never in doubt.
 */
export const META_CHARSET_SCAN_BYTES = 8 * 1024;

/** Byte order marks, longest first so a prefix never matches ahead of one. */
const BYTE_ORDER_MARKS: {
  bytes: number[];
  charset: SupportedWebsiteCharset;
}[] = [
  { bytes: [0xef, 0xbb, 0xbf], charset: "utf-8" },
  { bytes: [0xff, 0xfe], charset: "utf-16le" },
  { bytes: [0xfe, 0xff], charset: "utf-16be" },
];

/**
 * Finds `charset=` in a chunk of markup, in either of the two ways it is
 * written.
 *
 * One expression covers both because both end in the same three characters:
 *
 * ```html
 * <meta charset="Shift_JIS">
 * <meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">
 * ```
 */
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:+.]+)/i;

/**
 * Turns a fetched response into text, or says why it cannot.
 *
 * **This is the layer that used to not exist.** The fetch decoded everything as
 * UTF-8 and threw the bytes away, so a page in any other encoding arrived
 * already mangled and nothing downstream could tell. Splitting the two apart
 * means the fetch keeps what it was given and this decides what it means.
 *
 * The encoding is resolved from what the response actually says, in this order:
 *
 * 1. **A byte order mark.** The bytes' own claim about themselves, and the
 *    hardest to get wrong.
 * 2. **The `charset` in the HTTP header.** The server's claim.
 * 3. **A `<meta>` declaration in the markup.** The document's claim, read from
 *    a bounded prefix and only when the two above said nothing.
 * 4. **UTF-8**, which is what the overwhelming majority of pages are.
 *
 * **Nothing is guessed from the shape of the bytes.** No detection library, no
 * "this looks like Shift_JIS": a wrong guess produces text that is subtly wrong
 * rather than obviously broken, and it would be stored as a baseline and
 * compared against for as long as the worker exists.
 *
 * For the same reason, decoding is strict. Bytes that are invalid in the
 * encoding they were said to be in are a failure, not a page full of
 * replacement characters — the second is indistinguishable from a page that
 * really did change.
 */
export function decodeWebsiteContent(
  bytes: Uint8Array,
  contentTypeHeader: string | undefined,
): DecodedWebsiteContent {
  const { mediaType, charset: declaredCharset } =
    parseContentTypeHeader(contentTypeHeader);

  if (!isHtmlMediaType(mediaType)) {
    throw new WatcherError(
      "unsupported-content-type",
      mediaType === ""
        ? "The response did not say what kind of document it was."
        : `AutoOps does not watch ${mediaType} pages.`,
    );
  }

  const bom = detectByteOrderMark(bytes);
  const fromHeader = resolveHeaderCharset(declaredCharset);

  if (bom !== null && fromHeader !== null && bom.charset !== fromHeader) {
    // **Neither side is obviously right, so neither is chosen.** A mark saying
    // UTF-16 over a header saying Shift_JIS is a broken response however it is
    // read, and picking one silently is how the wrong reading gets stored.
    throw new WatcherError(
      "encoding-conflict",
      `The page begins with a ${bom.charset} byte order mark but its header says ${fromHeader}.`,
    );
  }

  const charset =
    bom?.charset ??
    fromHeader ??
    resolveMetaCharset(bytes, bom?.length ?? 0) ??
    "utf-8";

  // The mark is removed rather than decoded, so nothing downstream has to know
  // it was ever there — a leading `﻿` would otherwise reach the hash and
  // make the same page in two encodings compare as two different pages.
  const body = bom === null ? bytes : bytes.subarray(bom.length);

  return { content: decodeStrictly(body, charset), mediaType, charset };
}

/** The mark the body starts with, if it starts with one this knows. */
function detectByteOrderMark(
  bytes: Uint8Array,
): { charset: SupportedWebsiteCharset; length: number } | null {
  for (const mark of BYTE_ORDER_MARKS) {
    if (
      bytes.length >= mark.bytes.length &&
      mark.bytes.every((byte, index) => bytes[index] === byte)
    ) {
      return { charset: mark.charset, length: mark.bytes.length };
    }
  }

  return null;
}

/**
 * The header's charset, refused rather than ignored when it names something
 * unreadable.
 *
 * **An unknown label is not the same as no label.** Falling through to UTF-8
 * because a page said `charset=big5` would decode it as something it plainly is
 * not, so a label that was given and cannot be honoured stops here.
 */
function resolveHeaderCharset(
  declared: string | null,
): SupportedWebsiteCharset | null {
  if (declared === null) {
    return null;
  }

  const resolved = resolveSupportedCharset(declared);
  if (resolved === null) {
    throw new WatcherError(
      "unsupported-charset",
      `AutoOps does not decode pages in ${declared}.`,
    );
  }

  return resolved;
}

/**
 * A `<meta>` charset from the start of the body, or null if there is none.
 *
 * The prefix is read as Latin-1 — one byte to one character, no validation, no
 * exceptions — because a charset label is ASCII and this only has to find one.
 * **Decoding the prefix as UTF-8 would be the bug this whole module exists to
 * avoid**, in miniature: it would fail on the very pages whose declaration
 * matters.
 *
 * An unreadable label here is a refusal for the same reason it is in the
 * header: the page said something, and it was not something this can honour.
 */
function resolveMetaCharset(
  bytes: Uint8Array,
  offset: number,
): SupportedWebsiteCharset | null {
  const end = Math.min(bytes.length, offset + META_CHARSET_SCAN_BYTES);
  const prefix = Buffer.from(
    bytes.buffer,
    bytes.byteOffset + offset,
    end - offset,
  ).toString("latin1");

  const declared = META_CHARSET.exec(prefix)?.[1];
  if (declared === undefined) {
    return null;
  }

  const resolved = resolveSupportedCharset(declared);
  if (resolved === null) {
    throw new WatcherError(
      "unsupported-charset",
      `AutoOps does not decode pages in ${declared}.`,
    );
  }

  return resolved;
}

/**
 * Decodes, refusing anything the encoding cannot account for.
 *
 * `fatal` is the whole point. Without it a byte that means nothing in the
 * declared encoding becomes `�` and the page decodes "successfully" into
 * something wrong — which is then hashed, stored, and compared against.
 */
function decodeStrictly(
  bytes: Uint8Array,
  charset: SupportedWebsiteCharset,
): string {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WatcherError(
      "invalid-encoding",
      `The page is not valid ${charset}.`,
      { cause: error },
    );
  }
}
