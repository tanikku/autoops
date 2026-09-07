import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The one thing about the stylesheet that nothing else can catch.
 *
 * **This exists because the bug it guards against shipped.** `--font-sans` was
 * defined as `var(--font-sans)` — a custom property referencing itself, which
 * CSS treats as invalid at computed-value time. `html { @apply font-sans }`
 * then applied it with no fallback, so the declaration was dropped entirely and
 * the whole product rendered in the browser's default font. On iOS that meant
 * Japanese text in mincho, and Geist was downloaded on every page load without
 * being applied to anything.
 *
 * Nothing noticed. It is valid CSS syntax, so `lint`, `tsc` and `build` all
 * passed, CI was green, and it reached production. The only thing that would
 * have caught it is an assertion about what the value *means*.
 *
 * **Narrow on purpose.** What is checked is the token that broke and the
 * properties that make it work: a real reference to the font Next.js loads, an
 * end to the list that is not the default serif, and a Japanese family for the
 * glyphs Geist does not carry. Sizes, weights, spacing and the generated
 * Tailwind output are all deliberately not asserted — a test that pinned those
 * would fail on every design change and teach people to edit the test.
 */

const globalsCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "globals.css"),
  "utf8",
);

/** One CSS declaration, with newlines and runs of spaces flattened out. */
function declaration(property: string): string {
  const match = globalsCss.match(
    new RegExp(`(^|[;{\\s])${property}\\s*:([^;]*);`, "m"),
  );

  expect(match, `${property} is not declared in globals.css`).not.toBeNull();

  return (match?.[2] ?? "").replace(/\s+/g, " ").trim();
}

describe("the sans font token", () => {
  const sans = declaration("--font-sans");

  /**
   * **The whole bug, as one assertion.** A property that references itself is
   * invalid, and every rule using it silently stops applying.
   */
  it("does not reference itself", () => {
    expect(sans).not.toContain("var(--font-sans)");
  });

  /** Otherwise Next.js downloads Geist on every page and nothing uses it. */
  it("actually uses the font Next.js loads", () => {
    expect(sans).toContain("var(--font-geist-sans)");
  });

  it("starts with it, so Latin text is Geist rather than a system face", () => {
    expect(sans.startsWith("var(--font-geist-sans)")).toBe(true);
  });

  /**
   * The last resort has to be a sans family. Ending anywhere else lets a
   * browser fall through to its default, which is the serif this was fixing.
   */
  it("ends in a generic sans, never the default serif", () => {
    expect(sans.endsWith("sans-serif")).toBe(true);
    expect(sans).not.toMatch(/(^|[\s,])serif\s*$/);
  });

  /**
   * **Geist is Latin-only.** A Japanese character matches nothing in it, so
   * what the browser reaches next is the whole of this fix.
   */
  it("names a Japanese family for the glyphs Geist does not carry", () => {
    expect(sans).toContain('"Hiragino Sans"');
    expect(sans).toMatch(/"Yu Gothic"|Meiryo/);
  });

  it("still offers the platform's own UI font before naming any of them", () => {
    expect(sans).toContain("system-ui");
  });
});

/**
 * Headings are the same token by design: one place to fix, and no chance of a
 * heading in a different family from the sentence under it.
 */
describe("the heading token", () => {
  it("resolves through the sans token rather than repeating it", () => {
    expect(declaration("--font-heading")).toBe("var(--font-sans)");
  });
});

/** Untouched by the fix, and not part of this problem: mono was never broken. */
describe("the mono token", () => {
  it("still points at the mono font Next.js loads", () => {
    expect(declaration("--font-mono")).toBe("var(--font-geist-mono)");
  });
});
