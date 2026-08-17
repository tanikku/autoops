import { describe, expect, it } from "vitest";
import {
  buildWebsiteChangeContext,
  CONTEXT_AFTER_CHARS,
  CONTEXT_BEFORE_CHARS,
  MAX_CHANGE_CONTEXT_CHARS,
  TRUNCATION_MARKER,
} from "@/lib/watcher/change-context";

/**
 * Reducing two versions of a page to the part that differs.
 *
 * Two properties matter and everything below is one of them. **The change has
 * to be in what comes out** — an excerpt that dropped the edit would send a
 * model to describe something that did not happen. And **it has to be bounded**
 * — a watched page may be two megabytes, and sending it twice on every change
 * would make cost a property of somebody else's site.
 */

/** How much of the excerpts is text taken from the page. */
function externalDataSize(previous: string, current: string): number {
  const context = buildWebsiteChangeContext(previous, current);
  return context.previousExcerpt.length + context.currentExcerpt.length;
}

describe("finding what changed", () => {
  it("keeps a single changed character on both sides", () => {
    const context = buildWebsiteChangeContext("price is 100 yen", "price is 200 yen");

    expect(context.previousExcerpt).toContain("100");
    expect(context.currentExcerpt).toContain("200");
    expect(context.truncated).toBe(false);
  });

  it.each([
    ["an insertion", "abc", "abXc"],
    ["a deletion", "abXc", "abc"],
    ["a replacement", "abXc", "abYc"],
    ["a change at the beginning", "Xabc", "Yabc"],
    ["a change at the end", "abcX", "abcY"],
    ["a whole new page", "completely one", "different two"],
  ])("keeps both versions for %s", (_name, previous, current) => {
    const context = buildWebsiteChangeContext(previous, current);

    expect(context.previousExcerpt).toBe(previous);
    expect(context.currentExcerpt).toBe(current);
  });

  it("keeps the surrounding text so the change can be placed", () => {
    const previous = `${"a".repeat(50)}OLD${"b".repeat(50)}`;
    const current = `${"a".repeat(50)}NEW${"b".repeat(50)}`;
    const context = buildWebsiteChangeContext(previous, current);

    expect(context.previousExcerpt).toBe(previous);
    expect(context.currentExcerpt).toBe(current);
  });

  it("does not carry a long common prefix beyond the context limit", () => {
    const prefix = "a".repeat(50_000);
    const context = buildWebsiteChangeContext(`${prefix}OLD`, `${prefix}NEW`);

    expect(context.previousExcerpt.length).toBeLessThanOrEqual(
      CONTEXT_BEFORE_CHARS + "OLD".length + CONTEXT_AFTER_CHARS,
    );
    expect(context.previousExcerpt).toContain("OLD");
    expect(context.currentExcerpt).toContain("NEW");
  });

  it("does not carry a long common suffix either", () => {
    const suffix = "z".repeat(50_000);
    const context = buildWebsiteChangeContext(`OLD${suffix}`, `NEW${suffix}`);

    expect(context.previousExcerpt.length).toBeLessThanOrEqual(
      CONTEXT_BEFORE_CHARS + "OLD".length + CONTEXT_AFTER_CHARS,
    );
    expect(context.previousExcerpt).toContain("OLD");
  });

  it("bounds the text either side of the change", () => {
    const previous = `${"a".repeat(9_000)}OLD${"b".repeat(9_000)}`;
    const current = `${"a".repeat(9_000)}NEW${"b".repeat(9_000)}`;
    const context = buildWebsiteChangeContext(previous, current);

    expect(context.previousExcerpt.length).toBe(
      CONTEXT_BEFORE_CHARS + 3 + CONTEXT_AFTER_CHARS,
    );
  });
});

/**
 * **Prefix and suffix must not overlap.** `"aaaa"` and `"aaa"` share three
 * characters from the start and three from the end, which between them account
 * for more of the shorter string than it has — without a cap the changed region
 * comes out as a negative slice and the excerpts become nonsense.
 */
describe("strings that overlap themselves", () => {
  it.each([
    ["aaaa", "aaa"],
    ["aaa", "aaaa"],
    ["aaaaaa", "aaaaa"],
    ["ababab", "abab"],
    ["", "aaa"],
    ["aaa", ""],
    ["", ""],
  ])("handles %o against %o without producing nonsense", (previous, current) => {
    const context = buildWebsiteChangeContext(previous, current);

    expect(context.previousExcerpt.length).toBeLessThanOrEqual(previous.length);
    expect(context.currentExcerpt.length).toBeLessThanOrEqual(current.length);
  });

  it("still shows both when one side is empty", () => {
    expect(buildWebsiteChangeContext("", "something new").currentExcerpt).toBe(
      "something new",
    );
    expect(buildWebsiteChangeContext("was here", "").previousExcerpt).toBe(
      "was here",
    );
  });

  it("returns empty excerpts for two empty pages", () => {
    const context = buildWebsiteChangeContext("", "");

    expect(context.previousExcerpt).toBe("");
    expect(context.currentExcerpt).toBe("");
    expect(context.truncated).toBe(false);
  });
});

