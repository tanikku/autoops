import { describe, expect, it } from "vitest";
import { isHtmlContentType } from "@/lib/watcher/content-type";

/**
 * Which responses may be parsed as a document.
 *
 * **A different question from what may be read.** The fetch accepts plain text
 * as well, because plain text is text; this refuses it, because running it
 * through an HTML parser would invent a document the server never sent.
 */

describe("responses that can be normalized", () => {
  it.each([
    "text/html",
    "text/html; charset=utf-8",
    "text/html;charset=UTF-8",
    "TEXT/HTML",
    "  text/html  ",
    "application/xhtml+xml",
    "application/xhtml+xml; charset=utf-8",
    "APPLICATION/XHTML+XML",
  ])("accepts %s", (header) => {
    expect(isHtmlContentType(header)).toBe(true);
  });
});

describe("responses that cannot", () => {
  it.each([
    ["text/plain", "text, but not a document"],
    ["text/plain; charset=utf-8", "the same with a parameter"],
    ["application/json", "structured data, not markup"],
    ["application/pdf", "a document, but not this kind"],
    ["image/png", "a picture"],
    ["image/svg+xml", "markup, but a picture"],
    ["application/octet-stream", "bytes with no claim about them"],
    ["application/xml", "XML that is not XHTML"],
    ["text/xml", "the same"],
    ["text/htmlish", "a longer type that merely starts the same way"],
  ])("refuses %s — %s", (header) => {
    expect(isHtmlContentType(header)).toBe(false);
  });

  /**
   * **Missing is refused, matching what the fetch already does with one.**
   * Guessing from the bytes is content sniffing, and the whole point of asking
   * is that the server said so.
   */
  it("refuses a response that says nothing about its type", () => {
    expect(isHtmlContentType(undefined)).toBe(false);
  });

  it("refuses an empty header", () => {
    expect(isHtmlContentType("")).toBe(false);
  });
});
