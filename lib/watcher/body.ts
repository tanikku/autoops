import { WatcherError } from "@/lib/watcher/errors";

/**
 * What the fetch is willing to read.
 *
 * **Wider than what Website Watcher watches, and that is the split.** This is
 * the transport's question — is this a text document at all — and
 * `lib/watcher/content-type.ts` asks the narrower one about which of these can
 * be parsed as a document. `text/plain` passes here and is refused there.
 *
 * Adding a media type to this list is not a loosening of anything the security
 * policy holds: addresses, ports, redirects, size and time are decided before a
 * byte of body is read, and none of them consults this.
 */
export type SupportedContentType =
  | "text/html"
  | "application/xhtml+xml"
  | "text/plain";

const SUPPORTED_CONTENT_TYPES = new Set<string>([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);

/**
 * Which of the supported types a response says it is, or null for anything else.
 *
 * **A missing header is refused, not guessed at.** Sniffing is how a PDF gets
 * read as text and how an image gets stored as a snapshot; there is no upside
 * to it here, because a page worth watching is served by something that says
 * what it is serving.
 *
 * Parameters are dropped before comparing — `text/html; charset=utf-8` is
 * `text/html`. **The charset is not this function's business and is no longer
 * lost**: the header travels on with the response, and
 * `lib/watcher/decode.ts` reads it there.
 */
export function parseContentType(
  header: string | undefined,
): SupportedContentType | null {
  if (header === undefined) {
    return null;
  }

  const essence = header.split(";")[0].trim().toLowerCase();

  return SUPPORTED_CONTENT_TYPES.has(essence)
    ? (essence as SupportedContentType)
    : null;
}

/**
 * Reads a body, refusing it the moment it grows past what may be read.
 *
 * **Counted while it arrives, not checked when it is done.** The alternative is
 * to trust `content-length`, which is a claim the origin makes and is absent
 * from exactly the responses that matter — a body that never ends does not
 * announce its length. By the time an unchecked read finished there would be
 * nothing left to refuse it with.
 *
 * **The limit is bytes, and it stays bytes.** It is a bound on memory, so it
 * has to be measured in the thing being held; counting characters would mean
 * decoding first, which is both the wrong unit and the wrong order.
 *
 * It stops on the chunk that crosses the line rather than after it, so the most
 * that is ever held is one chunk beyond the limit.
 *
 * **What comes back is what arrived.** This used to decode as UTF-8 and return
 * a string, which quietly made every page in another encoding into mangled text
 * that nothing downstream could recognise as mangled — the bytes it would have
 * taken to notice were already gone. Deciding what the bytes mean belongs to
 * `lib/watcher/decode.ts`, which has the header to do it with.
 *
 * The stream is an `AsyncIterable` rather than a response, which is what lets
 * this be tested with three strings instead of a server.
 */
export async function readBodyWithLimit(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; byteLength: number }> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  for await (const chunk of stream) {
    byteLength += chunk.byteLength;

    if (byteLength > limit) {
      throw new WatcherError(
        "response-too-large",
        `The page is larger than the ${limit.toLocaleString("en-US")} bytes AutoOps will read.`,
      );
    }

    chunks.push(chunk);
  }

  return { bytes: concat(chunks), byteLength };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);

  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return joined;
}