describe("text that is not ASCII", () => {
  it("keeps Japanese on both sides", () => {
    const context = buildWebsiteChangeContext("採用情報 2026年", "採用情報 2027年");

    expect(context.previousExcerpt).toContain("2026");
    expect(context.currentExcerpt).toContain("2027");
  });

  it("keeps emoji", () => {
    const context = buildWebsiteChangeContext("在庫あり ✅", "在庫なし ❌");

    expect(context.previousExcerpt).toContain("✅");
    expect(context.currentExcerpt).toContain("❌");
  });

  /**
   * **Never half a character.** Slicing on a UTF-16 boundary can land between
   * the two units of a surrogate pair, and what comes out is not text any more
   * — it is an unpaired surrogate that will travel to a model and into a row.
   */
  it("never leaves an unpaired surrogate at any boundary", () => {
    const emoji = "😀";
    const previous = `${emoji.repeat(9_000)}OLD${emoji.repeat(9_000)}`;
    const current = `${emoji.repeat(9_000)}NEW${emoji.repeat(9_000)}`;
    const context = buildWebsiteChangeContext(previous, current);

    for (const excerpt of [context.previousExcerpt, context.currentExcerpt]) {
      expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(excerpt).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("never leaves one when the change itself is truncated", () => {
    const previous = "😀".repeat(30_000);
    const current = `${"😀".repeat(29_999)}🎉`;
    const context = buildWebsiteChangeContext(previous, current);

    for (const excerpt of [context.previousExcerpt, context.currentExcerpt]) {
      expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(excerpt).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});

/**
 * **Both ends of a long change are kept.** A change is often a small edit
 * inside a long block; keeping only the beginning would show the part that did
 * not change and cut the part that did.
 */
describe("a change too long to send", () => {
  const HUGE_OLD = "O".repeat(60_000);
  const HUGE_NEW = "N".repeat(60_000);

  it("keeps the head and the tail of a huge old region", () => {
    const context = buildWebsiteChangeContext(HUGE_OLD, "small");

    expect(context.previousExcerpt.startsWith("O")).toBe(true);
    expect(context.previousExcerpt.endsWith("O")).toBe(true);
    expect(context.previousExcerpt).toContain(TRUNCATION_MARKER);
    expect(context.truncated).toBe(true);
  });

  it("keeps the head and the tail of a huge new region", () => {
    const context = buildWebsiteChangeContext("small", HUGE_NEW);

    expect(context.currentExcerpt.startsWith("N")).toBe(true);
    expect(context.currentExcerpt.endsWith("N")).toBe(true);
    expect(context.currentExcerpt).toContain(TRUNCATION_MARKER);
  });

  it("truncates both when both are huge", () => {
    const context = buildWebsiteChangeContext(HUGE_OLD, HUGE_NEW);

    expect(context.previousExcerpt).toContain(TRUNCATION_MARKER);
    expect(context.currentExcerpt).toContain(TRUNCATION_MARKER);
    expect(context.truncated).toBe(true);
  });

  /** A small side keeps all of itself; the slack goes to the one that needs it. */
  it("does not cut a side that already fits", () => {
    const context = buildWebsiteChangeContext("small", HUGE_NEW);

    expect(context.previousExcerpt).toBe("small");
    expect(context.previousExcerpt).not.toContain(TRUNCATION_MARKER);
  });

  it("says nothing was truncated when nothing was", () => {
    expect(buildWebsiteChangeContext("abc", "abd").truncated).toBe(false);
  });
});

/**
 * The ceiling, counted the way it is spent: across both excerpts, because both
 * are sent in the same request.
 */
describe("how much of the page is ever sent", () => {
  it.each([
    ["two huge different pages", "O".repeat(80_000), "N".repeat(80_000)],
    ["a huge page against a small one", "O".repeat(80_000), "tiny"],
    [
      "a huge shared prefix and a huge change",
      `${"a".repeat(40_000)}${"O".repeat(40_000)}`,
      `${"a".repeat(40_000)}${"N".repeat(40_000)}`,
    ],
    [
      "changes at both ends of a long page",
      `X${"m".repeat(60_000)}Y`,
      `A${"m".repeat(60_000)}B`,
    ],
    ["emoji throughout", "😀".repeat(40_000), "🎉".repeat(40_000)],
  ])("stays within the limit for %s", (_name, previous, current) => {
    expect(externalDataSize(previous, current)).toBeLessThanOrEqual(
      MAX_CHANGE_CONTEXT_CHARS,
    );
  });

  it("is well under the limit for an ordinary edit", () => {
    const previous = `${"a".repeat(500)}100${"b".repeat(500)}`;
    const current = `${"a".repeat(500)}200${"b".repeat(500)}`;

    expect(externalDataSize(previous, current)).toBeLessThan(3_000);
  });
});

/**
 * **The same two strings always produce the same request.** A request that
 * varied between runs would make a failure impossible to reproduce, and this is
 * the one place another site's text becomes something sent to a model.
 */
describe("determinism", () => {
  it.each([
    ["a small edit", "price 100", "price 200"],
    ["a huge change", "O".repeat(50_000), "N".repeat(50_000)],
    ["emoji", "😀".repeat(20_000), "🎉".repeat(20_000)],
  ])("produces identical output every time for %s", (_name, previous, current) => {
    const runs = [1, 2, 3].map(() => buildWebsiteChangeContext(previous, current));

    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});
