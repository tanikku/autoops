import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentHashOf } from "@/lib/watcher/hash";

/**
 * The digest two snapshots are compared by.
 *
 * **What must not be in it is as much the subject as what is.** A digest that
 * quietly mixed in the URL, the worker, or the time it was taken would report a
 * change on every run and there would be nothing in the output to say why.
 */

describe("what the digest is", () => {
  it("is SHA-256 of the UTF-8 bytes, and nothing else", () => {
    const content = "採用情報 2026";
    const expected = createHash("sha256")
      .update(Buffer.from(content, "utf-8"))
      .digest("hex");

    expect(contentHashOf(content)).toBe(expected);
  });

  it("is lower-case hexadecimal, sixty-four characters", () => {
    expect(contentHashOf("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a digest for the empty string", () => {
    expect(contentHashOf("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("the same text, the same digest", () => {
  it("does not vary between calls", () => {
    expect(contentHashOf("Careers")).toBe(contentHashOf("Careers"));
  });

  /**
   * The point of the previous test, stated the way it will actually be relied
   * on: the digest cannot depend on when or on whose behalf it was taken,
   * because nothing but the text is passed in.
   */
  it("does not depend on anything but its argument", () => {
    const first = contentHashOf("Careers");
    const second = contentHashOf("Careers");
    const third = contentHashOf("Careers");

    expect(new Set([first, second, third]).size).toBe(1);
  });
});

describe("different text, different digest", () => {
  it.each([
    ["one character", "Careers", "Career"],
    ["one digit", "¥9,800", "¥9,801"],
    ["case", "Sold Out", "sold out"],
    ["a trailing space", "Careers", "Careers "],
    ["an emoji", "在庫あり", "在庫あり ✅"],
    ["empty against a space", "", " "],
  ])("changes for %s", (_name, before, after) => {
    expect(contentHashOf(after)).not.toBe(contentHashOf(before));
  });
});
