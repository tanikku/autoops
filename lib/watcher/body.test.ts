import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseContentType, readBodyWithLimit } from "@/lib/watcher/body";
import { isWatcherError, type WatcherError } from "@/lib/watcher/errors";

describe("what counts as a page this can read", () => {
  it.each([
    ["text/html", "text/html"],
    ["text/html; charset=utf-8", "text/html"],
    ["TEXT/HTML", "text/html"],
    ["  text/html  ", "text/html"],
    ["text/plain", "text/plain"],
    ["text/plain;charset=iso-8859-1", "text/plain"],
  ])("reads %s as %s", (header, expected) => {
    expect(parseContentType(header)).toBe(expected);
  });

  it.each([
    "application/pdf",
    "image/png",
    "application/octet-stream",
    "application/json",
    "application/rss+xml",
    "application/atom+xml",
    "application/xml",
    "text/xml",
    "text/html-ish",
  ])("refuses %s", (header) => {
    expect(parseContentType(header)).toBeNull();
  });

  /**
   * **A response that does not say what it is, is not read.** Guessing from the
   * bytes is how a PDF becomes a snapshot; there is no upside, because anything
   * worth watching is served by something that labels it.
   */
  it("refuses a response with no content type at all", () => {
    expect(parseContentType(undefined)).toBeNull();
  });
});

/** A body arriving in pieces, which is the only way a real one arrives. */
function streamOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk, "utf-8")));
}

async function limitKind(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<string> {
  try {
    await readBodyWithLimit(stream, limit);
  } catch (error) {
    return isWatcherError(error)
      ? (error as WatcherError).kind
      : "not-a-watcher-error";
  }

  return "read";
}

describe("reading a body", () => {
  it("joins the pieces back into one string", async () => {
    const { text } = await readBodyWithLimit(
      streamOf("<html>", "<body>hi</body>", "</html>"),
      1_000,
    );

    expect(text).toBe("<html><body>hi</body></html>");
  });

  it("reports the size in bytes rather than characters", async () => {
    // Three characters, nine bytes. The limit is a memory bound, so bytes are
    // the only unit that means anything to it.
    const { text, byteLength } = await readBodyWithLimit(streamOf("あいう"), 1_000);

    expect(text).toBe("あいう");
    expect(byteLength).toBe(9);
  });

  it("reads a body that is exactly the limit", async () => {
    expect(await limitKind(streamOf("12345"), 5)).toBe("read");
  });

  it("refuses one byte past it", async () => {
    expect(await limitKind(streamOf("123456"), 5)).toBe("response-too-large");
  });

  /**
   * The limit has to be reached while reading rather than after, or it is not a
   * limit: a body that never ends would be read forever and refused never.
   */
  it("stops on the chunk that crosses the line, not at the end", async () => {
    let chunksTaken = 0;

    async function* endless(): AsyncGenerator<Uint8Array> {
      while (true) {
        chunksTaken += 1;
        yield Buffer.alloc(1_000);
      }
    }

    expect(await limitKind(endless(), 2_500)).toBe("response-too-large");
    expect(chunksTaken).toBe(3);
  });
});
