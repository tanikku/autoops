import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotFound, { metadata } from "@/app/not-found";

/**
 * The page an unmatched URL lands on, and the language it says it is in.
 *
 * **This one is English inside a document that may not be.** The root layout
 * writes the account's language onto `<html>`, so a Japanese account reaching a
 * 404 gets `lang="ja"` around an English sentence. Nothing here is translated —
 * a person who asked for a page that does not exist is better served by words
 * that certainly exist — so what has to be right is the *claim*: the subtree
 * declares the language it is actually written in, which is what HTML has
 * language-of-parts for.
 *
 * **The title and description are the other half.** "Not Found" was English
 * too, and the description was inherited from the root — a sentence about
 * evaluating content for X and Reddit, attached to a page about none of that.
 */

const markup = () => renderToStaticMarkup(<NotFound />);

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
    "Not found.",
    "This page does not exist, or is not available on your account.",
    "Back to Dashboard",
    "Koqentra",
  ])("keeps %o exactly as it was", (copy) => {
    expect(markup()).toContain(copy);
  });

  /**
   * **404 rather than 403, in the wording too.** The worker and run pages call
   * `notFound()` both for a record that never existed and for one belonging to
   * somebody else; saying which would answer the question the status code
   * exists to leave unanswered.
   */
  it("does not say whose the missing thing was", () => {
    const text = markup().replace(/<[^>]*>/g, " ");

    expect(text).not.toMatch(/permission|forbidden|not allowed|another account/i);
  });

  it("keeps the way back", () => {
    expect(markup()).toContain('href="/dashboard"');
  });
});

/**
 * **A title with no language in it, and no description at all.**
 *
 * A number and a product name read the same in either language, so the title
 * cannot contradict the document around it. The description is dropped rather
 * than written: metadata is inherited, and the root's sentence describes the
 * product rather than this page — in English, on a document that may be
 * Japanese.
 */
describe("what the tab says", () => {
  it("titles itself with a number and a name", () => {
    expect(metadata.title).toBe("404 — Koqentra");
  });

  it("inherits no description from the root", () => {
    expect(metadata.description).toBeNull();
  });

  /**
   * `undefined` would leave the root's description in place and an empty
   * string would emit a meaningless empty tag. Only `null` drops it.
   */
  it("drops it rather than blanking it", () => {
    expect(metadata.description).not.toBe("");
    expect(metadata.description).not.toBeUndefined();
  });
});
