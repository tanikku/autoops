import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PrivacyPage from "@/app/privacy/page";

/**
 * The claims this page has to keep making.
 *
 * **Not a snapshot.** Fixing every paragraph would make rewording it a test
 * failure, which teaches people to update the expectation without reading it.
 * What is checked instead is the handful of statements that would be a lie by
 * omission if they disappeared — and the promises that must never appear,
 * because nothing in the code would keep them.
 *
 * Creator is the reason this matters now: a worker sends instructions somebody
 * wrote to be sent, while Creator sends a piece of writing that has not been
 * published anywhere.
 */

const text = renderToStaticMarkup(<PrivacyPage />).replace(/<[^>]*>/g, " ");
const has = (phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

describe("what Creator sends", () => {
  it("says the writing goes to Anthropic", () => {
    expect(has("Anthropic")).toBe(true);
    expect(has("analyze")).toBe(true);
  });

  /** Preferences and recent answers travel with it; the whole history does not. */
  it("says recent answers travel with it, and how many", () => {
    expect(has("twelve")).toBe(true);
    expect(has("not your whole history")).toBe(true);
  });

  it("names what an answer can carry", () => {
    expect(has("edited text")).toBe(true);
    expect(has("extract")).toBe(true);
  });
});

describe("what Creator stores", () => {
  it("says what a successful analysis keeps", () => {
    expect(has("stores the title and body")).toBe(true);
    expect(has("post text")).toBe(true);
  });

  it("says what an answer keeps, and that the original is not overwritten", () => {
    expect(has("agreed, rewrote it, or turned it down")).toBe(true);
    expect(has("kept as it was written")).toBe(true);
  });
});

describe("what Creator does not do", () => {
  /** The single most important sentence on the page for this feature. */
  it("says it posts nothing anywhere", () => {
    expect(has("does not post anything anywhere")).toBe(true);
  });

  it("says the output may be wrong", () => {
    expect(has("may be wrong")).toBe(true);
  });
});

describe("how long it is kept", () => {
  it("says nothing expires it", () => {
    expect(has("no way to delete it from inside Koqentra")).toBe(true);
    expect(has("nothing removes it after a period of time")).toBe(true);
  });

  /**
   * **The misreading worth heading off.** Somebody who deletes their workers to
   * clear their data would otherwise assume Creator went with them.
   */
  it("says deleting a worker does not delete Creator data", () => {
    expect(has("does not delete anything from Creator")).toBe(true);
  });
});

describe("promises nothing here could keep", () => {
  /**
   * Each of these describes behaviour that does not exist — in Koqentra or in
   * somebody else's service this page cannot speak for. Writing one down would
   * be worse than saying nothing.
   */
  it.each([
    "deleted immediately",
    "not used for training",
    "will be deleted after",
    "encrypted at rest",
    "data residency",
    "automatically deleted",
  ])("does not claim %o", (claim) => {
    expect(has(claim)).toBe(false);
  });
});
