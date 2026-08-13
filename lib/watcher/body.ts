import { WatcherError } from "@/lib/watcher/errors";

/** The two things this sprint knows how to read. */
export type SupportedContentType = "text/html" | "text/plain";

const SUPPORTED_CONTENT_TYPES = new Set<string>(["text/html", "text/plain"]);

/**
 * Which of the supported types a response says it is, or null for anything else.
 *
 * **A missing header is refused, not guessed at.** Sniffing is how a PDF gets
 * read as text and how an image gets stored as a snapshot; there is no upside
 * to it here, because a page worth watching is served by something that says
 * what it is serving.
 *
 * Parameters are dropped before comparing — `text/html; charset=utf-8` is
 * `text/html`. The charset itself is not honoured: everything is decoded as
 * UTF-8, which is right for the overwhelming majority of pages and wrong in a
 * way that produces mangled text rather than unsafe behaviour. Something to
 * revisit when there is a page it actually breaks.
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
 * It stops on the chunk that crosses the line rather than after it, so the most
 * that is ever held is one chunk beyond the limit.
 *
 * The stream is an `AsyncIterable` rather than a response, which is what lets
 * this be tested with three strings instead of a server.
 */
export async function readBodyWithLimit(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ text: string; byteLength: number }> {
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

  return { text: new TextDecoder("utf-8").decode(concat(chunks)), byteLength };
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
