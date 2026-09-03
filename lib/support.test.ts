import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supportEmailAddress, supportMailtoHref } from "@/lib/support";

/**
 * The one place a support address is read, and what it refuses to build.
 *
 * **A link that goes nowhere is worse than no link**, which is the whole of
 * what this module decides: an address that is absent, blank, or shaped in a
 * way a `mailto:` could not carry produces null, and the screens that ask for
 * one render nothing at all rather than something broken.
 *
 * **No real address appears here.** The values are invented, and none of the
 * assertions is about a particular one — what is checked is the shape of what
 * comes out.
 */

const ADDRESS = "support@example.test";

beforeEach(() => {
  process.env.SUPPORT_EMAIL = ADDRESS;
});

afterEach(() => {
  delete process.env.SUPPORT_EMAIL;
});

describe("the address", () => {
  it("is what the environment says", () => {
    expect(supportEmailAddress()).toBe(ADDRESS);
  });

  it("is trimmed of the whitespace around it", () => {
    process.env.SUPPORT_EMAIL = `   ${ADDRESS}\n`;

    expect(supportEmailAddress()).toBe(ADDRESS);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("is null when it is %s", (_label, value) => {
    if (value === undefined) {
      delete process.env.SUPPORT_EMAIL;
    } else {
      process.env.SUPPORT_EMAIL = value;
    }

    expect(supportEmailAddress()).toBeNull();
  });

  /**
   * **A sanity check on something an operator typed, not a validator.** What
   * it rules out is a value that could not work as a `mailto:` at all — one
   * carrying a space, a newline, or an invisible character, or one that is not
   * an address in the first place.
   */
  it.each([
    ["no at sign", "support.example.test"],
    ["an inner space", "support @example.test"],
    ["a newline", "support@example.test\nBcc: someone@example.test"],
    ["a zero-width character", "support@exa​mple.test"],
  ])("is null when the value has %s", (_label, value) => {
    process.env.SUPPORT_EMAIL = value;

    expect(supportEmailAddress()).toBeNull();
  });

  it("is null for something far longer than an address may be", () => {
    process.env.SUPPORT_EMAIL = `${"a".repeat(250)}@example.test`;

    expect(supportEmailAddress()).toBeNull();
  });
});

describe("the mailto", () => {
  it("addresses the message and carries the subject", () => {
    expect(supportMailtoHref("Koqentra support")).toBe(
      `mailto:${ADDRESS}?subject=Koqentra%20support`,
    );
  });

  /**
   * **The subject comes from the dictionary**, so it may hold Japanese, and it
   * has to survive the journey as one value rather than ending the query early.
   */
  it("encodes a subject that is not ASCII", () => {
    const href = supportMailtoHref("Koqentra サポート");

    expect(href).toContain("?subject=");
    expect(href).not.toContain(" ");
    expect(href).not.toContain("サポート");
    expect(decodeURIComponent(href!.split("?subject=")[1])).toBe(
      "Koqentra サポート",
    );
  });

  it("encodes the characters that would otherwise end the query", () => {
    const href = supportMailtoHref("a & b ? c #d");

    expect(href).not.toContain("&");
    expect(href).not.toContain("#");
    expect(href!.indexOf("?")).toBe(href!.lastIndexOf("?"));
  });

  it("leaves the address itself alone", () => {
    expect(supportMailtoHref("x")).toContain(`mailto:${ADDRESS}?`);
  });

  it("omits the query when there is no subject to carry", () => {
    expect(supportMailtoHref("")).toBe(`mailto:${ADDRESS}`);
    expect(supportMailtoHref("   ")).toBe(`mailto:${ADDRESS}`);
  });

  /** Null all the way through, so a caller cannot render a dead link. */
  it("is null whenever the address is", () => {
    delete process.env.SUPPORT_EMAIL;

    expect(supportMailtoHref("Koqentra support")).toBeNull();
  });
});
