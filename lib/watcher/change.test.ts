import { describe, expect, it } from "vitest";
import {
  detectWebsiteChange,
  type WebsiteBaseline,
} from "@/lib/watcher/change";
import { normalizeWebsiteContent } from "@/lib/watcher/normalize";

/**
 * Whether a page has changed, decided by comparing two values.
 *
 * **Nothing is read and nothing is written.** The baseline arrives as an
 * argument, so this cannot advance a snapshot even by accident — and it must
 * not, because a change consumed at the moment it is detected is a change the
 * reader never hears about if the work it triggers then fails.
 */

const CURRENT = normalizeWebsiteContent(
  "<html><head><title>Careers</title></head><body><p>We are hiring.</p></body></html>",
  "text/html",
);

/** A stored snapshot holding exactly what was just read. */
const MATCHING: WebsiteBaseline = {
  normalizedContent: CURRENT.normalizedContent,
  contentHash: CURRENT.contentHash,
};

describe("a page nobody has watched before", () => {
  /**
   * **Not a change.** There is nothing to have changed from, and reporting one
   * would tell a reader about an event that is really just the worker starting.
   */
  it("is initial rather than changed", () => {
    expect(detectWebsiteChange(null, CURRENT)).toEqual({ state: "initial" });
  });
});

describe("a page that is exactly as it was", () => {
  it("is unchanged", () => {
    expect(detectWebsiteChange(MATCHING, CURRENT)).toEqual({
      state: "unchanged",
    });
  });
});

describe("a page that differs", () => {
  it("is changed when the digest differs", () => {
    const baseline = { ...MATCHING, contentHash: "0".repeat(64) };

    expect(detectWebsiteChange(baseline, CURRENT)).toEqual({
      state: "changed",
    });
  });

  it("is changed when the text differs", () => {
    const before = normalizeWebsiteContent(
      "<html><head><title>Careers</title></head><body><p>Applications closed.</p></body></html>",
      "text/html",
    );

    expect(detectWebsiteChange(before, CURRENT)).toEqual({ state: "changed" });
  });

  /**
   * **The one case that decides which way the comparison fails.** A digest
   * matching text it does not describe means something is wrong — a column
   * truncated, a digest written by an older normalizer — and the answer is to
   * report a change. Somebody reads one summary they did not need; the
   * alternative is a watcher that has quietly stopped comparing the page it is
   * pointed at.
   */
  it("is changed when the digest agrees but the text does not", () => {
    const baseline: WebsiteBaseline = {
      contentHash: CURRENT.contentHash,
      normalizedContent: "something else entirely",
    };

    expect(detectWebsiteChange(baseline, CURRENT)).toEqual({
      state: "changed",
    });
  });

  it("is changed when the text agrees but the digest does not", () => {
    const baseline: WebsiteBaseline = {
      contentHash: "0".repeat(64),
      normalizedContent: CURRENT.normalizedContent,
    };

    expect(detectWebsiteChange(baseline, CURRENT)).toEqual({
      state: "changed",
    });
  });
});

describe("an empty page", () => {
  const empty = normalizeWebsiteContent(
    "<html><body></body></html>",
    "text/html",
  );

  it("compares as unchanged against an empty baseline", () => {
    expect(
      detectWebsiteChange(
        {
          normalizedContent: empty.normalizedContent,
          contentHash: empty.contentHash,
        },
        empty,
      ),
    ).toEqual({ state: "unchanged" });
  });

  /** Text appearing on a page that had none is the change that matters most. */
  it("reports text appearing where there was none", () => {
    expect(
      detectWebsiteChange(
        {
          normalizedContent: empty.normalizedContent,
          contentHash: empty.contentHash,
        },
        CURRENT,
      ),
    ).toEqual({ state: "changed" });
  });
});

describe("what comparing does not do", () => {
  it("leaves the baseline it was given untouched", () => {
    const baseline = { ...MATCHING };
    detectWebsiteChange(baseline, CURRENT);

    expect(baseline).toEqual(MATCHING);
  });

  it("gives the same answer however many times it is asked", () => {
    const answers = [1, 2, 3].map(() => detectWebsiteChange(MATCHING, CURRENT));

    expect(answers).toEqual([
      { state: "unchanged" },
      { state: "unchanged" },
      { state: "unchanged" },
    ]);
  });
});
