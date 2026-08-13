import { describe, expect, it } from "vitest";
import { isWatcherError, WatcherError } from "@/lib/watcher/errors";
import { hostAddress, parseWatchUrl } from "@/lib/watcher/url";

/**
 * What a watch target may look like, before anything is resolved.
 *
 * **These are syntax rules, not safety rules.** A URL that passes here has not
 * been judged safe to fetch — `http://localhost/` gets through, and is stopped
 * by the address checks that run after resolution. Keeping the two apart in the
 * tests as well as in the code is deliberate: a reader who thinks this file is
 * the SSRF defence would be looking in the wrong place for it.
 */

/** The kind of a rejection, or a failure to reject. */
function kindOf(raw: string): string {
  try {
    parseWatchUrl(raw);
  } catch (error) {
    return isWatcherError(error) ? (error as WatcherError).kind : "not-a-watcher-error";
  }

  return "accepted";
}

describe("targets that are accepted", () => {
  it.each([
    "https://example.com/",
    "http://example.com/",
    "https://example.com/path?query=1",
    // Not safe, and not this function's business — the address checks refuse it.
    "http://localhost/",
    "http://127.0.0.1/",
  ])("accepts %s", (raw) => {
    expect(kindOf(raw)).toBe("accepted");
  });

  it("trims surrounding whitespace, which a paste brings with it", () => {
    expect(parseWatchUrl("  https://example.com/  ").href).toBe(
      "https://example.com/",
    );
  });

  it("drops the fragment, which is never sent", () => {
    expect(parseWatchUrl("https://example.com/p#section").href).toBe(
      "https://example.com/p",
    );
  });
});

describe("targets that are refused", () => {
  it.each([
    ["file:///etc/passwd", "unsupported-scheme"],
    ["file://C:/Windows/win.ini", "unsupported-scheme"],
    ["ftp://example.com/", "unsupported-scheme"],
    ["data:text/html,<h1>hi</h1>", "unsupported-scheme"],
    ["gopher://example.com/", "unsupported-scheme"],
    ["javascript:alert(1)", "unsupported-scheme"],
    ["https://user:password@example.com/", "invalid-url"],
    ["https://user@example.com/", "invalid-url"],
    ["not a url", "invalid-url"],
    ["", "invalid-url"],
    ["https://", "invalid-url"],
  ])("refuses %s as %s", (raw, kind) => {
    expect(kindOf(raw)).toBe(kind);
  });
});

/**
 * **A page is served on its scheme's own port, and this watches pages.**
 *
 * Refusing internal addresses keeps AutoOps out of this deployment's network
 * and says nothing about anyone else's: a worker pointed at a stranger's host
 * on port 22 would ask, daily, whether their SSH port answers. Nothing worth
 * watching is lost by refusing, and what is gained is that the capability
 * cannot be aimed at anything but a web page.
 */
describe("the ports a page may be watched on", () => {
  it.each([
    "http://example.com/",
    "http://example.com:80/",
    "https://example.com/",
    "https://example.com:443/",
  ])("allows %s", (raw) => {
    expect(kindOf(raw)).toBe("accepted");
  });

  it.each([
    "http://example.com:22/",
    "http://example.com:25/",
    "http://example.com:8080/",
    "https://example.com:8443/",
    "https://example.com:444/",
    "https://example.com:65535/",
    // The standard port of the *other* scheme is still not this one's.
    "http://example.com:443/",
    "https://example.com:80/",
  ])("refuses %s", (raw) => {
    expect(kindOf(raw)).toBe("unsupported-port");
  });

  it.each([
    ["http://[2606:2800::1]/", "accepted"],
    ["https://[2606:2800::1]:443/", "accepted"],
    ["https://[2606:2800::1]:8443/", "unsupported-port"],
    ["http://[2606:2800::1]:22/", "unsupported-port"],
  ])("applies the same rule to %s written as IPv6", (raw, expected) => {
    expect(kindOf(raw)).toBe(expected);
  });

  it("says it was a policy rather than a typo", () => {
    expect(() => parseWatchUrl("https://example.com:8443/")).toThrow(/port 8443/);
  });
});

/**
 * `URL` normalises the older ways of writing an IPv4 address, which is worth
 * pinning down: it means the checks downstream see `127.0.0.1` whichever of
 * these was typed, rather than a string they would have had to decode.
 *
 * **This is not what makes those addresses safe.** Nothing here refuses them —
 * the point is only that they arrive at the address check in a form it can
 * classify, and they would be refused even if they did not.
 */
describe("alternative ways of writing an address", () => {
  it.each([
    ["http://2130706433/", "127.0.0.1"],
    ["http://0x7f.0x0.0x0.0x1/", "127.0.0.1"],
    ["http://127.1/", "127.0.0.1"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(parseWatchUrl(raw).hostname).toBe(expected);
  });
});

describe("hostAddress", () => {
  it("leaves an ordinary host alone", () => {
    expect(hostAddress(parseWatchUrl("https://example.com/"))).toBe(
      "example.com",
    );
  });

  it("unwraps the brackets an IPv6 literal is written in", () => {
    expect(hostAddress(parseWatchUrl("http://[2606:2800::1]/"))).toBe(
      "2606:2800::1",
    );
  });
});
