import { describe, expect, it } from "vitest";
import { monitoredPageLink } from "@/lib/watcher/monitored-link";

/**
 * Which stored addresses may be offered to somebody as a link.
 *
 * **Stored is not the same as safe to surface.** A row written before a rule
 * existed was checked by the rules of its day, so this re-reads it through the
 * parser the fetch uses rather than trusting that it passed once.
 *
 * **This decides what to show, never what to fetch.** The link opens in the
 * reader's own browser; nothing here is a request Koqentra makes, and nothing
 * here weakens the Safe Fetch protections that stand in front of the ones it
 * does make.
 */

describe("an address that may be offered", () => {
  it.each([
    ["an ordinary https page", "https://example.com/rooms"],
    ["one with a query", "https://example.com/search?date=2026-10-01&n=2"],
    ["one with a fragment", "https://example.com/rooms#availability"],
    ["plain http", "http://example.com/rooms"],
    ["a port the watcher allows", "https://example.com:443/rooms"],
  ])("offers %s", (_label, url) => {
    expect(monitoredPageLink(url)).toBe(url);
  });

  /**
   * **Returned as written, not as the parser normalised it.** A query's order,
   * a trailing slash and the case of a path can all matter to the site being
   * visited; handing back a rewritten address would send somebody somewhere
   * slightly different from the page their worker watches.
   */
  it("hands back exactly what was stored", () => {
    const stored = "https://example.com/Rooms?b=2&a=1";

    expect(monitoredPageLink(stored)).toBe(stored);
  });

  it("trims surrounding whitespace and nothing else", () => {
    expect(monitoredPageLink("  https://example.com/rooms  ")).toBe(
      "https://example.com/rooms",
    );
  });
});

describe("an address that may not", () => {
  /** A worker that watches nothing has no action, rather than a broken one. */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("offers nothing for %s", (_label, url) => {
    expect(monitoredPageLink(url)).toBeNull();
  });

  /**
   * **Schemes that are not a page are refused.** The watcher only ever
   * supported http and https, and a stored value that is not one of those is
   * not something to put behind a link somebody will click.
   */
  it.each([
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html;base64,PHNjcmlwdD4="],
    ["file", "file:///etc/passwd"],
    ["mailto", "mailto:someone@example.com"],
    ["ftp", "ftp://example.com/rooms"],
  ])("offers nothing for a %s address", (_label, url) => {
    expect(monitoredPageLink(url)).toBeNull();
  });

  /**
   * **An address carrying credentials is never surfaced.** The watcher refuses
   * to store one, and this refuses to show one — so a row that predates that
   * rule cannot put somebody's username and password into an email.
   */
  it.each([
    ["a username", "https://someone@example.com/rooms"],
    ["a username and password", "https://someone:secret@example.com/rooms"],
  ])("offers nothing for an address carrying %s", (_label, url) => {
    expect(monitoredPageLink(url)).toBeNull();
  });

  it.each([
    ["nonsense", "not a url at all"],
    ["a scheme with no host", "https://"],
    ["a bare path", "/rooms"],
  ])("offers nothing for %s", (_label, url) => {
    expect(monitoredPageLink(url)).toBeNull();
  });
});
