import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ErrorFallback from "@/app/error";

/**
 * What replaces a page that threw, and the language it says it is in.
 *
 * **English inside a document that may be Japanese.** The root layout writes
 * the account's language onto `<html>`, and this fallback is not translated: it
 * stands in for a page that failed, and somebody who cannot see what they asked
 * for is better served by words that certainly exist than by a translation of
 * them. So the subtree declares the language it is actually written in rather
 * than borrowing the document's.
 *
 * **Rendered as static markup, with no DOM.** This is a client component, but
 * it holds no state and reads no browser API — `reset` arrives as a prop — so
 * it renders on the server like anything else here. Nothing in the component
 * was changed to make it testable.
 */

const markup = (reset: () => void = () => {}) =>
  renderToStaticMarkup(
    <ErrorFallback error={new Error("boom")} reset={reset} />,
  );

describe("what the fallback says it is written in", () => {
  /**
   * The assertion this file exists for. It fails the moment somebody removes
   * the attribute, or translates the copy without removing it.
   */
  it("declares English on the subtree, not on the document", () => {
    expect(markup()).toContain('lang="en"');
  });

  it("puts it on the outermost element, so everything inside inherits it", () => {
    expect(markup().startsWith('<div lang="en"')).toBe(true);
  });
});

describe("what it still says", () => {
  it.each([
    "Something went wrong.",
    "Try again",
    "Back to Dashboard",
    "Koqentra",
  ])("keeps %o exactly as it was", (copy) => {
    expect(markup()).toContain(copy);
  });

  /**
   * **Nothing about the failure is shown.** Next.js replaces the message with
   * an opaque digest in production, and the reason a query failed is a server
   * concern a visitor can do nothing with. This is the assertion that catches
   * somebody "helpfully" rendering `error.message` later.
   */
  it("says nothing about what actually failed", () => {
    expect(markup()).not.toContain("boom");
  });

  it("keeps the way back", () => {
    expect(markup()).toContain('href="/dashboard"');
  });
});

/**
 * **Trying again is the only thing a visitor can do here**, so the prop that
 * does it has to reach the button rather than be swallowed by the markup.
 */
describe("trying again", () => {
  it("hands the retry through to something clickable", () => {
    const reset = vi.fn();
    const tree = <ErrorFallback error={new Error("boom")} reset={reset} />;

    const found = JSON.stringify(tree, (_key, value) =>
      value === reset ? "RESET" : value,
    );

    expect(found).toContain("RESET");
    expect(reset).not.toHaveBeenCalled();
  });
});
